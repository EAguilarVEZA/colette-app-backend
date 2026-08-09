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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-colette-secret');
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
  tracked?: boolean;   // true if we maintain a real stock count (Alon wholesale items)
  stock?: number;      // current Clover stock (only meaningful when tracked)
  soldOut?: boolean;   // tracked item at/below zero → show as sold out
}

// Pull the live menu from Clover Inventory and shape it for the app — including
// modifier groups so the website/app can offer the same options Clover knows about.
// Bulk stock read (paged) → Map of itemId -> quantity. Best-effort; returns an
// empty map if the merchant/token doesn't expose item_stocks.
export async function getAllStocks(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    let offset = 0; const page = 1000;
    for (;;) {
      const data = await restFetch(`/item_stocks?limit=${page}&offset=${offset}`);
      const els: any[] = data?.elements || [];
      for (const s of els) {
        const id = s?.item?.id;
        const qty = typeof s?.quantity === 'number' ? s.quantity
          : (typeof s?.stockCount === 'number' ? s.stockCount : undefined);
        if (id && typeof qty === 'number') map.set(id, qty);
      }
      if (els.length < page) break;
      offset += page;
    }
  } catch { /* stock not available — caller falls back to availability flag */ }
  return map;
}

export async function getMenu(opts?: { includeStock?: boolean }): Promise<{ categories: string[]; items: MenuItem[] }> {
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
  // Optionally merge real stock. We only trust stock for the wholesale items we
  // actually track (ALON_MAP) — every other item was zero-reset and its count is
  // not meaningful, so those stay always-available.
  if (opts?.includeStock) {
    const trackedNames = new Set(Object.values(ALON_MAP).map((n) => normName(n)));
    const stocks = await getAllStocks();
    for (const it of items) {
      const tracked = trackedNames.has(normName(it.name));
      it.tracked = tracked;
      if (tracked && stocks.has(it.id)) {
        const q = stocks.get(it.id)!;
        it.stock = q;
        it.soldOut = q <= 0;
      }
    }
  }
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
  discounts?: { name: string; amountCents: number }[];
  deliveryFeeCents?: number;
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
  // Flat delivery fee as a custom (non-inventory) line item so it prints on the
  // ticket and is included in Clover's authoritative order total.
  if (opts.deliveryFeeCents && opts.deliveryFeeCents > 0) {
    lineItems.push({ name: 'Delivery', price: Math.round(opts.deliveryFeeCents) } as any);
  }
  const orderCart: any = {
    orderCart: {
      lineItems,
      orderType: { label: opts.orderType || cfg.defaultOrderType },
      note: opts.note || (opts.customerName ? `App order — ${opts.customerName}` : 'App order'),
    },
  };
  // Order-level discounts (e.g. BOGO crêpe). Clover expects a negative "amount"
  // in cents; the returned order total already reflects it, so we still charge raw.total.
  if (opts.discounts && opts.discounts.length) {
    orderCart.orderCart.discounts = opts.discounts.map((d) => ({
      name: d.name,
      amount: -Math.abs(d.amountCents),
    }));
  }
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
  '109108': 'Baguette',
  '12563': 'Dubai Chocolate Mousse (individual)',
};

// Bill of materials: finished products MADE FROM an Alon item. Their Clover sales
// consume the base item, so true demand for the base = its own sales + these.
// Plain croissants become the filled/topped croissant line-up.
export const BOM: Record<string, string[]> = {
  'Plain Croissant': [
    'Dulce De Leche Croissant', 'Apricot Croissant', 'Latte E Nocciola Croissant',
    'Nutella Croissant', 'Ham/Cheese Croissant', 'Pistachio Croissant',
  ],
  'Baguette': ['Ham/Cheese baguette'], // baguettes go into sandwiches or sold whole
};

// BASELINE — Colette's proven per-day standing order (read from the placed Alon
// orders 2026-08-02; Tue = Wed = Sat identical → treated as a flat daily order).
// Keyed by Alon code. Used as the ANCHOR/floor for the recommendation so we never
// order below what's proven to work; sales/BOM add upside, the waste model trims.
export const DAILY_BASELINE: Record<string, number> = {
  '7152': 6, '7153': 3, '109108': 4, '7184': 3, '7156': 3, '7160': 8, '7163': 2,
  '7164': 2, '12563': 4, '19347': 2, '795': 2, '4111': 2, '7171': 28,
  '999997': 5, '999995': 5, '7176': 5, '0192': 5,
};

const normName = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Ingredient items ordered on a fixed CADENCE (not sales-derivable yet).
// byDow = units per delivery weekday (0=Sun … 6=Sat). Tunable.
//  - Ciabatta 5oz: weekly sandwich-prep batch on Tuesday → 25 on Tue.
export const INGREDIENTS: { code: string; product: string; byDow: number[] }[] = [
  { code: '5509151', product: 'Ciabatta, 5oz', byDow: [0, 0, 25, 0, 0, 0, 0] }, // Tue sandwich prep (25/wk)
];

