// POST /api/pay — charges a payment via Clover Ecommerce (PCI-safe).
// The app first turns the card OR Apple Pay into a single-use `source` token
// (Clover hosted iframe / Apple Pay), then sends that token here — we never
// see raw card data.
// Body: { amountCents: number, source: string, orderId?: string }
// Returns: { ok, paymentId }
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, fail, charge } from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const amountCents: number = body?.amountCents;
  const source: string = body?.source;

  if (typeof amountCents !== 'number' || amountCents <= 0) {
    return fail(res, 400, 'amountCents must be a positive integer (cents)');
  }
  if (!source) return fail(res, 400, 'source (payment token) is required');

  try {
    const { paymentId } = await charge({ amountCents, source, orderId: body?.orderId });
    res.status(200).json({ ok: true, paymentId });
  } catch (e: any) {
    fail(res, e?.status || 502, 'Clover charge failed', e?.body ?? String(e));
  }
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
