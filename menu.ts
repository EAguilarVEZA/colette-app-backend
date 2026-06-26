// GET /api/menu — returns the live Colette menu from Clover Inventory,
// grouped by category and shaped for the app.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, getMenu } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');

  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  try {
    const menu = await getMenu();
    // cache at the edge for 60s so we don't hammer Clover on every app open
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ ok: true, ...menu });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Clover menu fetch failed', e?.body ?? String(e));
  }
}
