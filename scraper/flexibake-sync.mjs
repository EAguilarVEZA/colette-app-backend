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
    if (!todays.length) {
      // Fresh-day policy: start every day at zero. No delivery today → leave everything at 0.
      log('No delivery for that date — zeroing all inventory for a clean start.');
      await resetZero();
      await browser.close();
      return;
    }

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

    // Save the REAL Alon order for this delivery date so the dashboard calendar
    // shows exactly what's in FlexiBake (source='alon'). Date as ISO YYYY-MM-DD.
    const isoDate = (() => { const [m, d, y] = targetDate.split('/'); return y && m && d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : targetDate; })();
    try {
      await fetch(`${BACKEND}/api/ops?action=alon-order-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
        body: JSON.stringify({ date: isoDate, lines, source: 'alon' }),
      });
      log('Saved Alon order for', isoDate, '→ dashboard calendar.');
    } catch (e) { log('Could not save Alon order snapshot:', String(e)); }

    // Fresh-day policy: zero EVERYTHING first, then load ONLY today's delivery.
    // Done here (after reading Alon so a login failure never wipes stock) — the
    // window where stock is 0 is just the moment between reset and receive.
    log('Zeroing all Clover stock before loading today’s numbers…');
    await resetZero();

    if (!lines.length) { log('No positive quantities found — inventory left at zero for today.'); await browser.close(); return; }

    // 4) Push to Clover backend. Stock was just zeroed, so add == set to today's qty.
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

// ---- Order PLACEMENT into Alon's (safe by default) ----
// PLACE_MODE: 'dryrun' (fill only) | 'review' (fill + go to Review page, HOLD — nothing
// submitted) | 'submit' (fill + Review + final submit). Default = review.
// Quantities come from ORDER env (JSON [{code,qty}]) or, if empty, the smart
// reorder recommendation for the target weekday. Target delivery date = PLACE_DATE
// (M/D/YYYY or ISO) or today ET + 2 days (skipping Monday, which is closed).
const PLACE_MODE = (process.env.PLACE_MODE || 'review').toLowerCase();
const placeTarget = () => {
  const raw = (process.env.PLACE_DATE || '').trim();
  if (raw) return new Date(raw.includes('-') ? raw : raw);
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  let d = new Date(et.getTime() + 2 * 86400000);
  if (d.getDay() === 1) d = new Date(et.getTime() + 3 * 86400000); // skip Monday (closed)
  return d;
};

const placeOrder = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // Login (same flow as the sync job)
    await page.goto(`${BASE}/FBWSLogon.aspx`, { waitUntil: 'networkidle' });
    await page.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])').first().fill(USER);
    await page.locator('input[type="password"]').first().fill(PASS);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator('[id$="PB_EXIST_LOGON"]').first().click({ timeout: 15000 })
        .catch(async () => { await page.getByRole('link', { name: 'Login', exact: true }).first().click(); }),
    ]);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    log('Logged in as', USER, '· PLACE_MODE:', PLACE_MODE);

    const target = placeTarget();
    const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    log('Target delivery date:', iso, `(${target.toDateString()})`);

    // Quantities: ORDER env or smart recommendation for that weekday.
    let lines = [];
    if ((process.env.ORDER || '').trim()) { try { lines = JSON.parse(process.env.ORDER); } catch { log('Bad ORDER JSON'); } }
    if (!lines.length) {
      const r = await fetch(`${BACKEND}/api/ops?action=reorder-plan&dow=${target.getDay()}`).then((x) => x.json()).catch(() => ({}));
      lines = (r.items || []).map((i) => ({ code: i.code, qty: i.suggested })).filter((l) => l.qty > 0);
      log('Using smart recommendation:', JSON.stringify(lines));
    }
    if (!lines.length) { log('No quantities to place — aborting.'); await browser.close(); return; }

    // Delivery-date page: edit an existing order for that date if one exists, else create.
    await page.goto(`${BASE}/FBWSDeliveryDate.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    const opened = await page.evaluate((isoDate) => {
      const td = new Date(isoDate).toDateString();
      for (const tr of document.querySelectorAll('tr')) {
        const m = (tr.innerText || '').match(/[A-Za-z]{3}\.?\s+[A-Za-z]{3}\.?\s+\d{1,2},\s+\d{4}/);
        if (m) {
          const d = new Date(m[0].replace(/\./g, ''));
          if (!isNaN(d) && d.toDateString() === td) {
            const link = tr.querySelector('a[href*="__doPostBack"]');
            const mm = link && link.getAttribute('href').match(/__doPostBack\('([^']+)'/);
            if (mm) { __doPostBack(mm[1], ''); return 'edit'; }
          }
        }
      }
      return null;
    }, iso);

    if (opened === 'edit') {
      log('Editing existing order for', iso);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1800);
    } else {
      log('Creating new order for', iso);
      await page.locator('input[type="date"]').first().fill(iso).catch(() => {});
      await page.waitForTimeout(400);
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        (async () => {
          try { await page.getByRole('link', { name: 'Next', exact: true }).first().click({ timeout: 8000 }); }
          catch { await page.locator('[id$="PB_NEXT"]').first().click().catch(() => {}); }
        })(),
      ]);
      await page.waitForTimeout(1800);
    }

    // Wait for the order form to fully load (ASP.NET postbacks navigate async) —
    // don't touch the page until a product-code row is present.
    await page.waitForURL('**/FBWSOpenOrder.aspx', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForFunction(
      () => [...document.querySelectorAll('td')].some((td) => /^\d{3,}$/.test((td.innerText || '').trim())),
      { timeout: 20000 },
    ).catch(() => {});
    await page.waitForTimeout(1000);

    // Fill the QUANTITY input (4th cell) for each matching product code.
    const filled = await page.evaluate((lines) => {
      const byCode = {}; for (const l of lines) byCode[String(l.code)] = l.qty;
      const done = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const tds = tr.querySelectorAll('td'); if (tds.length < 4) return;
        const code = (tds[0].innerText || '').trim(); if (!/^\d+$/.test(code) || !(code in byCode)) return;
        const inp = tds[3].querySelector('input') || tr.querySelectorAll('input')[1];
        if (inp) { inp.value = String(byCode[code]); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); done.push(`${code}:${byCode[code]}`); }
      });
      return done;
    }, lines);
    log(`Filled ${filled.length} lines:`, JSON.stringify(filled));
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'order-filled.png', fullPage: true }).catch(() => {});

    if (PLACE_MODE === 'dryrun') { log('DRYRUN — filled only. Nothing reviewed or submitted.'); await browser.close(); return; }

    // Review Order (navigates to the review page; does NOT finalize)
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      (async () => {
        try { await page.getByRole('link', { name: /review order/i }).first().click({ timeout: 8000 }); }
        catch { await page.locator('[id*="REVIEW"]').first().click().catch(() => {}); }
      })(),
    ]);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: 'order-review.png', fullPage: true }).catch(() => {});
    log('Reached Review page (screenshot saved).');

    if (PLACE_MODE !== 'submit') { log('REVIEW mode — HOLDING before final submit. Nothing was submitted.'); await browser.close(); return; }

    // Final submit — ONLY in submit mode
    try { await page.getByRole('link', { name: /submit|place order|confirm|save/i }).first().click({ timeout: 8000 }); }
    catch { await page.locator('[id*="SUBMIT"],[id*="CONFIRM"],[id*="SAVE"]').first().click().catch(() => {}); }
    await page.waitForTimeout(1800);
    await page.screenshot({ path: 'order-submitted.png', fullPage: true }).catch(() => {});
    log('SUBMITTED order for', iso);
  } finally {
    await browser.close();
  }
};