// DERIVED ingredients — sized from actual sales of the finished items they go into.
// Sourdough boule: from Salmon + Avocado Toast; ~10 toasts per boule (tune yield).
export const DERIVED_INGREDIENTS: { code: string; product: string; sources: string[]; perUnit: number }[] = [
  { code: '109132', product: 'Sourdough 1.5# Boule', sources: ['Salmon Toast', 'Avocado Toast'], perUnit: 10 },
];

// Alon wholesale unit COSTS (dollars) captured from the FlexiBake order form.
// Keyed by Clover item name so we can write them into Clover's cost field.
export const ALON_COST: Record<string, number> = {
  'Almond Croissant': 2.39, 'Apple Vanilla Danish': 2.39, 'Blueberry Muffin': 2.07,
  'Cheese Danish': 2.39, 'Chocolate Croissant': 2.39, 'Scone': 2.39,
  'Gruyere Sesame Twist': 2.39, 'Hazelnut Chocolate Danish': 2.39, 'Kouign Amann': 3.09,
  'Plain Croissant': 2.24, 'Mushroom And Fontina Cheese Quiche': 4.66,
  'Spinach And Butternut Squash': 4.66, 'Raspberry Cheese Danish': 2.39,
  'Twice-Baked Almond Croissant': 4.24, 'Baguette': 3.00,
  'Dubai Chocolate Mousse (individual)': 4.84,
};

// Price fixes (dollars) — items mispriced in Clover. Scone was $0 (losing money);
// $7.95 gives ~70% margin on the $2.39 Alon cost (matches Gruyère Twist).
export const PRICE_FIX: Record<string, number> = {
  'Scone': 7.95,
};

// Write sell prices into Clover's item.price field (cents). Matches by name.
export async function setItemPrices(prices?: Record<string, number>): Promise<any[]> {
  const map = prices || PRICE_FIX;
  const items = await listItems();
  const byName = new Map(items.map((i) => [normName(i.name), i]));
  const results: any[] = [];
  for (const [name, dollars] of Object.entries(map)) {
    const it = byName.get(normName(name));
    if (!it) { results.push({ name, matched: false }); continue; }
    const cents = Math.round(dollars * 100);
    try {
      await restFetch(`/items/${it.id}`, { method: 'POST', body: JSON.stringify({ price: cents }) });
      results.push({ name, itemId: it.id, priceCents: cents, matched: true });
    } catch (e: any) {
      results.push({ name, itemId: it.id, error: e?.body ?? String(e) });
    }
  }
  return results;
}

// Write unit costs into Clover's item.cost field (cents). Uses ALON_COST unless
// an explicit map is passed. Matches by normalized item name.
export async function setItemCosts(costs?: Record<string, number>): Promise<any[]> {
  const map = costs || ALON_COST;
  const items = await listItems();
  const byName = new Map(items.map((i) => [normName(i.name), i]));
  const results: any[] = [];
  for (const [name, dollars] of Object.entries(map)) {
    const it = byName.get(normName(name));
    if (!it) { results.push({ name, matched: false }); continue; }
    const cents = Math.round(dollars * 100);
    try {
      await restFetch(`/items/${it.id}`, { method: 'POST', body: JSON.stringify({ cost: cents }) });
      results.push({ name, itemId: it.id, costCents: cents, matched: true });
    } catch (e: any) {
      results.push({ name, itemId: it.id, error: e?.body ?? String(e) });
    }
  }
  return results;
}

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

// ---------- BOGO crêpe tripwire (one redemption per customer) ----------
export const BOGO_CODE = 'COLETTEBOGO';
const BOGO_MARK = 'BOGO_REDEEMED';

// Find a customer (with metadata note) by email/phone — used to check/mark BOGO.
export async function findCustomerWithNote(email?: string, phone?: string): Promise<any | null> {
  const e = (email || '').trim().toLowerCase();
  const p = digits(phone).slice(-10);
  if (!e && !p) return null;
  const data = await restFetch('/customers?expand=emailAddresses,phoneNumbers,metadata&limit=1000');
  const list: any[] = data?.elements || [];
  for (const c of list) {
    const emails = (c.emailAddresses?.elements || []).map((x: any) => (x.emailAddress || '').trim().toLowerCase());
    const phones = (c.phoneNumbers?.elements || []).map((x: any) => digits(x.phoneNumber).slice(-10));
    if (e && emails.includes(e)) return c;
    if (p && phones.includes(p)) return c;
  }
  return null;
}

export function hasRedeemedBogo(customer: any): boolean {
  const note = customer?.metadata?.note || '';
  return note.includes(BOGO_MARK);
}

