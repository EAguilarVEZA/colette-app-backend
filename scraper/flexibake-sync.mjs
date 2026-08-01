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
    const r = await fetch(`${BACKEND}/api/inventory-reset-zero`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
      body: JSON.stringify({ offset, limit: 40 }),
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

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // 1) Log in
    await page.goto(`${BASE}/FBWSLogon.aspx`, { waitUntil: 'networkidle' });
    const user = page.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])').first();
    await user.fill(USER);
    await page.locator('input[type="password"]').first().fill(PASS);
    await Promise.all([
      page.waitForLoadState('networkidle'),
      page.getByRole('button', { name: /login/i }).first().click().catch(() =>
        page.locator('input[type="submit"], button').filter({ hasText: /login/i }).first().click()),
    ]);
    log('Logged in as', USER);

    // 2) Orders list — broaden to This Week, then filter to today's orders
    await page.goto(`${BASE}/FBWSOrders.aspx`, { waitUntil: 'networkidle' });
    await page.getByText('This Week', { exact: false }).first().click().catch(() => {});
    await page.waitForLoadState('networkidle');

    // Collect (orderNo, orderDate) for rows dated today
    const rows = await page.locator('tr', { has: page.getByText('View', { exact: true }) }).all();
    const todays = [];
    for (const r of rows) {
      const cells = await r.locator('td').allInnerTexts();
      const orderNo = (cells[0] || '').trim();
      const orderDate = (cells[1] || '').trim();
      if (orderNo && orderDate === todayET) todays.push(orderNo);
    }
    log(`Today (${todayET}): ${todays.length} order(s) →`, todays.join(', ') || 'none');
    if (!todays.length) { log('Nothing to sync.'); await browser.close(); return; }

    // 3) Open each order and read line items
    const agg = {}; // code -> qty
    for (const orderNo of todays) {
      await page.goto(`${BASE}/FBWSOrders.aspx`, { waitUntil: 'networkidle' });
      await page.getByText('This Week', { exact: false }).first().click().catch(() => {});
      await page.waitForLoadState('networkidle');
      const rowLoc = page.locator('tr', { hasText: orderNo }).first();
      await Promise.all([ page.waitForLoadState('networkidle'), rowLoc.getByText('View', { exact: true }).click() ]);
      // read item rows: code (first cell) + quantity (first input in row)
      const itemRows = await page.locator('tr').all();
      let count = 0;
      for (const ir of itemRows) {
        const code = (await ir.locator('td').first().innerText().catch(() => '')).trim();
        if (!/^\d+$/.test(code)) continue; // code cells are numeric
        const qInput = ir.locator('input[type="text"], input:not([type])').first();
        const val = await qInput.inputValue().catch(() => '');
        const qty = parseFloat((val || '').replace(/[^0-9.]/g, ''));
        if (qty > 0) { agg[code] = (agg[code] || 0) + qty; count++; }
      }
      log(`  Order ${orderNo}: ${count} line(s)`);
    }

    const lines = Object.entries(agg).map(([code, qty]) => ({ code, qty }));
    log('Aggregated lines:', JSON.stringify(lines));
    if (!lines.length) { log('No positive quantities found.'); await browser.close(); return; }

    // 4) Push to Clover backend (it adds to stock)
    const res = await fetch(`${BACKEND}/api/inventory-receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
      body: JSON.stringify({ lines }),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) { console.error('Backend error:', JSON.stringify(out)); process.exit(1); }
    log(`Synced. Matched ${out.matched}/${out.total} items.`);
    for (const r of out.results) log('  ', r.matched ? `${r.label}: ${r.from} → ${r.to} (+${r.added})` : `UNMATCHED: ${r.label} (+${r.qty})`);
  } finally {
    await browser.close();
  }
};

const main = process.env.TASK === 'reset' ? resetZero : run;
main().catch((e) => { console.error(e); process.exit(1); });
