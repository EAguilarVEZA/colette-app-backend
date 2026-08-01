// POST /api/delivery-quote — flat DoorDash Drive fee + ETA for a dropoff address.
// Body: { externalDeliveryId, dropoffAddress, dropoffPhone, dropoffName?, orderValueCents }
// Returns: { ok, feeCents, currency, etaDropoff }
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, fail } from '../lib/clover.js';
import { ddConfigured, quote } from '../lib/doordash.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const missing = ddConfigured();
  if (missing.length) return fail(res, 503, 'DoorDash Drive not configured yet', missing);

  const b = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!b?.dropoffAddress || !b?.dropoffPhone) return fail(res, 400, 'dropoffAddress and dropoffPhone required');
  try {
    const q = await quote({
      externalDeliveryId: b.externalDeliveryId || `colette-${Date.now()}`,
      dropoffAddress: b.dropoffAddress,
      dropoffPhone: b.dropoffPhone,
      dropoffName: b.dropoffName,
      orderValueCents: b.orderValueCents || 0,
    });
    res.status(200).json({ ok: true, feeCents: q.feeCents, currency: q.currency, etaDropoff: q.etaDropoff });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Quote failed', e?.body ?? String(e));
  }
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