// Stamp the customer's note so the BOGO can't be redeemed twice. Creates a
// minimal customer record if none exists yet (so enforcement holds going forward).
export async function markBogoRedeemed(opts: { customerId?: string; email?: string; phone?: string }): Promise<void> {
  const stamp = `${BOGO_MARK}=Y at=${new Date().toISOString()}`;
  if (opts.customerId) {
    // Preserve any existing note.
    let prior = '';
    try { const c = await restFetch(`/customers/${opts.customerId}?expand=metadata`); prior = c?.metadata?.note || ''; } catch { /* ignore */ }
    const note = prior ? `${prior} · ${stamp}` : stamp;
    await restFetch(`/customers/${opts.customerId}`, { method: 'POST', body: JSON.stringify({ metadata: { note } }) });
    return;
  }
  // No record yet — create one flagged as redeemed.
  const body: any = { firstName: 'Web', metadata: { note: stamp } };
  if (opts.email) body.emailAddresses = [{ emailAddress: opts.email.trim() }];
  if (opts.phone) body.phoneNumbers = [{ phoneNumber: opts.phone.trim() }];
  await restFetch('/customers', { method: 'POST', body: JSON.stringify(body) });
}

// Identify crêpe items in the current cart and return the cheapest crêpe's unit
// price (cents). That amount becomes the "buy one get one free" discount.
export async function crepeDiscountForCart(lines: CartLine[]): Promise<number> {
  const { items } = await getMenu();
  const byId = new Map(items.map((i) => [i.id, i]));
  const isCrepe = (name?: string) => /cr[eê]pe/i.test(name || '');
  let cheapest = 0;
  let crepeUnits = 0;
  for (const l of lines) {
    const it = byId.get(l.itemId);
    if (it && isCrepe(it.name)) {
      crepeUnits += Math.max(1, l.quantity);
      if (it.priceCents > 0 && (cheapest === 0 || it.priceCents < cheapest)) cheapest = it.priceCents;
    }
  }
  // Need at least 2 crêpes in the cart (buy one, get one free).
  return crepeUnits >= 2 ? cheapest : 0;
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

// ---------- Reorder suggestions (Phase 2 brain) — BY DAY OF WEEK ----------
// Bread is daily & perishable; the bakery is closed Mondays and takes a delivery
// every other day. So we forecast each product's demand for a SPECIFIC weekday
// from a full year of history (avg units sold on past Tuesdays for a Tuesday
// order, etc.) and order exactly that — one day at a time. Ignores stock counts.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const etWeekday = (ms: number) =>
  DOW.indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(ms)));
const etDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// Aggregate line-item units by product AND weekday over the window, plus how many
// distinct operating dates fell on each weekday (the denominator for the average).
export async function getWeekdaySales(opts?: { days?: number; maxOrders?: number }) {
  const days = opts?.days ?? 365;
  const maxOrders = opts?.maxOrders ?? 40000;
  const since = Date.now() - days * 86400000;
  const unitsByName = new Map<string, number[]>();       // normName -> units[7]
  const datesByDow: Set<string>[] = Array.from({ length: 7 }, () => new Set());
  let offset = 0; const pageSize = 1000; let fetched = 0;
  while (fetched < maxOrders) {
    const filter = encodeURIComponent(`createdTime>=${since}`);
    const data = await restFetch(`/orders?expand=lineItems&filter=${filter}&limit=${pageSize}&offset=${offset}`);
    const orders: any[] = data?.elements || [];
    if (!orders.length) break;
    for (const o of orders) {
      const t = o.createdTime; if (!t) continue;
      const dow = etWeekday(t); if (dow < 0) continue;
      datesByDow[dow].add(etDate(t));
      for (const li of (o.lineItems?.elements || [])) {
        const key = normName(li.name || ''); if (!key) continue;
        if (!unitsByName.has(key)) unitsByName.set(key, [0, 0, 0, 0, 0, 0, 0]);
        unitsByName.get(key)![dow] += 1;
      }
    }
    fetched += orders.length; offset += pageSize;
    if (orders.length < pageSize) break;
  }
  return { unitsByName, dowCounts: datesByDow.map((s) => s.size), days };
}

// Suggest the order for a given weekday (default = today, ET). Returns the full
// weekly pattern per product plus the number to order for the target day.
export async function suggestReorder(opts?: { days?: number; dow?: number }) {
  const days = opts?.days ?? 365;
  const { unitsByName, dowCounts } = await getWeekdaySales({ days });
  const today = etWeekday(Date.now());
  const targetDow = (typeof opts?.dow === 'number' && opts.dow >= 0 && opts.dow <= 6) ? opts.dow : today;
  const out: any[] = [];
  for (const [code, cloverName] of Object.entries(ALON_MAP)) {
    const arr = unitsByName.get(normName(cloverName)) || [0, 0, 0, 0, 0, 0, 0];
    const byDay: Record<string, number> = {};
    DOW.forEach((n, i) => { byDay[n] = dowCounts[i] ? Math.round((arr[i] / dowCounts[i]) * 100) / 100 : 0; });
    const avgTarget = dowCounts[targetDow] ? arr[targetDow] / dowCounts[targetDow] : 0;
    out.push({ code, product: cloverName, byDay, suggested: Math.round(avgTarget) });
  }
  return { historyDays: days, orderForDay: DOW[targetDow], note: 'per-weekday demand from ~1yr history; closed Mondays; ignores stock count', items: out };
}

