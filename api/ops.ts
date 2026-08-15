// /api/ops — one function for the admin/automation actions (keeps us under
// Vercel's function limit). Select with ?action= (GET) or body.action (POST).
//   GET  ?action=reorder-suggest[&days=30&leadDays=3]     (open)
//   GET  ?action=customers-export                         (secret)
//   POST {action:'inventory-receive', lines:[...] }       (secret)
//   POST {action:'inventory-reset-zero', offset?, limit?} (secret)
// Protected actions require header x-colette-secret === SYNC_SECRET.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  applyCors, assertConfigured, fail,
  suggestReorder, suggestReorderSmart, getAllCustomers, receiveStock, resetStockZero, salesSummary, setItemCosts, setItemPrices, stockoutAnalysis, getRecentOrders, notifyCustomer,
  employeeForPin, employeeForPinAsync, getTeam, saveTeam, buildOrderLink, savePendingOrder, listPendingOrders, resolvePendingOrder, notifyOwner,
  togglePunch, clockStatus, listPunches,
  getShifts, saveShifts, listTimeOff, addTimeOff, resolveTimeOff,
  getAlonOrders, saveAlonOrder, getAlonCatalog, saveAlonCatalog,
} from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const action = (req.query.action as string) || body?.action || '';
  const secret = process.env.SYNC_SECRET;
  const authed = !!secret && (req.headers['x-colette-secret'] as string) === secret;
  const requireAuth = () => {
    if (!secret) { fail(res, 503, 'SYNC_SECRET not configured'); return false; }
    if (!authed) { fail(res, 401, 'Unauthorized'); return false; }
    return true;
  };

  try {
    switch (action) {
      case 'reorder-suggest': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const days = Math.min(Number(req.query.days) || 365, 400);
        // dow: 0=Sun..6=Sat; omit to use today (ET).
        const dow = req.query.dow !== undefined ? Number(req.query.dow) : undefined;
        return res.status(200).json({ ok: true, ...(await suggestReorder({ days, dow })) });
      }
      case 'reorder-plan': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const days = Math.min(Number(req.query.days) || 365, 400);
        const dow = req.query.dow !== undefined ? Number(req.query.dow) : undefined;
        const buffer = req.query.buffer !== undefined ? Number(req.query.buffer) : undefined;
        // Heavy (full-year pull): cache at the edge for 6h so only the first call/day is slow.
        res.setHeader('Cache-Control', 's-maxage=72000, stale-while-revalidate=86400');
        return res.status(200).json({ ok: true, ...(await suggestReorderSmart({ days, dow, buffer })) });
      }
      case 'stockout': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const days = Math.min(Number(req.query.days) || 120, 365);
        const gap = req.query.gap !== undefined ? Number(req.query.gap) : undefined;
        res.setHeader('Cache-Control', 's-maxage=72000, stale-while-revalidate=86400');
        return res.status(200).json({ ok: true, ...(await stockoutAnalysis({ days, gapMinutes: gap })) });
      }
      case 'metrics': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const days = Math.min(Number(req.query.days) || 35, 90);
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
        return res.status(200).json({ ok: true, ...(await salesSummary({ days })) });
      }
      case 'place-order': {
        // Approve + place the Alon order. When a GitHub dispatch token is set,
        // this triggers the FlexiBake placement workflow with the approved lines;
        // until the new-order automation is switched on it records the approval.
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const lines = body?.lines;
        const targetDay = body?.targetDay || '';
        // Use the exact ISO delivery date (targetDate) for the workflow — the weekday
        // name alone (targetDay) can't be parsed and would fall back to the wrong day.
        const targetDate = body?.targetDate || targetDay || '';
        // "Approve & Place" is an explicit approval → actually submit to Alon by default.
        // Callers can pass place_mode:'review' or 'dryrun' to hold before submit.
        const placeMode = String(body?.place_mode || 'submit');
        if (!Array.isArray(lines) || !lines.length) return fail(res, 400, 'lines[] required');
        const token = process.env.GH_DISPATCH_TOKEN;
        const repo = process.env.GH_REPO || 'EAguilarVEZA/colette-app-backend';
        if (token) {
          const gh = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/flexibake-sync.yml/dispatches`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'colette-dashboard' },
            body: JSON.stringify({ ref: 'main', inputs: { task: 'place', order: JSON.stringify(lines).slice(0, 60000), date: targetDate, place_mode: placeMode } }),
          });
          if (gh.status === 204) return res.status(200).json({ ok: true, placed: true, dispatched: true, targetDay, targetDate, place_mode: placeMode, lines });
          const detail = await gh.text();
          return fail(res, 502, 'Dispatch failed', detail);
        }
        // Not yet wired to auto-place — record the approval so the UI can confirm.
        return res.status(200).json({ ok: true, placed: false, dispatched: false, targetDay, lines,
          note: 'Approval recorded. Auto-submit to Alon activates after the new-order recon + placement step.' });
      }
      case 'run-task': {
        // On-demand trigger for the FlexiBake GitHub workflow (sync / reset).
        // Used by the dashboard "Sync now" button. Secret-gated; needs GH_DISPATCH_TOKEN.
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const task = String(body?.task || 'sync').toLowerCase();
        if (!['sync', 'reset', 'setcosts'].includes(task)) return fail(res, 400, 'task must be sync | reset | setcosts');
        const token = process.env.GH_DISPATCH_TOKEN;
        const repo = process.env.GH_REPO || 'EAguilarVEZA/colette-app-backend';
        if (!token) {
          return res.status(200).json({ ok: true, dispatched: false,
            note: 'On-demand trigger needs GH_DISPATCH_TOKEN set in Vercel. Until then, the daily schedule still runs automatically.' });
        }
        const gh = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/flexibake-sync.yml/dispatches`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'colette-dashboard' },
          body: JSON.stringify({ ref: 'main', inputs: { task, date: String(body?.date || '') } }),
        });
        if (gh.status === 204) return res.status(200).json({ ok: true, dispatched: true, task });
        const detail = await gh.text();
        return fail(res, 502, 'Dispatch failed', detail);
      }
      case 'commit-file': {
        // Self-deploy: commit a file to GitHub (which auto-redeploys Vercel), so
        // updates don't need a manual upload. Secret-gated. Uses a token kept in
        // Vercel env (GH_COMMIT_TOKEN, fallback GH_DISPATCH_TOKEN) — never exposed.
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const token = process.env.GH_COMMIT_TOKEN || process.env.GH_DISPATCH_TOKEN;
        if (!token) return fail(res, 503, 'GH_COMMIT_TOKEN not set in Vercel');
        const repos: Record<string, string> = { website: 'EAguilarVEZA/colette-website', backend: 'EAguilarVEZA/colette-app-backend' };
        const repo = repos[String(body?.repo || '')];
        if (!repo) return fail(res, 400, 'repo must be "website" or "backend"');
        const path = String(body?.path || '').replace(/^\/+/, '');
        if (!path) return fail(res, 400, 'path required');
        const content = String(body?.content ?? '');
        const message = String(body?.message || ('Update ' + path));
        const api = `https://api.github.com/repos/${repo}/contents/${path}`;
        const H: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'colette-deployer', 'Content-Type': 'application/json' };
        let sha: string | undefined;
        try { const g = await fetch(`${api}?ref=main`, { headers: H }); if (g.ok) { const j: any = await g.json(); sha = j.sha; } } catch { /* new file */ }
        const put = await fetch(api, { method: 'PUT', headers: H, body: JSON.stringify({ message, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'main', ...(sha ? { sha } : {}) }) });
        const pj: any = await put.json().catch(() => ({}));
        if (!put.ok) return fail(res, 502, 'Commit failed', pj?.message || pj);
        return res.status(200).json({ ok: true, repo, path, commit: pj?.commit?.sha || null });
      }
      case 'alon-catalog-get': {
        // Full Alon product list for the dashboard order table.
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
        return res.status(200).json({ ok: true, catalog: await getAlonCatalog() });
      }
      case 'alon-catalog-save': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const lines = Array.isArray(body?.lines) ? body.lines : [];
        const count = await saveAlonCatalog(lines, body?.replace === true);
        return res.status(200).json({ ok: true, count });
      }
      case 'alon-order-dates': {
        // Which delivery dates have a stored Alon order (for calendar markers).
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const all = await getAlonOrders();
        const dates = Object.keys(all).map((d) => ({ date: d, count: (all[d]?.lines || []).length, source: all[d]?.source || 'alon' }));
        return res.status(200).json({ ok: true, dates });
      }
      case 'alon-order-get': {
        // The real Alon order for one delivery date: ?date=YYYY-MM-DD.
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const date = String(req.query.date || '').trim();
        if (!date) return fail(res, 400, 'date required (YYYY-MM-DD)');
        const all = await getAlonOrders();
        const o = all[date] || { lines: [], at: null, source: null };
        return res.status(200).json({ ok: true, date, order: o });
      }
      case 'alon-order-save': {
        // Save/replace the order for a delivery date. Admin secret (also used by
        // the scraper, which writes the real read with source='alon').
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const date = String(body?.date || '').trim();
        if (!date) return fail(res, 400, 'date required (YYYY-MM-DD)');
        const lines = Array.isArray(body?.lines) ? body.lines : [];
        const source = body?.source === 'alon' ? 'alon' : 'manual';
        const saved = await saveAlonOrder(date, lines, source);
        return res.status(200).json({ ok: true, date, order: saved });
      }
      case 'customers-export': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        if (!requireAuth()) return;
        const customers = await getAllCustomers();
        return res.status(200).json({ ok: true, count: customers.length, customers });
      }
      case 'recent-orders': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        if (!requireAuth()) return; // contains customer PII
        const days = Math.min(Number(req.query.days) || 3, 14);
        return res.status(200).json({ ok: true, orders: await getRecentOrders({ days }) });
      }
      case 'notify-customer': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const phone = String(body?.phone || '');
        const message = String(body?.message || '');
        if (!message) return fail(res, 400, 'message required');
        return res.status(200).json({ ok: true, ...(await notifyCustomer(phone, message)) });
      }
      case 'set-costs': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const results = await setItemCosts(body?.costs);
        const priceFixes = await setItemPrices(body?.prices);
        return res.status(200).json({ ok: true, matched: results.filter((r: any) => r.matched).length, total: results.length, results, priceFixes });
      }
      case 'inventory-receive': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const lines = body?.lines;
        if (!Array.isArray(lines) || !lines.length) return fail(res, 400, 'lines[] required');
        const results = await receiveStock(lines);
        return res.status(200).json({ ok: true, matched: results.filter((r: any) => r.matched).length, total: results.length, results });
      }
      case 'inventory-reset-zero': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const offset = Number(body?.offset) || 0;
        const limit = Math.min(Number(body?.limit) || 40, 100);
        const r = await resetStockZero(offset, limit);
        return res.status(200).json({ ok: true, done: r.nextOffset === null, ...r });
      }
      case 'submit-order': {
        // A store employee submits a supplier order for the owner to place.
        // PIN-gated (not the admin secret) so staff can use it without the key.
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const employee = await employeeForPinAsync(String(body?.pin || ''));
        if (!employee) return fail(res, 401, 'Invalid PIN');
        const c = (body?.c && typeof body.c === 'object') ? body.c : {};
        const r = (body?.r && typeof body.r === 'object') ? body.r : {};
        const i = (body?.i && typeof body.i === 'object') ? body.i : {};
        const counts = { costco: Object.keys(c).length, rd: Object.keys(r).length, ic: Object.keys(i).length };
        const totalItems = counts.costco + counts.rd + counts.ic;
        if (!totalItems) return fail(res, 400, 'Order is empty');
        const at = Date.now();
        const id = at.toString(36) + Math.random().toString(36).slice(2, 6);
        const link = buildOrderLink({ e: employee, t: at, c, r, i });
        const order = { id, employee, at, counts, totalItems, link, orders: { c, r, i } };
        await savePendingOrder(order);
        const sms = `Colette: new supplier order from ${employee} — Costco ${counts.costco}, RD ${counts.rd}, Publix ${counts.ic} items. Place it: ${link}`;
        const emailHtml = `<p><b>${employee}</b> submitted a supplier order.</p>`
          + `<p>Costco: ${counts.costco} items · Restaurant Depot: ${counts.rd} items · Publix: ${counts.ic} items</p>`
          + `<p><a href="${link}">Open the order sheet with these quantities pre-filled →</a></p>`
          + `<p style="color:#888;font-size:12px">Submitted ${new Date(at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>`;
        const notify = await notifyOwner({ sms, emailSubject: `New supplier order from ${employee}`, emailHtml });
        return res.status(200).json({ ok: true, employee, id, link, notify });
      }
      case 'auth-check': {
        // Unified-shell login:
        //   • a 4-digit PIN            => employee (with name)
        //   • admin ID + password      => admin (returns the app secret so the
        //                                 dashboard's protected calls work — the
        //                                 owner never sees or types the key)
        //   • valid admin secret header => admin (legacy)
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const pin = String(body?.pin || '').trim();
        if (pin) {
          const employee = await employeeForPinAsync(pin);
          if (!employee) return fail(res, 401, 'PIN not recognized');
          return res.status(200).json({ ok: true, role: 'employee', name: employee });
        }
        const id = String(body?.adminId || '').trim();
        const pw = String(body?.adminPassword || '');
        if (id || pw) {
          const ADMIN_ID = process.env.ADMIN_ID, ADMIN_PW = process.env.ADMIN_PASSWORD;
          if (ADMIN_ID && ADMIN_PW && id === ADMIN_ID && pw === ADMIN_PW) {
            return res.status(200).json({ ok: true, role: 'admin', name: id, key: process.env.SYNC_SECRET || '' });
          }
          return fail(res, 401, 'ID or password not recognized');
        }
        if (authed) return res.status(200).json({ ok: true, role: 'admin', name: 'Admin', key: process.env.SYNC_SECRET || '' });
        return fail(res, 401, 'Enter your PIN, or admin ID + password');
      }
      case 'shifts-get': {
        // Schedule shifts + a rate-free roster (names + days off only) so staff can
        // view the schedule/My Week WITHOUT seeing anyone's pay. No PII/rates here.
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const roster = (await getTeam()).map((m: any) => ({ name: m.name, daysOff: Array.isArray(m.daysOff) ? m.daysOff : [] }));
        const approved = (await listTimeOff()).filter((t) => t.status === 'approved').map((t) => ({ name: t.name, from: t.from, to: t.to }));
        return res.status(200).json({ ok: true, shifts: await getShifts(), roster, timeoff: approved });
      }
      case 'shifts-save': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        // The owner (admin secret) OR an authorized scheduler's PIN may edit shifts.
        // Schedulers are named in SCHEDULERS env (comma-separated); default: Marco, Melissa.
        let allowed = authed;
        if (!allowed && body?.pin) {
          const who = await employeeForPinAsync(String(body.pin));
          const SCHEDULERS = (process.env.SCHEDULERS || 'marco,melissa').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
          if (who && SCHEDULERS.includes(who.toLowerCase())) allowed = true;
        }
        if (!allowed) return fail(res, 401, 'Not authorized to edit the schedule');
        const shifts = (body?.shifts && typeof body.shifts === 'object') ? body.shifts : null;
        if (!shifts) return fail(res, 400, 'shifts object required');
        await saveShifts(shifts);
        return res.status(200).json({ ok: true });
      }
      case 'timeoff-request': {
        // Employee submits a time-off request (PIN-gated).
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const employee = await employeeForPinAsync(String(body?.pin || ''));
        if (!employee) return fail(res, 401, 'PIN not recognized');
        const from = String(body?.from || '').trim(), to = String(body?.to || from).trim();
        if (!from) return fail(res, 400, 'from date required');
        const at = Date.now();
        const t = { id: at.toString(36) + Math.random().toString(36).slice(2, 6), name: employee, pin: String(body?.pin), from, to, reason: String(body?.reason || '').slice(0, 200), status: 'pending' as const, at };
        await addTimeOff(t);
        try { await notifyOwner({ sms: `Colette: ${employee} requested time off ${from}${to && to !== from ? '–' + to : ''}${t.reason ? ' ('+t.reason+')' : ''}.`, emailSubject: `Time-off request — ${employee}`, emailHtml: `<p><b>${employee}</b> requested time off: <b>${from}${to && to !== from ? ' – ' + to : ''}</b>${t.reason ? '<br>Reason: ' + t.reason : ''}</p>` }); } catch { /* best effort */ }
        return res.status(200).json({ ok: true, request: t });
      }
      case 'timeoff-mine': {
        // An employee's own requests (PIN-gated).
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const employee = await employeeForPinAsync(String(body?.pin || ''));
        if (!employee) return fail(res, 401, 'PIN not recognized');
        const mine = (await listTimeOff()).filter((t) => String(t.pin) === String(body?.pin));
        return res.status(200).json({ ok: true, requests: mine });
      }
      case 'timeoff-list': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        if (!requireAuth()) return;
        return res.status(200).json({ ok: true, requests: await listTimeOff() });
      }
      case 'timeoff-resolve': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const id = String(body?.id || ''); const status = body?.status === 'approved' ? 'approved' : 'denied';
        if (!id) return fail(res, 400, 'id required');
        await resolveTimeOff(id, status);
        return res.status(200).json({ ok: true });
      }
      case 'punch': {
        // Employee clock in/out — PIN-gated (staff use it without the admin key).
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const r = await togglePunch(String(body?.pin || ''));
        if (!r) return fail(res, 401, 'PIN not recognized');
        return res.status(200).json({ ok: true, ...r });
      }
      case 'clock-status': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const pin = String(body?.pin || '');
        const st = await clockStatus(pin);
        if (!st.name) return fail(res, 401, 'PIN not recognized');
        return res.status(200).json({ ok: true, ...st });
      }
      case 'punches': {
        // All clock events for payroll (admin only).
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        if (!requireAuth()) return;
        return res.status(200).json({ ok: true, punches: await listPunches(), team: await getTeam() });
      }
      case 'team-list': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        if (!requireAuth()) return;
        return res.status(200).json({ ok: true, team: await getTeam() });
      }
      case 'team-save': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const team = Array.isArray(body?.team) ? body.team : null;
        if (!team) return fail(res, 400, 'team[] required');
        // Normalize + validate: keep name, phone, pin, rate.
        const clean = team
          .map((m: any) => ({
            name: String(m?.name || '').trim(),
            phone: String(m?.phone || '').trim(),
            pin: String(m?.pin || '').trim(),
            rate: Number(m?.rate) || 0,
            daysOff: Array.isArray(m?.daysOff) ? m.daysOff.map((x: any) => String(x)) : [],
          }))
          .filter((m: any) => m.name && /^\d{3,8}$/.test(m.pin));
        await saveTeam(clean);
        return res.status(200).json({ ok: true, team: clean });
      }
      case 'pending-orders': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        if (!requireAuth()) return;
        return res.status(200).json({ ok: true, orders: await listPendingOrders() });
      }
      case 'resolve-order': {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        if (!requireAuth()) return;
        const id = String(body?.id || '');
        if (!id) return fail(res, 400, 'id required');
        await resolvePendingOrder(id);
        return res.status(200).json({ ok: true });
      }
      default:
        return fail(res, 400, 'Unknown action. Use reorder-suggest | reorder-plan | stockout | metrics | place-order | run-task | commit-file | alon-order-get | alon-order-save | alon-order-dates | alon-catalog-get | alon-catalog-save | set-costs | recent-orders | notify-customer | customers-export | inventory-receive | inventory-reset-zero | submit-order | pending-orders | resolve-order');
    }
  } catch (e: any) {
    fail(res, e?.status || 502, `${action} failed`, e?.body ?? String(e));
  }
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
