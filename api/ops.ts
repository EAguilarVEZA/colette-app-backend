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
  suggestReorder, getAllCustomers, receiveStock, resetStockZero, salesSummary,
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
      case 'metrics': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        const days = Math.min(Number(req.query.days) || 35, 90);
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
        return res.status(200).json({ ok: true, ...(await salesSummary({ days })) });
      }
      case 'customers-export': {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET');
        if (!requireAuth()) return;
        const customers = await getAllCustomers();
        return res.status(200).json({ ok: true, count: customers.length, customers });
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
      default:
        return fail(res, 400, 'Unknown action. Use reorder-suggest | metrics | customers-export | inventory-receive | inventory-reset-zero');
    }
  } catch (e: any) {
    fail(res, e?.status || 502, `${action} failed`, e?.body ?? String(e));
  }
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
