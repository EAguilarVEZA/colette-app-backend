// POST /api/order — creates an order in Clover (lands in the kitchen).
// Body: { lines: [{ itemId, quantity, modifierIds? }], customerName?, note?, orderType? }
//   orderType: "PICKUP" (default) or "DELIVERY"
// Returns: { ok, orderId }
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, createOrder, type CartLine } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const lines: CartLine[] = body?.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    return fail(res, 400, 'Body must include a non-empty "lines" array of { itemId, quantity }');
  }
  for (const l of lines) {
    if (!l?.itemId || typeof l.quantity !== 'number') {
      return fail(res, 400, 'Each line needs itemId (string) and quantity (number)');
    }
  }

  try {
    const { orderId } = await createOrder({
      lines,
      note: body?.note,
      customerName: body?.customerName,
      orderType: body?.orderType,
    });
    res.status(200).json({ ok: true, orderId });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Clover order create failed', e?.body ?? String(e));
  }
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
