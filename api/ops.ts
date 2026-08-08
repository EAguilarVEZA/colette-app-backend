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
  employeeForPin, buildOrderLink, savePendingOrder, listPendingOrders, resolvePendingOrder, notifyOwner,
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
        if (!Array.isArray(lines) || !lines.length) return fail(res, 400, 'lines[] required');
        const token = process.env.GH_DISPATCH_TOKEN;
        const repo = process.env.GH_REPO || 'EAguilarVEZA/colette-app-backend';
        if (token) {
          const gh = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/flexibake-sync.yml/dispatches`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'colette-dashboard' },
            body: JSON.stringify({ ref: 'main', inputs: { task: 'place', order: JSON.stringify(lines).slice(0, 60000), date: targetDay } }),
          });
          if (gh.status === 204) return res.status(200).json({ ok: true, placed: true, dispatched: true, targetDay, lines });
          const detail = await gh.text();
          return fail(res, 502, 'Dispatch failed', detail);
        }
        // Not yet wired to auto-place — record the approval so the UI can confirm.
        return res.status(200).json({ ok: true, placed: false, dispatched: false, targetDay, lines,
          note: 'Approval recorded. Auto-submit to Alon activates after the new-order recon + placement step.' });
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
        const employee = employeeForPin(String(body?.pin || ''));
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
        // Unified-shell login: a 4-digit PIN => employee (with name); a valid
        // admin secret (header) => admin. Used to gate tabs by role.
        if (req.method !== 'POST') return fail(res, 405, 'Use POST');
        const pin = String(body?.pin || '').trim();
        if (pin) {
          const employee = employeeForPin(pin);
          if (!employee) return fail(res, 401, 'PIN not recognized');
          return res.status(200).json({ ok: true, role: 'employee', name: employee });
        }
        if (authed) return res.status(200).json({ ok: true, role: 'admin', name: 'Admin' });
        return fail(res, 401, 'Enter a PIN or a valid admin key');
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
        return fail(res, 400, 'Unknown action. Use reorder-suggest | reorder-plan | stockout | metrics | place-order | set-costs | recent-orders | notify-customer | customers-export | inventory-receive | inventory-reset-zero | submit-order | pending-orders | resolve-order');
    }
  } catch (e: any) {
    fail(res, e?.status || 502, `${action} failed`, e?.body ?? String(e));
  }
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
