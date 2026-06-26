// lib/clover.ts
// Thin, typed wrapper around the Clover REST + Ecommerce APIs.
// All secrets are read from environment variables (set them in Vercel),
// so nothing sensitive ever lives in the app or the repo.

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ---------- config ----------
const clean = (v?: string) => (v || '').trim();
export const cfg = {
  merchantId: clean(process.env.CLOVER_MERCHANT_ID),
  apiToken: clean(process.env.CLOVER_API_TOKEN),
  apiBase: clean(process.env.CLOVER_API_BASE) || 'https://sandbox.dev.clover.com',
  ecommBase: clean(process.env.CLOVER_ECOMM_BASE) || 'https://scl-sandbox.dev.clover.com',
  ecommKey: clean(process.env.CLOVER_ECOMM_PRIVATE_KEY),
  defaultOrderType: process.env.DEFAULT_ORDER_TYPE || 'PICKUP',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()),
};

export function assertConfigured(): string[] {
  const missing: string[] = [];
  if (!cfg.merchantId) missing.push('CLOVER_MERCHANT_ID');
  if (!cfg.apiToken) missing.push('CLOVER_API_TOKEN');
  return missing;
}

// ---------- CORS + helpers ----------
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  const origin = (req.headers.origin as string) || '';
  const allow =
    cfg.allowedOrigins.includes('*') || cfg.allowedOrigins.includes(origin)
      ? cfg.allowedOrigins.includes('*')
        ? '*'
        : origin
      : '';
  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true; // handled
  }
  return false;
}

export function fail(res: VercelResponse, status: number, message: string, extra?: unknown) {
  res.status(status).json({ ok: false, error: message, detail: extra ?? null });
}

// ---------- REST API (menu, orders, customers) ----------
async function restFetch(path: string, init: RequestInit = {}) {
  const url = `${cfg.apiBase}/v3/merchants/${cfg.merchantId}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw { status: r.status, body };
  return body;
}

export interface Modifier { id: string; name: string; priceCents: number; price: number }
export interface ModifierGroup {
  id: string;
  name: string;
  minRequired: number;
  maxAllowed: number;     // 0 = unlimited
  modifiers: Modifier[];
}
export interface MenuItem {
  id: string;
  name: string;
  price: number;        // dollars
  priceCents: number;   // raw Clover cents
  category: string;
  available: boolean;
  modifierGroups: ModifierGroup[];   // options like milk, size, candle, flavours
}

// Pull the live menu from Clover Inventory and shape it for the app — including
// modifier groups so the website/app can offer the same options Clover knows about.
export async function getMenu(): Promise<{ categories: string[]; items: MenuItem[] }> {
  // Expand categories + nested modifier groups & their modifiers in one call.
  // NOTE: confirm nested-expand support on your plan; if modifiers come back empty,
  // fetch /item_modifier_groups/{id}?expand=modifiers per group instead.
  const data = await restFetch('/items?expand=categories,modifierGroups.modifiers&limit=1000');
  const elements: any[] = data?.elements || [];
  const items: MenuItem[] = elements
    .filter((it) => !it.hidden)
    .map((it) => {
      const cat = it.categories?.elements?.[0]?.name || 'Other';
      const cents = typeof it.price === 'number' ? it.price : 0;
      const groups: ModifierGroup[] = (it.modifierGroups?.elements || []).map((g: any) => ({
        id: g.id,
        name: g.name,
        minRequired: g.minRequired ?? 0,
        maxAllowed: g.maxAllowed ?? 0,
        modifiers: (g.modifiers?.elements || []).map((m: any) => ({
          id: m.id,
          name: m.name,
          priceCents: typeof m.price === 'number' ? m.price : 0,
          price: (typeof m.price === 'number' ? m.price : 0) / 100,
        })),
      }));
      return {
        id: it.id,
        name: it.name,
        priceCents: cents,
        price: cents / 100,
        category: cat,
        available: it.available !== false,
        modifierGroups: groups,
      };
    });
  const categories = [...new Set(items.map((i) => i.category))];
  return { categories, items };
}

// A cart line; modifierIds are Clover modifier IDs chosen for this line.
export interface CartLine { itemId: string; quantity: number; modifierIds?: string[] }

// Create an order in Clover using the Atomic Order endpoint.
// The order appears in Clover and prints to the kitchen like any other ticket.
// orderType: pass a Clover order-type label ("PICKUP" / "DELIVERY"); falls back to config.
export async function createOrder(opts: {
  lines: CartLine[];
  note?: string;
  customerName?: string;
  orderType?: string;
}): Promise<{ orderId: string; raw: any }> {
  const lineItems = opts.lines.flatMap((l) =>
    Array.from({ length: Math.max(1, l.quantity) }, () => {
      const li: any = { item: { id: l.itemId } };
      // Attach chosen modifiers (milk, size, candle, flavours, …) as line modifications.
      if (l.modifierIds && l.modifierIds.length) {
        li.modifications = l.modifierIds.map((id) => ({ modifier: { id } }));
      }
      return li;
    })
  );
  const orderCart: any = {
    orderCart: {
      lineItems,
      orderType: { label: opts.orderType || cfg.defaultOrderType },
      note: opts.note || (opts.customerName ? `App order — ${opts.customerName}` : 'App order'),
    },
  };
  const raw = await restFetch('/atomic_order/orders', {
    method: 'POST',
    body: JSON.stringify(orderCart),
  });
  return { orderId: raw?.id, raw };
}

// ---------- Ecommerce API (payments + Apple Pay) ----------
// `source` is a single-use token created client-side via the Clover hosted
// iframe (card entry) or from an Apple Pay token. We never see raw card data.
export async function charge(opts: {
  amountCents: number;
  source: string;
  orderId?: string;
  currency?: string;
}): Promise<{ paymentId: string; raw: any }> {
  if (!cfg.ecommKey) throw { status: 500, body: 'CLOVER_ECOMM_PRIVATE_KEY not set' };
  const r = await fetch(`${cfg.ecommBase}/v1/charges`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.ecommKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: opts.amountCents,
      currency: opts.currency || 'usd',
      source: opts.source,
      ...(opts.orderId ? { external_reference_id: opts.orderId } : {}),
    }),
  });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw { status: r.status, body };
  return { paymentId: body?.id, raw: body };
}
