// POST /api/inventory-reset-zero — ONE-TIME: set Clover item stock to 0.
// Paged to avoid timeouts. Body: { offset?, limit? } → { done, processed, nextOffset, total }
// Loop: call with the returned nextOffset until nextOffset is null.
// Protected by header x-colette-secret === SYNC_SECRET.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, resetStockZero } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const secret = process.env.SYNC_SECRET;
  if (!secret) return fail(res, 503, 'SYNC_SECRET not configured');
  if ((req.headers['x-colette-secret'] as string) !== secret) return fail(res, 401, 'Unauthorized');
  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  const b = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const offset = Number(b?.offset) || 0;
  const limit = Math.min(Number(b?.limit) || 40, 100);
  try {
    const r = await resetStockZero(offset, limit);
    res.status(200).json({ ok: true, done: r.nextOffset === null, ...r });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Reset failed', e?.body ?? String(e));
  }
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