// ---------- Smart reorder (trend + full-year weekday + year-over-year + buffer) ----------
// Blends three signals for each Alon item on a target weekday:
//   recent trend (last ~6 same weekdays) 50% · full-year weekday avg 30% · year-ago same weekday 20%
// then adds a safety buffer and rounds up. Fresh-daily bread that sells out is lost revenue,
// so we bias slightly high. Returns the breakdown per item for transparency in the UI.
export async function suggestReorderSmart(opts?: { dow?: number; buffer?: number; days?: number }) {
  const days = opts?.days ?? 365;
  const buffer = typeof opts?.buffer === 'number' ? opts.buffer : 0.15;
  const since = Date.now() - days * 86400000;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const codeFor = (name: string) => Object.entries(ALON_MAP).find(([, v]) => v === name)?.[0] || '';
  const trackedNames = new Map<string, string>(); // normName -> Clover display name
  for (const name of Object.values(ALON_MAP)) trackedNames.set(normName(name), name);
  const perProduct = new Map<string, Map<string, number>>(); // normName -> (etDate -> units)
  for (const k of trackedNames.keys()) perProduct.set(k, new Map());
  // Also bucket BOM sources (finished products made from a base item) and derived-
  // ingredient sources (toast → sourdough), so true demand includes them.
  for (const srcs of Object.values(BOM)) for (const s of srcs) if (!perProduct.has(normName(s))) perProduct.set(normName(s), new Map());
  for (const di of DERIVED_INGREDIENTS) for (const s of di.sources) if (!perProduct.has(normName(s))) perProduct.set(normName(s), new Map());
  const datesByDow: Set<string>[] = Array.from({ length: 7 }, () => new Set());

  let offset = 0; const pageSize = 1000; let fetched = 0; const maxOrders = 40000;
  while (fetched < maxOrders) {
    const filter = encodeURIComponent(`createdTime>=${since}`);
    const data = await restFetch(`/orders?expand=lineItems&filter=${filter}&limit=${pageSize}&offset=${offset}`);
    const orders: any[] = data?.elements || [];
    if (!orders.length) break;
    for (const o of orders) {
      const t = o.createdTime; if (!t) continue;
      const dow = etWeekday(t); if (dow < 0) continue;
      const d = etDate(t);
      datesByDow[dow].add(d);
      for (const li of (o.lineItems?.elements || [])) {
        const key = normName(li.name || '');
        const m = perProduct.get(key); if (!m) continue;
        m.set(d, (m.get(d) || 0) + 1);
      }
    }
    fetched += orders.length; offset += pageSize;
    if (orders.length < pageSize) break;
  }

  const today = etWeekday(Date.now());
  const targetDow = (typeof opts?.dow === 'number' && opts.dow >= 0 && opts.dow <= 6) ? opts.dow : today;
  const dates = [...datesByDow[targetDow]].sort();       // ascending YYYY-MM-DD
  const recentDates = dates.slice(-6);
  const yoyTargetDate = etDate(Date.now() - 364 * 86400000);
  let yoyDate: string | null = null; let best = Infinity;
  for (const d of dates) { const diff = Math.abs(Date.parse(d) - Date.parse(yoyTargetDate)); if (diff < best) { best = diff; yoyDate = d; } }

  // Demand series for a base item = its own sales + any BOM sources made from it.
  const seriesFor = (name: string) => {
    const base = perProduct.get(normName(name)) || new Map<string, number>();
    const srcKeys = (BOM[name] || []).map(normName);
    return (d: string) => {
      let v = base.get(d) || 0;
      for (const sk of srcKeys) v += perProduct.get(sk)?.get(d) || 0;
      return v;
    };
  };
  const blend = (on: (d: string) => number) => {
    const recent = recentDates.length ? recentDates.reduce((s, d) => s + on(d), 0) / recentDates.length : 0;
    const yearAvg = dates.length ? dates.reduce((s, d) => s + on(d), 0) / dates.length : 0;
    const yoy = yoyDate ? on(yoyDate) : 0;
    // Demand variability on this weekday → safety stock (newsvendor: high-margin
    // bakery items favor availability, so a ~85% service level, z≈1.04).
    const vals = dates.map(on);
    const mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    const std = vals.length ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) : 0;
    return { recent, yearAvg, yoy, std, blended: 0.5 * recent + 0.3 * yearAvg + 0.2 * yoy };
  };
  const Z = 1.04; // ~85% service level — margins are 60–70%, so bias toward not selling out

  const items: any[] = [...trackedNames].map(([, name]) => {
    const code = codeFor(name);
    const b = blend(seriesFor(name));
    // Newsvendor safety stock = z·σ (waste-aware): volatile items get more cushion,
    // steady items less — instead of a flat % buffer on everything.
    const salesCeil = Math.max(0, Math.ceil(b.blended + Z * b.std));
    const baseline = DAILY_BASELINE[code];
    // Anchor on the proven baseline (floor); let sales+safety bump it up when growing.
    const suggested = baseline != null ? Math.max(baseline, salesCeil) : salesCeil;
    return {
      code, product: name,
      recent: round2(b.recent), yearAvg: round2(b.yearAvg), yoy: b.yoy, blended: round2(b.blended), std: round2(b.std),
      baseline: baseline ?? '—', sales: salesCeil, suggested,
      ...(BOM[name] ? { madeInto: BOM[name] } : {}),
    };
  });

  // Derived ingredients (e.g., sourdough boule from Salmon + Avocado Toast sales).
  for (const di of DERIVED_INGREDIENTS) {
    const on = (d: string) => di.sources.reduce((s, src) => s + (perProduct.get(normName(src))?.get(d) || 0), 0);
    const b = blend(on);
    const need = b.blended + Z * b.std; // toasts needed (demand + safety)
    items.push({
      code: di.code, product: di.product,
      recent: round2(b.recent), yearAvg: round2(b.yearAvg), yoy: b.yoy, blended: round2(b.blended), std: round2(b.std),
      suggested: need > 0 ? Math.max(1, Math.ceil(need / di.perUnit)) : 0,
      derivedFrom: di.sources, perUnit: di.perUnit,
    });
  }

  // Fixed-cadence ingredients (e.g., ciabatta 25 on Tuesdays).
  for (const ing of INGREDIENTS) {
    const q = ing.byDow[targetDow] || 0;
    if (q > 0) items.push({ code: ing.code, product: ing.product, recent: '—', yearAvg: '—', yoy: '—', blended: '—', suggested: q, cadence: true });
  }

  items.sort((a, b) => b.suggested - a.suggested);
  return {
    orderForDay: DOW[targetDow], historyDays: days, buffer,
    recentDatesUsed: recentDates, yearAgoDate: yoyDate,
    note: 'Anchored on your proven baseline (floor); demand = 50% recent weekday · 30% year weekday · 20% year-ago + newsvendor safety stock (z·σ, ~85% service level). Base items include products made from them (BOM), e.g. Plain Croissant + its 6 variants; Baguette + sandwiches; Sourdough from toast.',
    items,
  };
}

