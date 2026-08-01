// POST /api/inventory-receive — add received quantities to Clover stock.
// Called by the daily FlexiBake sync job. Body: { lines: [{ code?, itemId?, name?, qty }] }
//   code = Alon's product code (mapped to a Clover item via ALON_MAP).
// Returns: { ok, results:[{label, matched, from, added, to}] }
// Protected by header x-colette-secret === SYNC_SECRET.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, receiveStock } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const secret = process.env.SYNC_SECRET;
  if (!secret) return fail(res, 503, 'SYNC_SECRET not configured');
  if ((req.headers['x-colette-secret'] as string) !== secret) return fail(res, 401, 'Unauthorized');
  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  const b = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const lines = b?.lines;
  if (!Array.isArray(lines) || !lines.length) return fail(res, 400, 'lines[] required');
  for (const l of lines) {
    if (typeof l?.qty !== 'number') return fail(res, 400, 'each line needs a numeric qty');
    if (!l.code && !l.itemId && !l.name) return fail(res, 400, 'each line needs code, itemId, or name');
  }
  try {
    const results = await receiveStock(lines);
    const matched = results.filter((r: any) => r.matched).length;
    res.status(200).json({ ok: true, matched, total: results.length, results });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Receive failed', e?.body ?? String(e));
  }
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
