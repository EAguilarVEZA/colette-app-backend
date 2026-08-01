// GET /api/reorder-suggest?days=30&leadDays=3 — Phase 2 "brain".
// Suggests how much of each Alon's product to reorder, from recent Clover sales.
// suggested = ceil(avgPerDay * leadDays) - currentStock (floored at 0).
// Aggregate business data (no PII) — open GET for easy viewing.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, suggestReorder } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);
  const days = Math.min(Number(req.query.days) || 30, 365);
  const leadDays = Math.min(Number(req.query.leadDays) || 3, 30);
  try {
    const r = await suggestReorder({ days, leadDays });
    res.status(200).json({ ok: true, ...r });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Suggest failed', e?.body ?? String(e));
  }
}
