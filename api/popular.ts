// GET /api/popular?days=90 — best-selling items from your Clover order history,
// ranked by units sold (and revenue). Cached at the edge for an hour.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, getPopular } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');

  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  const days = req.query?.days ? Math.max(1, parseInt(String(req.query.days), 10) || 90) : 90;

  try {
    const items = await getPopular({ days });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ ok: true, days, items });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Clover orders fetch failed', e?.body ?? String(e));
  }
}