// ---------- Sales summary (for the growth dashboard / daily brief) ----------
// Daily revenue + order count + AOV over a window, plus new-vs-repeat customers.
export async function salesSummary(opts?: { days?: number; maxOrders?: number }) {
  const days = opts?.days ?? 35;
  const maxOrders = opts?.maxOrders ?? 20000;
  const since = Date.now() - days * 86400000;
  const byDate = new Map<string, { revenue: number; orders: number }>(); // etDate -> cents/orders
  const custOrders = new Map<string, number>();  // customerId -> order count in window
  let totalRevenue = 0, totalOrders = 0;
  let offset = 0; const pageSize = 1000; let fetched = 0;
  while (fetched < maxOrders) {
    const filter = encodeURIComponent(`createdTime>=${since}`);
    const data = await restFetch(`/orders?expand=customers&filter=${filter}&limit=${pageSize}&offset=${offset}`);
    const orders: any[] = data?.elements || [];
    if (!orders.length) break;
    for (const o of orders) {
      const t = o.createdTime; if (!t) continue;
      const d = etDate(t);
      const cents = typeof o.total === 'number' ? o.total : 0;
      const cur = byDate.get(d) || { revenue: 0, orders: 0 };
      cur.revenue += cents; cur.orders += 1; byDate.set(d, cur);
      totalRevenue += cents; totalOrders += 1;
      const cid = o.customers?.elements?.[0]?.id;
      if (cid) custOrders.set(cid, (custOrders.get(cid) || 0) + 1);
    }
    fetched += orders.length; offset += pageSize;
    if (orders.length < pageSize) break;
  }
  const daily = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, v]) => ({ date, revenue: Math.round(v.revenue) / 100, orders: v.orders }));
  const repeatCustomers = [...custOrders.values()].filter((n) => n > 1).length;
  const knownCustomers = custOrders.size;
  return {
    days, totalRevenue: Math.round(totalRevenue) / 100, totalOrders,
    aov: totalOrders ? Math.round((totalRevenue / totalOrders)) / 100 : 0,
    daily, knownCustomers, repeatCustomers,
    repeatRate: knownCustomers ? Math.round((repeatCustomers / knownCustomers) * 1000) / 10 : 0,
    monthlyGoal: 100000,
  };
}

