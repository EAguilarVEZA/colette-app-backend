// GET /api/customers-export — full customer list (name, email, phone, consent).
// PII → protected by header x-colette-secret === SYNC_SECRET.
// NOTE: Clover does NOT expose loyalty points via API — not included here.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, getAllCustomers } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  const secret = process.env.SYNC_SECRET;
  if (!secret) return fail(res, 503, 'SYNC_SECRET not configured');
  if ((req.headers['x-colette-secret'] as string) !== secret) return fail(res, 401, 'Unauthorized');
  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);
  try {
    const customers = await getAllCustomers();
    res.status(200).json({ ok: true, count: customers.length, customers });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Customer export failed', e?.body ?? String(e));
  }
}
