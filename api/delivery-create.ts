// POST /api/delivery-create — dispatch a DoorDash Dasher for a PAID order.
// Call this only after /api/checkout succeeds (order is paid). Use the Clover
// orderId as externalDeliveryId so delivery ties back to the order.
// Body: { externalDeliveryId, dropoffAddress, dropoffPhone, dropoffName?, dropoffInstructions?, orderValueCents, tipCents? }
// Returns: { ok, feeCents, trackingUrl, status }
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, fail } from '../lib/clover.js';
import { ddConfigured, createDelivery } from '../lib/doordash.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const missing = ddConfigured();
  if (missing.length) return fail(res, 503, 'DoorDash Drive not configured yet', missing);

  const b = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!b?.externalDeliveryId || !b?.dropoffAddress || !b?.dropoffPhone) {
    return fail(res, 400, 'externalDeliveryId, dropoffAddress, dropoffPhone required');
  }
  try {
    const d = await createDelivery({
      externalDeliveryId: b.externalDeliveryId,
      dropoffAddress: b.dropoffAddress,
      dropoffPhone: b.dropoffPhone,
      dropoffName: b.dropoffName,
      dropoffInstructions: b.dropoffInstructions,
      orderValueCents: b.orderValueCents || 0,
      tipCents: b.tipCents || 0,
    });
    res.status(200).json({ ok: true, feeCents: d.feeCents, trackingUrl: d.trackingUrl, status: d.status });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Delivery create failed', e?.body ?? String(e));
  }
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