// ---------- Stockout / lost-sales analysis ----------
// Heuristic from order timestamps: for each product-day, find the last time it sold
// vs. the store's last sale that day. If a product consistently STOPS selling well
// before the store closes (while other items keep selling), it likely ran out —
// a signal to stock more. Strongest for weekends. Going forward, real Clover stock
// (from the daily sync) confirms true stockouts; this reconstructs history.
export async function stockoutAnalysis(opts?: { days?: number; gapMinutes?: number }) {
  const days = opts?.days ?? 120;
  const gapMin = opts?.gapMinutes ?? 90;
  const since = Date.now() - days * 86400000;
  const prod = new Map<string, Map<string, { units: number; lastMs: number }>>();
  const dayLast = new Map<string, number>();   // etDate -> store's last sale ms
  const display = new Map<string, string>();
  let offset = 0; const pageSize = 1000; let fetched = 0; const maxOrders = 30000;
  while (fetched < maxOrders) {
    const filter = encodeURIComponent(`createdTime>=${since}`);
    const data = await restFetch(`/orders?expand=lineItems&filter=${filter}&limit=${pageSize}&offset=${offset}`);
    const orders: any[] = data?.elements || [];
    if (!orders.length) break;
    for (const o of orders) {
      const t = o.createdTime; if (!t) continue;
      const d = etDate(t);
      dayLast.set(d, Math.max(dayLast.get(d) || 0, t));
      for (const li of (o.lineItems?.elements || [])) {
        const key = normName(li.name || ''); if (!key) continue;
        display.set(key, li.name);
        if (!prod.has(key)) prod.set(key, new Map());
        const m = prod.get(key)!; const cur = m.get(d) || { units: 0, lastMs: 0 };
        cur.units += 1; cur.lastMs = Math.max(cur.lastMs, t); m.set(d, cur);
      }
    }
    fetched += orders.length; offset += pageSize;
    if (orders.length < pageSize) break;
  }
  const hourET = (ms: number) => {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    const [h, mi] = s.split(':').map(Number); return h + mi / 60;
  };
  const items: any[] = [];
  for (const [key, m] of prod) {
    let daysActive = 0, soldout = 0, unitsSum = 0, hourSum = 0, wkDays = 0, wkSoldout = 0;
    for (const [d, rec] of m) {
      daysActive++; unitsSum += rec.units; hourSum += hourET(rec.lastMs);
      const dl = dayLast.get(d) || rec.lastMs;
      const gap = (dl - rec.lastMs) / 60000;
      const weekend = [0, 6].includes(new Date(d + 'T12:00:00').getDay());
      if (weekend) wkDays++;
      if (gap >= gapMin && rec.units >= 3) { soldout++; if (weekend) wkSoldout++; }
    }
    if (daysActive < 5) continue;
    items.push({
      product: display.get(key), daysActive,
      avgUnitsPerDay: Math.round((unitsSum / daysActive) * 10) / 10,
      avgLastSaleHour: Math.round((hourSum / daysActive) * 10) / 10,
      soldoutRate: Math.round((soldout / daysActive) * 100),
      weekendSoldoutRate: wkDays ? Math.round((wkSoldout / wkDays) * 100) : 0,
    });
  }
  items.sort((a, b) => (b.soldoutRate + b.weekendSoldoutRate) - (a.soldoutRate + a.weekendSoldoutRate));
  return {
    days, gapMinutes: gapMin,
    note: 'soldoutRate = % of active days a product stopped selling ≥' + gapMin + 'min before the store\'s last sale (proxy for running out). High rate + high avgUnits + early avgLastSaleHour = candidate to stock more.',
    items: items.slice(0, 40),
  };
}

// ---------- Live orders (for the override / adjustment tab) ----------
// Recent orders with line items + customer contact, flagging any line whose item
// is currently sold out (tracked stock <= 0). PII → serve only behind the secret.
export async function getRecentOrders(opts?: { days?: number; limit?: number }) {
  const days = opts?.days ?? 3;
  const limit = opts?.limit ?? 60;
  const since = Date.now() - days * 86400000;
  const filter = encodeURIComponent(`createdTime>=${since}`);
  const data = await restFetch(`/orders?expand=lineItems,customers&filter=${filter}&limit=${limit}`);
  const orders: any[] = data?.elements || [];
  // Which tracked items are sold out right now?
  const soldOut = new Set<string>();
  try {
    const [stocks, items] = await Promise.all([getAllStocks(), listItems()]);
    const byId = new Map(items.map((i) => [i.id, i]));
    const tracked = new Set(Object.values(ALON_MAP).map((n) => normName(n)));
    for (const [id, q] of stocks) { const it = byId.get(id); if (it && tracked.has(normName(it.name)) && q <= 0) soldOut.add(normName(it.name)); }
  } catch { /* stock optional */ }
  const rows = orders.map((o) => {
    const c = o.customers?.elements?.[0] || {};
    const customer = [c.firstName, c.lastName].filter(Boolean).join(' ') || '';
    const phone = c.phoneNumbers?.elements?.[0]?.phoneNumber || '';
    const email = c.emailAddresses?.elements?.[0]?.emailAddress || '';
    const lines = (o.lineItems?.elements || []).map((li: any) => ({ name: li.name, soldOut: soldOut.has(normName(li.name || '')) }));
    return { id: o.id, createdTime: o.createdTime, total: (o.total || 0) / 100, note: o.note || '', orderType: o.orderType?.label || '', customer, phone, email, lines, hasSoldOut: lines.some((l: any) => l.soldOut) };
  });
  rows.sort((a, b) => (b.createdTime || 0) - (a.createdTime || 0));
  return rows;
}

