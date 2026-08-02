// flexibake-sync.mjs — daily job (runs in GitHub Actions).
// Logs into Alon's FlexiBake, reads TODAY's orders, and pushes the ordered
// quantities to the Clover backend, which adds them to inventory.
//
// Env (GitHub Action secrets): FLEXIBAKE_USER, FLEXIBAKE_PASS, BACKEND_URL, SYNC_SECRET
// Credentials are read from the environment — never hard-coded.
import { chromium } from 'playwright';

const USER = process.env.FLEXIBAKE_USER;
const PASS = process.env.FLEXIBAKE_PASS;
const BACKEND = (process.env.BACKEND_URL || 'https://colette-app-backend.vercel.app').replace(/\/$/, '');
const SECRET = process.env.SYNC_SECRET;
const BASE = 'https://alons.flexibakeonline.com';

if (!USER || !PASS || !SECRET) { console.error('Missing FLEXIBAKE_USER / FLEXIBAKE_PASS / SYNC_SECRET'); process.exit(1); }

const todayET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric' }).format(new Date());
const log = (...a) => console.log(...a);

// One-time: zero every Clover item's stock (fixes the negative counts) before
// we start receiving. Trigger via the "Run workflow" button with task=reset.
const resetZero = async () => {
  let offset = 0, total = 0;
  for (;;) {
    const r = await fetch(`${BACKEND}/api/ops`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
      body: JSON.stringify({ action: 'inventory-reset-zero', offset, limit: 40 }),
    });
    const out = await r.json();
    if (!r.ok || !out.ok) { console.error('Reset error:', JSON.stringify(out)); process.exit(1); }
    total += out.processed;
    log(`Zeroed ${total}/${out.total}`);
    if (out.done || out.nextOffset == null) break;
    offset = out.nextOffset;
  }
  log('Inventory reset complete — all items set to 0.');
};

// One-time (or occasional): write Alon wholesale unit costs into Clover item.cost.
// Trigger via "Run workflow" with task=setcosts.
const setCosts = async () => {
  const r = await fetch(`${BACKEND}/api/ops`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
    body: JSON.stringify({ action: 'set-costs' }),
  });
  const out = await r.json();
  if (!r.ok || !out.ok) { console.error('Set-costs error:', JSON.stringify(out)); process.exit(1); }
  log(`Costs written to Clover: matched ${out.matched}/${out.total}`);
  for (const x of out.results) log('  ', x.matched ? `${x.name}: ${x.costCents}¢` : `UNMATCHED: ${x.name}`);
};

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // 1) Log in
    await page.goto(`${BASE}/FBWSLogon.aspx`, { waitUntil: 'networkidle' });
    const user = page.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])').first();
    await user.fill(USER);
    await page.locator('input[type="password"]').first().fill(PASS);
    // Alon's "Login" is an <a> link (id ends with PB_EXIST_LOGON) that fires __doPostBack.
    const loginLink = page.locator('[id$="PB_EXIST_LOGON"]').first();
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      loginLink.click({ timeout: 15000 }).catch(async () => {
        await page.getByRole('link', { name: 'Login', exact: true }).first().click();
      }),
    ]);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500); // let the post-login redirect settle
    log('Logged in as', USER);

    // Robust open of the orders list — ASP.NET pages abort on 'networkidle',
    // and the post-login redirect can collide with navigation, so retry.
    const openOrders = async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await page.goto(`${BASE}/FBWSOrders.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.getByText('This Month', { exact: false }).first().click().catch(() => {});
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(1000);
          return;
        } catch { await page.waitForTimeout(2000); }
      }
      throw new Error('Could not open FBWSOrders.aspx');
    };

    // 2) Orders list — match orders by DELIVERY DATE (goods received that day
    // go into stock). Override with SYNC_DATE (M/D/YYYY) for a specific day.
    const targetDate = (process.env.SYNC_DATE || '').trim() || todayET;
    await openOrders();

    // Collect orders whose DELIVERY date == targetDate
    const rows = await page.locator('tr', { has: page.getByText('View', { exact: true }) }).all();
    const todays = [];
    for (const r of rows) {
      const cells = await r.locator('td').allInnerTexts();
      const orderNo = (cells[0] || '').trim();
      const deliveryDate = (cells[2] || '').trim();
      if (orderNo && deliveryDate === targetDate) todays.push(orderNo);
    }
    log(`Delivery ${targetDate}: ${todays.length} order(s) →`, todays.join(', ') || 'none');
    if (!todays.length) { log('Nothing to sync for that delivery date.'); await browser.close(); return; }

    // 3) Open each order and read line items
    const agg = {}; // code -> qty
    for (const orderNo of todays) {
      await openOrders();
      const rowLoc = page.locator('tr', { hasText: orderNo }).first();
      await Promise.all([ page.waitForLoadState('domcontentloaded').catch(() => {}), rowLoc.getByText('View', { exact: true }).click() ]);
      await page.waitForTimeout(1500);
      // Read the whole order table in ONE browser call. Handles both editable
      // (open order: qty in an <input>) and read-only (placed order: qty as text).
      const parsed = await page.evaluate(() => {
        const out = []; const dbg = [];
        document.querySelectorAll('tr').forEach((tr) => {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 3) return;
          const code = (tds[0].innerText || '').trim();
          if (!/^\d+$/.test(code)) return; // first cell = numeric product code
          let qty = 0;
          const inp = tr.querySelector('input');
          if (inp && /\d/.test(inp.value || '')) qty = parseFloat(String(inp.value).replace(/[^0-9.]/g, ''));
          if (!qty) { // else: first integer-only cell after the code (price/total have decimals)
            for (let i = 1; i < tds.length; i++) { const t = (tds[i].innerText || '').trim(); if (/^\d+$/.test(t)) { qty = parseInt(t, 10); break; } }
          }
          if (qty > 0) out.push({ code, qty });
          if (dbg.length < 3) dbg.push((tr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120));
        });
        return { out, dbg };
      });
      for (const li of parsed.out) agg[li.code] = (agg[li.code] || 0) + li.qty;
      log(`  Order ${orderNo}: ${parsed.out.length} line(s). sample rows:`, JSON.stringify(parsed.dbg));
    }

    const lines = Object.entries(agg).map(([code, qty]) => ({ code, qty }));
    log('Aggregated lines:', JSON.stringify(lines));
    if (!lines.length) { log('No positive quantities found.'); await browser.close(); return; }

    // 4) Push to Clover backend (it adds to stock)
    const res = await fetch(`${BACKEND}/api/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
      body: JSON.stringify({ action: 'inventory-receive', lines }),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) { console.error('Backend error:', JSON.stringify(out)); process.exit(1); }
    log(`Synced. Matched ${out.matched}/${out.total} items.`);
    for (const r of out.results) log('  ', r.matched ? `${r.label}: ${r.from} → ${r.to} (+${r.added})` : `UNMATCHED: ${r.label} (+${r.qty})`);
  } finally {
    await browser.close();
  }
};

const main = process.env.TASK === 'reset' ? resetZero
  : process.env.TASK === 'setcosts' ? setCosts
  : run;
main().catch((e) => { console.error(e); process.exit(1); });
