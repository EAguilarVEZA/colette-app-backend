// POST /api/checkout — the full "pay + fire to the store" loop in one call.
//   1. Create the order in Clover (Atomic Order) from real item IDs + modifiers.
//   2. Charge the card (Clover Ecommerce) for the order's authoritative total.
//   3. Mark the order PAID ONLINE and PRINT it to the store's order printer.
// Only a *successfully paid* order is printed, so staff never make an unpaid ticket.
//
// Body: {
//   lines: [{ itemId, quantity, modifierIds? }],
//   source: string,            // single-use card/Apple Pay token from the hosted iframe
//   orderType?: "PICKUP"|"DELIVERY",
//   customerName?: string, note?: string,
//   amountCents?: number       // fallback only; server prefers Clover's order total
// }
// Returns: { ok, orderId, paymentId, amountCents, printed }
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  applyCors, assertConfigured, fail,
  createOrder, charge, printOrder, setOrderNote, type CartLine,
  BOGO_CODE, findCustomerWithNote, hasRedeemedBogo, markBogoRedeemed, crepeDiscountForCart,
} from '../lib/clover.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const lines: CartLine[] = body?.lines;
  const source: string = body?.source;
  if (!Array.isArray(lines) || lines.length === 0) {
    return fail(res, 400, 'Body must include a non-empty "lines" array');
  }
  for (const l of lines) {
    if (!l?.itemId || typeof l.quantity !== 'number') {
      return fail(res, 400, 'Each line needs itemId (string) and quantity (number)');
    }
  }
  if (!source) return fail(res, 400, 'source (payment token) is required');

  const orderType = body?.orderType || undefined;
  const customerName = body?.customerName || undefined;

  // Optional BOGO crêpe promo. Requires an email/phone to enforce one-per-customer,
  // and at least two crêpes in the cart (buy one, get one free).
  const promoCode = String(body?.promoCode || '').trim().toUpperCase();
  const promoEmail = (body?.email || '').trim();
  const promoPhone = (body?.phone || '').trim();
  const discounts: { name: string; amountCents: number }[] = [];
  let bogoCustomer: any = null;
  let bogoApplied = false;
  let bogoReason = '';
  if (promoCode === BOGO_CODE) {
    if (!promoEmail && !promoPhone) {
      bogoReason = 'Add the email or phone from your Colette offer to use the BOGO crêpe.';
    } else {
      try {
        bogoCustomer = await findCustomerWithNote(promoEmail, promoPhone);
        if (bogoCustomer && hasRedeemedBogo(bogoCustomer)) {
          bogoReason = 'This BOGO crêpe offer has already been used.';
        } else {
          const discountCents = await crepeDiscountForCart(lines);
          if (discountCents > 0) {
            discounts.push({ name: 'BOGO Crêpe (COLETTEBOGO)', amountCents: discountCents });
            bogoApplied = true;
          } else {
            bogoReason = 'Add two crêpes to your cart to get one free.';
          }
        }
      } catch { bogoReason = 'Could not validate the promo code; order placed without it.'; }
    }
  }

  // 1) Create the order (source of truth for the total).
  let orderId: string;
  let orderTotalCents = 0;
  try {
    const deliveryFeeCents =
      orderType === 'DELIVERY' && typeof body?.deliveryFeeCents === 'number'
        ? body.deliveryFeeCents : 0;
    const { orderId: id, raw } = await createOrder({
      lines, note: body?.note, customerName, orderType,
      discounts: discounts.length ? discounts : undefined,
      deliveryFeeCents: deliveryFeeCents || undefined,
    });
    orderId = id;
    if (typeof raw?.total === 'number') orderTotalCents = raw.total;
  } catch (e: any) {
    return fail(res, e?.status || 502, 'Order create failed', e?.body ?? String(e));
  }

  // Prefer Clover's authoritative total; fall back to client amount if needed.
  const amountCents =
    orderTotalCents > 0 ? orderTotalCents
    : (typeof body?.amountCents === 'number' ? body.amountCents : 0);
  if (amountCents <= 0) {
    return fail(res, 400, 'Could not determine order total', { orderId });
  }

  // 2) Charge the card. If this fails, do NOT print (staff won't make unpaid orders).
  let paymentId: string;
  try {
    const r = await charge({ amountCents, source, orderId });
    paymentId = r.paymentId;
  } catch (e: any) {
    return fail(res, e?.status || 402, 'Payment failed', { orderId, detail: e?.body ?? String(e) });
  }

  // 3) Mark paid + print. Payment already succeeded, so a print hiccup must NOT
  //    fail the response — report printed:false so the front-end can tell the
  //    customer it's paid and ask staff to reprint if needed.
  let printed = false;
  try {
    const dollars = (amountCents / 100).toFixed(2);
    const label = `PAID ONLINE $${dollars}${customerName ? ' · ' + customerName : ''}${orderType ? ' · ' + orderType : ''}`;
    await setOrderNote(orderId, label);
    await printOrder(orderId);
    printed = true;
  } catch {
    printed = false;
  }

  // Payment succeeded — stamp the BOGO as redeemed so it can't be reused.
  if (bogoApplied) {
    try {
      await markBogoRedeemed({ customerId: bogoCustomer?.id, email: promoEmail, phone: promoPhone });
    } catch { /* non-fatal: order is already paid */ }
  }

  res.status(200).json({
    ok: true, orderId, paymentId, amountCents, printed,
    bogoApplied, ...(bogoReason ? { bogoReason } : {}),
  });
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