// Send a customer SMS (staff-initiated from the override tab). Uses Twilio when
// configured; otherwise returns a not-configured flag so the UI can offer copy-to-send.
export async function notifyCustomer(phone: string, message: string) {
  const sid = process.env.TWILIO_SID, token = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { sent: false, reason: 'SMS not configured (set TWILIO_SID / TWILIO_TOKEN / TWILIO_FROM)' };
  if (!phone) return { sent: false, reason: 'No phone on file for this customer' };
  const body = new URLSearchParams({ To: phone, From: from, Body: message });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const out: any = await r.json().catch(() => ({}));
  if (!r.ok) return { sent: false, reason: out?.message || `HTTP ${r.status}` };
  return { sent: true, sid: out.sid };
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

// ================== Supplier order submissions (staff → owner) ==================
// A store employee fills the supplier order sheet and submits it with their PIN.
// We notify the owner (SMS + email) with a one-tap deep link that pre-fills the
// quantities so the owner can place each supplier order. Pending orders are kept
// in Vercel KV (Upstash REST) so the dashboard can list them — with graceful
// no-op fallback when KV isn't configured (SMS / email / link still work).

const SITE_URL = process.env.SITE_URL || 'https://colette-website.vercel.app';

// PIN → employee name. Configure via env EMPLOYEE_PINS = {"1234":"Maria",...}.
// Before PINs are configured we accept any 3–8 digit PIN so the flow still works.
export function employeeForPin(pin: string): string | null {
  const raw = (pin || '').trim();
  if (!raw) return null;
  let map: Record<string, string> = {};
  try { map = JSON.parse(process.env.EMPLOYEE_PINS || '{}'); } catch { map = {}; }
  if (map[raw]) return map[raw];
  if (Object.keys(map).length === 0 && /^\d{3,8}$/.test(raw)) return `Staff · PIN ${raw}`;
  return null;
}

// ---- Pending-order storage. Works with either flavor of Redis:
//   • HTTP/REST (Vercel KV / Upstash):  KV_REST_API_URL + KV_REST_API_TOKEN
//   • Standard connection (Official Redis for Vercel): REDIS_URL
// No-ops when neither is configured (SMS/email/link still work).
async function kvREST(cmd: (string | number)[]): Promise<{ ok: boolean; result?: any }> {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false };
  try {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const out: any = await r.json().catch(() => ({}));
    return { ok: r.ok, result: out?.result ?? null };
  } catch { return { ok: false }; }
}
// Standard Redis (TCP/TLS) via REDIS_URL — the free "Official Redis for Vercel".
// Lazy singleton; ioredis is imported only when a REDIS_URL is present.
let _redis: any = null;
async function redisTCP(): Promise<any> {
  const url = process.env.KV_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL || process.env.REDIS_TLS_URL;
  if (!url) return null;
  if (!_redis) {
    // @ts-ignore — ioredis is installed on Vercel via package.json (not in local typecheck)
    try { const mod: any = await import('ioredis'); const Redis = mod.default || mod; _redis = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: false }); }
    catch { _redis = null; }
  }
  return _redis;
}
const PENDING_KEY = 'colette:pending_orders';

export interface PendingOrder {
  id: string; employee: string; at: number;
  counts: { costco: number; rd: number; ic: number };
  totalItems: number; link: string;
  orders: { c: Record<string, number>; r: Record<string, number>; i: Record<string, number> };
}

function b64url(obj: any): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function buildOrderLink(payload: any): string {
  return `${SITE_URL}/supplier-order.html?load=${b64url(payload)}`;
}

export async function savePendingOrder(o: PendingOrder): Promise<void> {
  const s = JSON.stringify(o);
  const r = await kvREST(['LPUSH', PENDING_KEY, s]);
  if (r.ok) { await kvREST(['LTRIM', PENDING_KEY, 0, 24]); return; }
  const c = await redisTCP(); if (!c) return;
  try { await c.lpush(PENDING_KEY, s); await c.ltrim(PENDING_KEY, 0, 24); } catch { /* best effort */ }
}
export async function listPendingOrders(): Promise<PendingOrder[]> {
  let arr: any = null;
  const r = await kvREST(['LRANGE', PENDING_KEY, 0, 24]);
  if (r.ok) arr = r.result;
  else { const c = await redisTCP(); if (c) { try { arr = await c.lrange(PENDING_KEY, 0, 24); } catch { arr = null; } } }
  if (!Array.isArray(arr)) return [];
  return arr.map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}
export async function resolvePendingOrder(id: string): Promise<void> {
  const keep = (await listPendingOrders()).filter((o) => o.id !== id);
  const del = await kvREST(['DEL', PENDING_KEY]);
  if (del.ok) { for (let k = keep.length - 1; k >= 0; k--) await kvREST(['LPUSH', PENDING_KEY, JSON.stringify(keep[k])]); return; }
  const c = await redisTCP(); if (!c) return;
  try { await c.del(PENDING_KEY); for (let k = keep.length - 1; k >= 0; k--) await c.lpush(PENDING_KEY, JSON.stringify(keep[k])); } catch { /* best effort */ }
}

