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
          // Default view lists ALL open orders (incl. future delivery dates); don't narrow it.
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

    // Collect ALL orders in the list with their delivery dates (advance orders too).
    const toISO = (md) => { const [m, d, y] = String(md).split('/'); return (y && m && d) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : String(md); };
    const rows = await page.locator('tr', { has: page.getByText('View', { exact: true }) }).all();
    const allOrders = [];
    for (const r of rows) {
      const cells = await r.locator('td').allInnerTexts();
      const orderNo = (cells[0] || '').trim();
      const deliveryDate = (cells[2] || '').trim();
      const status = (cells[3] || '').trim();
      if (orderNo && deliveryDate && !/void/i.test(status)) allOrders.push({ orderNo, deliveryDate });
    }
    log(`Found ${allOrders.length} order(s):`, allOrders.map((o) => `${o.orderNo}@${o.deliveryDate}`).join(', ') || 'none');

    // Reads one order table. Handles BOTH placed orders (qty as read-only text)
    // and open/advance orders (qty inside an editable <input>). Returns rows +
    // a small debug sample so a run's log reveals the layout if something's off.
    const parseOrder = () => page.evaluate(() => {
      const out = []; const all = []; const dbg = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 3) return;
        // product code = tds[0] if it's 3–7 digits, else first such cell in the row
        let code = (tds[0].innerText || '').trim();
        if (!/^\d{3,7}$/.test(code)) { code = null; for (const td of tds) { const t = (td.innerText || '').trim(); if (/^\d{3,7}$/.test(t)) { code = t; break; } } }
        if (!code) return;
        // product name = the description cell (first text cell with letters that isn't the code)
        let name = '';
        for (const td of tds) { const t = (td.innerText || '').trim(); if (t && t !== code && /[A-Za-z]{2,}/.test(t) && !/^\$/.test(t)) { name = t.replace(/\s+/g, ' '); break; } }
        all.push({ code, name }); // every product row (for the full catalog, incl. qty 0)
        // qty = any input in the row with a numeric value (property OR attribute),
        // else a small integer text cell that isn't the code.
        let qty = 0;
        for (const inp of tr.querySelectorAll('input')) {
          const v = String(inp.value || inp.getAttribute('value') || '').replace(/[^0-9.]/g, '');
          if (v && parseFloat(v) > 0) { qty = parseFloat(v); break; }
        }
        if (!qty) { for (const td of tds) { const t = (td.innerText || '').trim(); if (t !== code && /^\d{1,3}$/.test(t) && +t > 0) { qty = +t; break; } } }
        if (qty > 0) out.push({ code, name, qty });
        if (dbg.length < 4) dbg.push(((tr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)) + ' [inputs:' + tr.querySelectorAll('input').length + ']');
      });
      return { out, all, dbg };
    });

    // 3) Read EACH order and save it to the per-date Alon store, so the dashboard
    // calendar shows the REAL order Alon has for any date — including advance orders.
    const byDate = {};   // iso -> { code: {name, qty} }
    const catalog = {};  // code -> name (union of every product seen — the full Alon list)
    // Open one order (by order #) and read it, waiting for the page to settle.
    const openAndRead = async (orderNo) => {
      await openOrders();
      const rowLoc = page.locator('tr', { hasText: orderNo }).first();
      await Promise.all([ page.waitForLoadState('domcontentloaded').catch(() => {}), rowLoc.getByText('View', { exact: true }).click() ]);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // Wait until product-code rows exist AND quantities are present (text OR
      // populated inputs — open/advance orders fill their inputs via AJAX).
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('tr')];
        const hasCode = rows.some((tr) => [...tr.querySelectorAll('td')].some((td) => /^\d{3,7}$/.test((td.innerText || '').trim())));
        const hasQty = rows.some((tr) => [...tr.querySelectorAll('input')].some((i) => /\d/.test(String(i.value || i.getAttribute('value') || ''))))
          || rows.some((tr) => { const t = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim()); return t.some((x) => /^\d{3,7}$/.test(x)) && t.some((x) => /^\d{1,3}$/.test(x)); });
        return hasCode && hasQty;
      }, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      let parsed = { out: [], all: [], dbg: [] };
      for (let attempt = 0; attempt < 2; attempt++) {
        try { parsed = await parseOrder(); if (parsed.out.length) break; await page.waitForTimeout(1500); }
        catch { await page.waitForTimeout(1500); }
      }
      return parsed;
    };

    for (const o of allOrders) {
      try {
        let parsed = await openAndRead(o.orderNo);
        // Advance orders are intermittent — if empty, fully re-open once more.
        if (!parsed.out.length) { await page.waitForTimeout(1200); parsed = await openAndRead(o.orderNo); }
        const out = parsed.out;
        for (const c of (parsed.all || [])) { if (c.code && (!(c.code in catalog) || (!catalog[c.code] && c.name))) catalog[c.code] = c.name || ''; }
        const iso = toISO(o.deliveryDate);
        byDate[iso] = byDate[iso] || {};
        for (const li of out) { const e = byDate[iso][li.code] || { name: li.name || '', qty: 0 }; e.qty += li.qty; if (!e.name && li.name) e.name = li.name; byDate[iso][li.code] = e; }
        log(`  Order ${o.orderNo} (${iso}): ${out.length} line(s).` + (out.length === 0 ? ' SAMPLE ROWS: ' + JSON.stringify(parsed.dbg) : ''));
      } catch (e) { log(`  Order ${o.orderNo}: read failed —`, String(e).slice(0, 120)); }
    }
    for (const [iso, agg] of Object.entries(byDate)) {
      const lns = Object.entries(agg).map(([code, e]) => ({ code, name: e.name || '', qty: e.qty }));
      // NEVER overwrite a saved order with an empty read (advance-order reads are
      // intermittent). Only save when we actually read line items.
      if (!lns.length) { log(`Skipped ${iso} — read 0 items (keeping previous saved order).`); continue; }
      try {
        await fetch(`${BACKEND}/api/ops?action=alon-order-save`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
          body: JSON.stringify({ date: iso, lines: lns, source: 'alon' }),
        });
        log(`Saved Alon order for ${iso} → dashboard (${lns.length} items).`);
      } catch (e) { log('Could not save Alon order for', iso, String(e)); }
    }

    // Reconcile DELETIONS: clear any stored future date that no longer has an
    // open order on Alon (so deleting/voiding an order on Alon removes it here).
    try {
      const openIso = new Set(allOrders.map((o) => toISO(o.deliveryDate)));
      const todayIsoStr = new Date().toISOString().slice(0, 10);
      const windowEnd = Date.now() + 45 * 86400000;
      const dd = await fetch(`${BACKEND}/api/ops?action=alon-order-dates`).then((x) => x.json()).catch(() => ({}));
      for (const rec of (dd.dates || [])) {
        const d = rec.date;
        const dMs = new Date(d + 'T12:00:00').getTime();
        if (d >= todayIsoStr && dMs <= windowEnd && !openIso.has(d) && (rec.count || 0) > 0) {
          await fetch(`${BACKEND}/api/ops?action=alon-order-save`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
            body: JSON.stringify({ date: d, lines: [], source: 'alon' }),
          });
          log(`Reconciled: cleared ${d} — no open order on Alon anymore.`);
        }
      }
    } catch (e) { log('Reconcile deletions failed:', String(e).slice(0, 120)); }

    // Save the full Alon product catalog (union of every product seen) so the
    // dashboard can offer the ENTIRE list to order, not just curated items.
    const catList = Object.entries(catalog).map(([code, name]) => ({ code, name }));
    if (catList.length) {
      try {
        await fetch(`${BACKEND}/api/ops?action=alon-catalog-save`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
          body: JSON.stringify({ lines: catList }),
        });
        log(`Saved Alon catalog: ${catList.length} products.`);
      } catch (e) { log('Could not save Alon catalog:', String(e)); }
    }

    // Today's delivery lines drive the Clover inventory sync.
    const isoDate = toISO(targetDate);
    const todayLines = Object.entries(byDate[isoDate] || {}).map(([code, e]) => ({ code, qty: e.qty }));
    log('Today delivery', isoDate, '→', JSON.stringify(todayLines));

    // Fresh-day policy: zero EVERYTHING first, then load ONLY today's delivery.
    // Done here (after reading Alon so a login failure never wipes stock) — the
    // window where stock is 0 is just the moment between reset and receive.
    log('Zeroing all Clover stock before loading today’s numbers…');
    await resetZero();

    if (!todayLines.length) { log('No delivery today — inventory left at zero.'); await browser.close(); return; }

    // 4) Push to Clover backend. Stock was just zeroed, so add == set to today's qty.
    const res = await fetch(`${BACKEND}/api/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
      body: JSON.stringify({ action: 'inventory-receive', lines: todayLines }),
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
  const D = (...a) => log('[place]', ...a);
  try {
    // ---- Login ----
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

    const target = placeTarget();
    const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const mdy = `${target.getMonth() + 1}/${target.getDate()}/${target.getFullYear()}`;
    D('Target delivery:', iso, `(${mdy})`, '· mode:', PLACE_MODE);

    // Desired quantities: ORDER env or smart recommendation.
    let lines = [];
    if ((process.env.ORDER || '').trim()) { try { lines = JSON.parse(process.env.ORDER); } catch { D('Bad ORDER JSON'); } }
    if (!lines.length) {
      const r = await fetch(`${BACKEND}/api/ops?action=reorder-plan&dow=${target.getDay()}`).then((x) => x.json()).catch(() => ({}));
      lines = (r.items || []).map((i) => ({ code: i.code, qty: i.suggested }));
    }
    lines = lines.filter((l) => Number(l.qty) > 0);
    if (!lines.length) { D('No quantities to place — aborting.'); await browser.close(); return; }
    const want = {}; for (const l of lines) want[String(l.code)] = Number(l.qty);
    D('Desired:', JSON.stringify(want));

    // ---- Is there already an OPEN order for this delivery date? ----
    await page.goto(`${BASE}/FBWSOrders.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const opened = await page.evaluate((mdyDate) => {
      for (const tr of document.querySelectorAll('tr')) {
        const t = (tr.innerText || '').replace(/\s+/g, ' ');
        if (t.includes(mdyDate) && /open/i.test(t)) {
          const v = [...tr.querySelectorAll('a')].find((a) => /view/i.test(a.innerText || ''));
          if (v) { v.click(); return true; }
        }
      }
      return false;
    }, mdy);

    let editing = false;
    if (opened) {
      editing = true;
      D('Existing OPEN order found for', mdy, '— editing it (View).');
      await page.waitForURL('**/FBWSOpenOrder.aspx', { timeout: 20000 }).catch(() => {});
    } else {
      D('No existing order — creating a NEW one.');
      await page.goto(`${BASE}/FBWSMain.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000);
      await page.locator('a[href*="LNK_CURRENT_ORDER"]').first().click()
        .catch(async () => { await page.getByText(/enter new order/i).first().click(); });
      await page.waitForURL('**/FBWSDeliveryDate.aspx', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1000);
      await page.locator('#_ctl0_ContentPlaceHolder1_EF_DEL_DATE').fill(iso)
        .catch(async () => { await page.locator('input[type="date"]').first().fill(iso); });
      await page.waitForTimeout(400);
      // "Next" needs up to two clicks to advance to the order form.
      for (let i = 0; i < 4 && !/FBWSOpenOrder/.test(page.url()); i++) {
        await page.locator('#_ctl0_ContentPlaceHolder1_PB_NEXT').first().click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1600);
      }
    }

    await page.waitForURL('**/FBWSOpenOrder.aspx', { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(
      () => [...document.querySelectorAll('td')].some((td) => /^\d{3,}$/.test((td.innerText || '').trim())),
      { timeout: 20000 },
    ).catch(() => {});
    await page.waitForTimeout(1000);

    // ---- Fill quantities for codes present in the grid ----
    const fillGrid = () => page.evaluate((w) => {
      const done = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const tds = tr.querySelectorAll('td'); if (!tds.length) return;
        const code = (tds[0].innerText || '').trim(); if (!(code in w)) return;
        const q = tr.querySelector('input[id$="TXT_QTY"]');
        if (q) { q.value = String(w[code]); q.dispatchEvent(new Event('input', { bubbles: true })); q.dispatchEvent(new Event('change', { bubbles: true })); q.dispatchEvent(new Event('blur', { bubbles: true })); done.push(code + ':' + w[code]); }
      });
      return done;
    }, want);

    let filled = await fillGrid();
    D('Filled in grid:', JSON.stringify(filled));

    // ---- Add any desired items NOT already in the grid via "Other Products" ----
    const presentCodes = await page.evaluate(() => {
      const s = [];
      document.querySelectorAll('tr').forEach((tr) => { const c = (tr.querySelector('td') || {}).innerText; if (c && /^\d{3,}$/.test(c.trim())) s.push(c.trim()); });
      return s;
    });
    let missing = Object.keys(want).filter((c) => !presentCodes.includes(c));
    if (missing.length) {
      D('Not in grid — adding via Other Products:', JSON.stringify(missing));
      await page.locator('#PB_ADD_PRODUCTS').first().click().catch(() => {});
      await page.waitForTimeout(1500);
      let cats = await page.$$eval('#_ctl0_ContentPlaceHolder1_CB_CATEGORY option', (os) => os.map((o) => o.value).filter((v) => v && v !== '0')).catch(() => []);
      for (const cv of cats) {
        if (!missing.length) break;
        await page.selectOption('#_ctl0_ContentPlaceHolder1_CB_CATEGORY', cv).catch(() => {});
        await page.waitForTimeout(1600);
        const addedNow = await page.evaluate((w) => {
          const done = [];
          document.querySelectorAll('tr').forEach((tr) => {
            const tds = tr.querySelectorAll('td'); if (!tds.length) return;
            const code = (tds[0].innerText || '').trim(); if (!(code in w)) return;
            const q = tr.querySelector('input[id$="TXT_QTY"]');
            if (q) { q.value = String(w[code]); q.dispatchEvent(new Event('input', { bubbles: true })); q.dispatchEvent(new Event('change', { bubbles: true })); q.dispatchEvent(new Event('blur', { bubbles: true })); done.push(code); }
          });
          return done;
        }, want);
        if (addedNow.length) {
          await page.locator('#_ctl0_ContentPlaceHolder1_PB_SAVE').first().click().catch(() => {}); // "Add to Order"
          await page.waitForURL('**/FBWSOpenOrder.aspx', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1500);
          missing = missing.filter((c) => !addedNow.includes(c));
          D('Added via category', cv, ':', JSON.stringify(addedNow), '· remaining missing:', JSON.stringify(missing));
        }
      }
      await page.waitForTimeout(500);
      filled = await fillGrid();
      D('Re-filled grid after adds:', JSON.stringify(filled));
    }

    await page.screenshot({ path: 'order-filled.png', fullPage: true }).catch(() => {});
    if (PLACE_MODE === 'dryrun') { D('DRYRUN — filled only. Nothing submitted.'); await browser.close(); return; }

    // ---- Review Order (it is a <span> #reviewBtn, NOT a link/button) ----
    await page.locator('#_ctl0_ContentPlaceHolder1_reviewBtn').click({ timeout: 10000 })
      .catch(async () => { await page.locator('span:has-text("Review Order")').first().click().catch(() => {}); });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'order-review.png', fullPage: true }).catch(() => {});
    D('Clicked Review.');

    if (PLACE_MODE !== 'submit') { D('REVIEW mode — holding before final submit.'); await browser.close(); return; }

    // ---- Submit (new) or Update (existing) — whichever button Review revealed ----
    const submitId = await page.evaluate(() => {
      for (const id of ['_ctl0_ContentPlaceHolder1_PB_SAVE3', '_ctl0_ContentPlaceHolder1_PB_UPDATE3']) {
        const e = document.getElementById(id);
        if (e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0) return id;
      }
      return null;
    });
    if (!submitId) { D('WARNING: no visible Submit/Update after Review — NOT submitted.'); await page.screenshot({ path: 'order-nosubmit.png', fullPage: true }).catch(() => {}); await browser.close(); return; }
    await page.locator('#' + submitId).click().catch(() => {});
    await page.waitForURL('**/FBWSConfirmOrder.aspx', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'order-submitted.png', fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    const ok = /FBWSConfirmOrder/.test(page.url()) || /Order Saved|changes made to your order|Thank you for your order/i.test(html);
    if (ok) D(`SUBMITTED ${editing ? 'UPDATE' : 'NEW'} order for ${iso} via ${submitId} — confirmation reached (Order Saved).`);
    else D(`WARNING: clicked ${submitId} but did NOT reach confirmation for ${iso}. url=${page.url()}`);
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

// Harvest the FULL Alon product catalog (every item's code, description, price)
// from the order form, so the dashboard can offer the entire list to build a new
// order. Opens an existing order in EDIT mode (shows all products) and reads it —
// nothing is submitted. Trigger with "Run workflow" → task=catalog.
const harvestCatalog = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
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
    log('Logged in as', USER, '· harvesting full catalog');

    // Open the delivery-date list and EDIT the first order to reach the full form.
    await page.goto(`${BASE}/FBWSDeliveryDate.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      for (const tr of document.querySelectorAll('tr')) {
        const link = tr.querySelector('a[href*="__doPostBack"]');
        if (link) { const mm = link.getAttribute('href').match(/__doPostBack\('([^']+)'/); if (mm) { __doPostBack(mm[1], ''); return; } }
      }
    });
    await page.waitForURL('**/FBWSOpenOrder.aspx', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForFunction(() => [...document.querySelectorAll('td')].some((td) => /^\d{3,7}$/.test((td.innerText || '').trim())), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const cat = await page.evaluate(() => {
      const out = []; const dbg = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const tds = tr.querySelectorAll('td'); if (tds.length < 3) return;
        let code = (tds[0].innerText || '').trim();
        if (!/^\d{3,7}$/.test(code)) { code = null; for (const td of tds) { const t = (td.innerText || '').trim(); if (/^\d{3,7}$/.test(t)) { code = t; break; } } }
        if (!code) return;
        let name = ''; for (const td of tds) { const t = (td.innerText || '').trim(); if (t && t !== code && /[A-Za-z]{2,}/.test(t) && !/^\$/.test(t)) { name = t.replace(/\s+/g, ' '); break; } }
        let price = 0; for (const td of tds) { const m = (td.innerText || '').trim().match(/\$?\s*(\d+\.\d{2})\b/); if (m) { price = parseFloat(m[1]); break; } }
        out.push({ code, name, price });
        if (dbg.length < 6) dbg.push((tr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140));
      });
      return { out, dbg };
    });
    log(`Catalog rows read: ${cat.out.length}. sample:`, JSON.stringify(cat.dbg));
    if (cat.out.length) {
      const r = await fetch(`${BACKEND}/api/ops?action=alon-catalog-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-colette-secret': SECRET },
        body: JSON.stringify({ lines: cat.out, replace: true }),
      });
      const j = await r.json().catch(() => ({}));
      log(`Saved full Alon catalog: ${j.count || cat.out.length} products.`);
    } else {
      log('No catalog rows found — order form layout may differ (see sample above).');
    }
  } finally { await browser.close(); }
};

const main = process.env.TASK === 'catalog' ? harvestCatalog
  : process.env.TASK === 'reset' ? resetZero
  : process.env.TASK === 'setcosts' ? setCosts
  : process.env.TASK === 'place' ? placeOrder
  : process.env.TASK === 'warm' ? warm
  : run;
main().catch((e) => { console.error(e); process.exit(1); });
