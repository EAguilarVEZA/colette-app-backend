// lib/doordash.ts
// DoorDash Drive (white-label delivery): branded delivery on our own order page,
// flat per-delivery fee, no marketplace commission. JWT (HS256) auth per DoorDash.
// Secrets come from env (set in Vercel) — never in code:
//   DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID, DOORDASH_SIGNING_SECRET
//   DOORDASH_BASE (default https://openapi.doordash.com)
//   STORE_NAME, STORE_ADDRESS, STORE_PHONE  (pickup = the bakery)
import crypto from 'crypto';

const clean = (v?: string) => (v || '').trim();
export const dd = {
  developerId: clean(process.env.DOORDASH_DEVELOPER_ID),
  keyId: clean(process.env.DOORDASH_KEY_ID),
  signingSecret: clean(process.env.DOORDASH_SIGNING_SECRET),
  base: clean(process.env.DOORDASH_BASE) || 'https://openapi.doordash.com',
  storeName: clean(process.env.STORE_NAME) || 'Colette French Pastries',
  storeAddress: clean(process.env.STORE_ADDRESS) || '2225 Old Milton Pkwy, Suite 100, Alpharetta, GA 30004',
  storePhone: clean(process.env.STORE_PHONE) || '+16786917714',
};

export function ddConfigured(): string[] {
  const missing: string[] = [];
  if (!dd.developerId) missing.push('DOORDASH_DEVELOPER_ID');
  if (!dd.keyId) missing.push('DOORDASH_KEY_ID');
  if (!dd.signingSecret) missing.push('DOORDASH_SIGNING_SECRET');
  return missing;
}

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Build a short-lived DoorDash JWT (HS256, DD-JWT-V1). Signing secret is base64url.
function makeJwt(): string {
  const header = { alg: 'HS256', 'dd-ver': 'DD-JWT-V1', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: 'doordash', iss: dd.developerId, kid: dd.keyId, exp: now + 1740, iat: now };
  const enc = (o: any) => b64url(Buffer.from(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const secret = Uint8Array.from(Buffer.from(dd.signingSecret, 'base64')); // DoorDash secret is base64url-encoded
  const sig = b64url(crypto.createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

async function ddFetch(path: string, body: unknown) {
  const r = await fetch(`${dd.base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${makeJwt()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!r.ok) throw { status: r.status, body: parsed };
  return parsed;
}

export interface DropoffInput {
  externalDeliveryId: string;   // our unique id (use the Clover orderId)
  dropoffAddress: string;
  dropoffPhone: string;         // +1XXXXXXXXXX
  dropoffName?: string;
  dropoffInstructions?: string;
  orderValueCents: number;      // subtotal, in cents
  tipCents?: number;
}

// Validate coverage + get the flat delivery fee + ETA (no Dasher dispatched yet).
export async function quote(o: DropoffInput) {
  const raw = await ddFetch('/drive/v2/quotes', {
    external_delivery_id: o.externalDeliveryId,
    pickup_address: dd.storeAddress,
    pickup_business_name: dd.storeName,
    pickup_phone_number: dd.storePhone,
    dropoff_address: o.dropoffAddress,
    dropoff_phone_number: o.dropoffPhone,
    dropoff_contact_given_name: o.dropoffName || 'Customer',
    dropoff_instructions: o.dropoffInstructions || '',
    order_value: o.orderValueCents,
  });
  return {
    feeCents: raw?.fee ?? null,
    currency: raw?.currency ?? 'USD',
    etaPickup: raw?.pickup_time_estimated ?? null,
    etaDropoff: raw?.dropoff_time_estimated ?? null,
    raw,
  };
}

// Dispatch a Dasher for a paid order.
export async function createDelivery(o: DropoffInput) {
  const raw = await ddFetch('/drive/v2/deliveries', {
    external_delivery_id: o.externalDeliveryId,
    pickup_address: dd.storeAddress,
    pickup_business_name: dd.storeName,
    pickup_phone_number: dd.storePhone,
    dropoff_address: o.dropoffAddress,
    dropoff_phone_number: o.dropoffPhone,
    dropoff_contact_given_name: o.dropoffName || 'Customer',
    dropoff_instructions: o.dropoffInstructions || '',
    order_value: o.orderValueCents,
    tip: o.tipCents || 0,
  });
  return {
    feeCents: raw?.fee ?? null,
    trackingUrl: raw?.tracking_url ?? null,
    status: raw?.delivery_status ?? null,
    raw,
  };
}