// ---- Owner notification: SMS (Twilio) + email (Resend). Both best-effort. ----
export async function notifyOwner(opts: { sms?: string; emailSubject?: string; emailHtml?: string }) {
  const results: any = {};
  const to = process.env.OWNER_PHONE;
  const sid = process.env.TWILIO_SID, token = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (opts.sms && to && sid && token && from) {
    try {
      const body = new URLSearchParams({ To: to, From: from, Body: opts.sms });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      results.sms = r.ok ? 'sent' : `err ${r.status}`;
    } catch { results.sms = 'err'; }
  } else results.sms = 'skipped';
  const rk = process.env.RESEND_API_KEY, efrom = process.env.EMAIL_FROM, eto = process.env.OWNER_EMAIL;
  if (opts.emailHtml && rk && efrom && eto) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${rk}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: efrom, to: eto, subject: opts.emailSubject || 'New supplier order', html: opts.emailHtml }),
      });
      results.email = r.ok ? 'sent' : `err ${r.status}`;
    } catch { results.email = 'err'; }
  } else results.email = 'skipped';
  return results;
}

// ================== Team management (admin screen → Redis) ==================
const TEAM_KEY = 'colette:team';
export interface TeamMember { name: string; phone?: string; pin: string; rate?: number }

export async function getTeam(): Promise<TeamMember[]> {
  const r = await kvREST(['GET', TEAM_KEY]);
  if (r.ok) { try { return r.result ? JSON.parse(r.result) : []; } catch { return []; } }
  const c = await redisTCP(); if (c) { try { const v = await c.get(TEAM_KEY); return v ? JSON.parse(v) : []; } catch { return []; } }
  return [];
}
export async function saveTeam(team: TeamMember[]): Promise<void> {
  const s = JSON.stringify(Array.isArray(team) ? team : []);
  const r = await kvREST(['SET', TEAM_KEY, s]);
  if (r.ok) return;
  const c = await redisTCP(); if (c) { try { await c.set(TEAM_KEY, s); } catch { /* best effort */ } }
}
// PIN → employee name: Redis team first, then EMPLOYEE_PINS env, then a first-run
// fallback (any 3–8 digits) only when nothing is configured yet.
export async function employeeForPinAsync(pin: string): Promise<string | null> {
  const raw = (pin || '').trim(); if (!raw) return null;
  let team: TeamMember[] = [];
  try { team = await getTeam(); } catch { team = []; }
  const m = team.find((x) => String(x.pin).trim() === raw);
  if (m) return m.name || ('Staff ' + raw);
  let map: Record<string, string> = {};
  try { map = JSON.parse(process.env.EMPLOYEE_PINS || '{}'); } catch { map = {}; }
  if (map[raw]) return map[raw];
  if (team.length === 0 && Object.keys(map).length === 0 && /^\d{3,8}$/.test(raw)) return `Staff · PIN ${raw}`;
  return null;
}

// ================== Time clock (punches) → Redis ==================
const PUNCH_KEY = 'colette:punches';
export interface Punch { id: string; pin: string; name: string; type: 'in' | 'out'; at: number }

export async function listPunches(): Promise<Punch[]> {
  const r = await kvREST(['LRANGE', PUNCH_KEY, 0, 4000]);
  let arr: any = null;
  if (r.ok) arr = r.result;
  else { const c = await redisTCP(); if (c) { try { arr = await c.lrange(PUNCH_KEY, 0, 4000); } catch { arr = null; } } }
  if (!Array.isArray(arr)) return [];
  return arr.map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}
async function addPunch(p: Punch): Promise<void> {
  const s = JSON.stringify(p);
  const r = await kvREST(['LPUSH', PUNCH_KEY, s]);
  if (r.ok) { await kvREST(['LTRIM', PUNCH_KEY, 0, 5000]); return; }
  const c = await redisTCP(); if (c) { try { await c.lpush(PUNCH_KEY, s); await c.ltrim(PUNCH_KEY, 0, 5000); } catch { /* best effort */ } }
}
// Toggle clock in/out for a PIN. Returns null if the PIN isn't a known employee.
export async function togglePunch(pin: string): Promise<{ name: string; type: 'in' | 'out'; at: number } | null> {
  const name = await employeeForPinAsync(pin); if (!name) return null;
  const events = await listPunches(); // newest-first
  const last = events.find((e) => String(e.pin) === String(pin));
  const type: 'in' | 'out' = (last && last.type === 'in') ? 'out' : 'in';
  const at = Date.now();
  await addPunch({ id: at.toString(36) + Math.random().toString(36).slice(2, 6), pin: String(pin), name, type, at });
  return { name, type, at };
}
export async function clockStatus(pin: string): Promise<{ name: string | null; clockedIn: boolean; since: number | null }> {
  const name = await employeeForPinAsync(pin);
  const events = await listPunches();
  const last = events.find((e) => String(e.pin) === String(pin));
  const clockedIn = !!(last && last.type === 'in');
  return { name, clockedIn, since: clockedIn ? last!.at : null };
}
