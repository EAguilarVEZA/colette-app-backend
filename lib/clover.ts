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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function restFetch(path: string, init: RequestInit = {}) {
  const url = `${cfg.apiBase}/v3/merchants/${cfg.merchantId}${path}`;
  // Retry on Clover rate limiting (429) with exponential backoff.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (r.status === 429 && attempt < 5) { await sleep(600 * (attempt + 1)); continue; }
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!r.ok) throw { status: r.status, body };
    return body;
  }
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

// Fire an existing order to the store's order/kitchen printer (or the Clover
// device's onboard printer). Requires the API token to have Write orders +
// Read orders permission, and a printer/Clover device configured & online.
// Docs: POST /v3/merchants/{mId}/print_event  body { order: { id } }
export async function printOrder(orderId: string): Promise<{ ok: boolean; raw: any }> {
  const raw = await restFetch('/print_event', {
    method: 'POST',
    body: JSON.stringify({ order: { id: orderId } }),
  });
  return { ok: true, raw };
}

// Attach a note to an order (e.g. mark it PAID ONLINE so staff reconcile it).
export async function setOrderNote(orderId: string, note: string): Promise<void> {
  await restFetch(`/orders/${orderId}`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

// ---------- Inventory (item stock) — for the Alon's/FlexiBake sync ----------
// Alon's wholesale product CODE -> Clover item NAME (resolved to id at run time).
export const ALON_MAP: Record<string, string> = {
  '7152': 'Almond Croissant',
  '7153': 'Apple Vanilla Danish',
  '7184': 'Blueberry Muffin',
  '7156': 'Cheese Danish',
  '7160': 'Chocolate Croissant',
  '7164': 'Scone',
  '19347': 'Gruyere Sesame Twist',
  '795': 'Hazelnut Chocolate Danish',
  '4111': 'Kouign Amann',
  '7171': 'Plain Croissant',
  '999997': 'Mushroom And Fontina Cheese Quiche',
  '999995': 'Spinach And Butternut Squash',
  '7176': 'Raspberry Cheese Danish',
  '0192': 'Twice-Baked Almond Croissant',
};

const normName = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Light list of every item (id + name) — no expands, for stock ops.
export async function listItems(): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let offset = 0;
  const page = 1000;
  for (;;) {
    const data = await restFetch(`/items?limit=${page}&offset=${offset}`);
    const els: any[] = data?.elements || [];
    for (const it of els) out.push({ id: it.id, name: it.name });
    if (els.length < page) break;
    offset += page;
  }
  return out;
}

export async function getStock(itemId: string): Promise<number> {
  try {
    const s = await restFetch(`/item_stocks/${itemId}`);
    return typeof s?.quantity === 'number' ? s.quantity : (typeof s?.stockCount === 'number' ? s.stockCount : 0);
  } catch (e: any) {
    if (e?.status === 404) return 0; // not tracked yet
    throw e;
  }
}

export async function setStock(itemId: string, quantity: number): Promise<void> {
  await restFetch(`/item_stocks/${itemId}`, {
    method: 'POST',
    body: JSON.stringify({ quantity }),
  });
}

// Zero a chunk of items' stock (paged to avoid serverless timeouts).
export async function resetStockZero(offset = 0, limit = 40): Promise<{ processed: number; nextOffset: number | null; total: number }> {
  const items = await listItems();
  const slice = items.slice(offset, offset + limit);
  for (const it of slice) { try { await setStock(it.id, 0); } catch { /* skip untrackable */ } }
  const next = offset + limit;
  return { processed: slice.length, nextOffset: next < items.length ? next : null, total: items.length };
}

// Add received quantities to stock. lines: [{code?, itemId?, name?, qty}].
export async function receiveStock(lines: { code?: string; itemId?: string; name?: string; qty: number }[]) {
  const items = await listItems();
  const byId = new Map(items.map((i) => [i.id, i]));
  const byName = new Map(items.map((i) => [normName(i.name), i]));
  const results: any[] = [];
  for (const l of lines) {
    let id = l.itemId;
    let label = l.name || l.code || l.itemId;
    if (!id && l.code && ALON_MAP[l.code]) { const m = byName.get(normName(ALON_MAP[l.code])); if (m) id = m.id; label = ALON_MAP[l.code]; }
    if (!id && l.name) { const m = byName.get(normName(l.name)); if (m) id = m.id; }
    if (!id || !byId.has(id)) { results.push({ label, matched: false, qty: l.qty }); continue; }
    try {
      const cur = await getStock(id);
      const next = cur + l.qty;
      await setStock(id, next);
      results.push({ label, itemId: id, matched: true, from: cur, added: l.qty, to: next });
    } catch (e: any) {
      results.push({ label, itemId: id, matched: true, error: e?.body ?? String(e) });
    }
  }
  return results;
}

// ---------- Leads / first-party database (Clover Customers) ----------
// We store each opt-in as a Clover CUSTOMER so the marketing list lives inside
// the CRM the store already uses. Dedup by email/phone so a person only ever
// gets the welcome offer once.
const digits = (s?: string) => (s || '').replace(/\D/g, '');

export async function findLead(email?: string, phone?: string): Promise<any | null> {
  const e = (email || '').trim().toLowerCase();
  const p = digits(phone).slice(-10); // compare on last 10 digits
  if (!e && !p) return null;
  // Small lists early on: scan customers with contacts expanded and match in code.
  const data = await restFetch('/customers?expand=emailAddresses,phoneNumbers&limit=1000');
  const list: any[] = data?.elements || [];
  for (const c of list) {
    const emails = (c.emailAddresses?.elements || []).map((x: any) => (x.emailAddress || '').trim().toLowerCase());
    const phones = (c.phoneNumbers?.elements || []).map((x: any) => digits(x.phoneNumber).slice(-10));
    if (e && emails.includes(e)) return c;
    if (p && phones.includes(p)) return c;
  }
  return null;
}

export async function createLead(opts: {
  email?: string; phone?: string; firstName?: string;
  emailConsent: boolean; smsConsent: boolean; source?: string;
}): Promise<{ customerId: string; raw: any }> {
  const consentNote =
    `MARKETING OPT-IN · email_consent=${opts.emailConsent ? 'Y' : 'N'} · ` +
    `sms_consent=${opts.smsConsent ? 'Y' : 'N'} · source=${opts.source || 'web'} · ` +
    `at=${new Date().toISOString()}`;
  const body: any = {
    firstName: opts.firstName || 'Web',
    marketingAllowed: opts.emailConsent || opts.smsConsent,
    metadata: { note: consentNote },
  };
  if (opts.email) body.emailAddresses = [{ emailAddress: opts.email.trim() }];
  if (opts.phone) body.phoneNumbers = [{ phoneNumber: opts.phone.trim() }];
  const raw = await restFetch('/customers', { method: 'POST', body: JSON.stringify(body) });
  return { customerId: raw?.id, raw };
}

// ---------- Full customer export (name, email, phone, consent) ----------
// NOTE: Clover does NOT expose loyalty/rewards points via the REST API, so
// points are not included here (export them from the Clover dashboard instead).
export interface CustomerRow {
  id: string; firstName: string; lastName: string;
  emails: string; phones: string; marketingAllowed: boolean; since: string; note: string;
}
export async function getAllCustomers(): Promise<CustomerRow[]> {
  const rows: CustomerRow[] = [];
  let offset = 0; const page = 1000;
  for (;;) {
    const data = await restFetch(`/customers?expand=emailAddresses,phoneNumbers,metadata&limit=${page}&offset=${offset}`);
    const els: any[] = data?.elements || [];
    for (const c of els) {
      rows.push({
        id: c.id,
        firstName: c.firstName || '',
        lastName: c.lastName || '',
        emails: (c.emailAddresses?.elements || []).map((x: any) => x.emailAddress).filter(Boolean).join('; '),
        phones: (c.phoneNumbers?.elements || []).map((x: any) => x.phoneNumber).filter(Boolean).join('; '),
        marketingAllowed: c.marketingAllowed === true,
        since: c.customerSince ? new Date(c.customerSince).toISOString().slice(0, 10) : '',
        note: c.metadata?.note || '',
      });
    }
    if (els.length < page) break;
    offset += page;
  }
  return rows;
}

// ---------- Reorder suggestions (Phase 2 brain) ----------
// Pure DEMAND forecast from historical sales — deliberately ignores the current
// (often negative/unreliable) stock count. suggested = ceil(avgPerDay * coverDays),
// where avgPerDay is averaged over a multi-month window of real Clover sales.
export async function suggestReorder(opts?: { days?: number; coverDays?: number }) {
  const days = opts?.days ?? 120;        // ~4 months of history by default
  const coverDays = opts?.coverDays ?? 3; // how many days each order should cover
  // Page through up to ~20k orders in the window for a solid average.
  const popular = await getPopular({ days, maxOrders: 20000 });
  const soldByName = new Map(popular.map((p) => [normName(p.name), p.count]));
  const out: any[] = [];
  for (const [code, cloverName] of Object.entries(ALON_MAP)) {
    const sold = soldByName.get(normName(cloverName)) || 0;
    const avgPerDay = sold / days;
    const suggested = Math.ceil(avgPerDay * coverDays);
    out.push({
      code, product: cloverName,
      soldInWindow: sold, avgPerDay: Math.round(avgPerDay * 100) / 100,
      coverDays, suggested,
    });
  }
  return { windowDays: days, coverDays, note: 'demand-based; ignores current stock count', items: out };
}

// ---------- Best sellers (from order history) ----------
export interface PopularItem { name: string; itemId?: string; count: number; revenue: number }

// Aggregate recent orders' line items to rank best-selling products by units sold + revenue.
export async function getPopular(opts?: { days?: number; maxOrders?: number }): Promise<PopularItem[]> {
  const days = opts?.days ?? 90;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const maxOrders = opts?.maxOrders ?? 1000; // one page; raise later if needed
  const agg: Record<string, { name: string; itemId?: string; count: number; revenue: number }> = {};
  let offset = 0;
  const pageSize = 1000;
  let fetched = 0;
  while (fetched < maxOrders) {
    const filter = encodeURIComponent(`createdTime>=${since}`);
    const data = await restFetch(`/orders?expand=lineItems&filter=${filter}&limit=${pageSize}&offset=${offset}`);
    const orders: any[] = data?.elements || [];
    if (!orders.length) break;
    for (const o of orders) {
      const lineItems: any[] = o.lineItems?.elements || [];
      for (const li of lineItems) {
        const name: string = li.name || 'Unknown';
        const key = name.toLowerCase().trim();
        const priceCents = typeof li.price === 'number' ? li.price : 0;
        if (!agg[key]) agg[key] = { name, itemId: li.item?.id, count: 0, revenue: 0 };
        agg[key].count += 1;
        agg[key].revenue += priceCents;
      }
    }
    fetched += orders.length;
    offset += pageSize;
    if (orders.length < pageSize) break;
  }
  return Object.values(agg)
    .map((x) => ({ name: x.name, itemId: x.itemId, count: x.count, revenue: x.revenue / 100 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
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