// Warm the edge cache each morning so the dashboard opens instantly (the heavy
// reorder + stockout queries are precomputed and cached ~20h). No Alon/Clover
// login needed — just HTTP GETs against the backend.
const warm = async () => {
  const dows = [0, 2, 3, 4, 5, 6]; // skip Monday (closed)
  for (const d of dows) {
    const t0 = Date.now();
    const r = await fetch(`${BACKEND}/api/ops?action=reorder-plan&dow=${d}`);
    log(`warmed reorder dow=${d}: ${r.status} (${Date.now() - t0}ms)`);
  }
  const t1 = Date.now();
  const s = await fetch(`${BACKEND}/api/ops?action=stockout&days=90`);
  log(`warmed stockout: ${s.status} (${Date.now() - t1}ms)`);
  const t2 = Date.now();
  const m = await fetch(`${BACKEND}/api/ops?action=metrics&days=35`);
  log(`warmed metrics: ${m.status} (${Date.now() - t2}ms)`);
  log('Cache warm complete.');
};

const main = process.env.TASK === 'reset' ? resetZero
  : process.env.TASK === 'setcosts' ? setCosts
  : process.env.TASK === 'place' ? placeOrder
  : process.env.TASK === 'warm' ? warm
  : run;
main().catch((e) => { console.error(e); process.exit(1); });
