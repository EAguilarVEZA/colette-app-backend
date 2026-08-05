// lib/sched.ts
// Shared storage + helpers for the crew scheduler (/scheduler app).
// State lives in Upstash Redis (Vercel Marketplace "Upstash for Redis" —
// KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/_TOKEN).
// Twilio creds are the same ones the ordering backend already uses.

import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvUrl =
  (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim();
const kvToken =
  (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

export const STATE_KEY = 'colette:sched:state';

export function kvConfigured(): boolean {
  return !!(kvUrl && kvToken);
}

export async function kvGetState(): Promise<any | null> {
  const r = await fetch(`${kvUrl}/get/${encodeURIComponent(STATE_KEY)}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });
  if (!r.ok) return null;
  const d: any = await r.json().catch(() => ({}));
  if (!d || d.result == null) return null;
  try { return JSON.parse(d.result); } catch { return null; }
}

export async function kvSetState(state: any): Promise<boolean> {
  const r = await fetch(`${kvUrl}/set/${encodeURIComponent(STATE_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kvToken}` },
    body: JSON.stringify(state),
  });
  return r.ok;
}

// ---------- auth ----------
export function isAdminReq(req: VercelRequest): boolean {
  const key = (process.env.SCHED_ADMIN_KEY || '').trim();
  if (!key) return false;
  return (req.headers['x-admin-key'] as string || '').trim() === key;
}

export function findByPin(state: any, pin: string): any | null {
  if (!/^\d{4}$/.test(pin || '')) return null;
  return (state?.employees || []).find((e: any) => e.pin && e.pin === pin) || null;
}

const digits = (p: string) => (p || '').replace(/\D/g, '');
export function findByPhone(state: any, phone: string): any | null {
  const want = digits(phone).slice(-10);
  if (want.length < 7) return null;
  return (
    (state?.employees || []).find((e: any) => {
      const have = digits(e.phone || '').slice(-10);
      return have && (have === want || want.endsWith(have) || have.endsWith(want));
    }) || null
  );
}

// Employees never receive wages, PINs, admin hash, or sales figures.
export function sanitize(state: any): any {
  const s = JSON.parse(JSON.stringify(state));
  delete s.auth;
  delete s.sales;
  (s.employees || []).forEach((e: any) => { delete e.wage; delete e.pin; });
  return s;
}

// ---------- schedule helpers (mirror the app's model) ----------
// weeks: { 'YYYY-MM-DD'(Monday) : { published, shifts:[{id,day,start,end,tpl,empId,confirmed,declined?}] } }
export function mondayKey(d: Date): string {
  const x = new Date(d);
  const dow = x.getUTCDay();
  x.setUTCDate(x.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return x.toISOString().slice(0, 10);
}

export function weekKeysFrom(now: Date, span: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < span; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + i * 7);
    keys.push(mondayKey(d));
  }
  return keys;
}

export function setConfirmed(state: any, empId: string, span: number, confirmed: boolean, declined = false): number {
  let n = 0;
  for (const k of weekKeysFrom(new Date(), span)) {
    const w = state.weeks?.[k];
    if (!w) continue;
    for (const s of w.shifts || []) {
      if (s.empId === empId) {
        s.confirmed = confirmed;
        if (declined) s.declined = true; else delete s.declined;
        n++;
      }
    }
  }
  return n;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const t12 = (t: string) => {
  const [h0, m] = t.split(':').map(Number);
  const ap = h0 >= 12 ? 'p' : 'a';
  const h = h0 % 12 || 12;
  return h + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
};

export function composeMessage(state: any, empId: string, span: number): string | null {
  const lines: string[] = [];
  let total = 0;
  for (const k of weekKeysFrom(new Date(), span)) {
    const w = state.weeks?.[k];
    if (!w) continue;
    const mine = (w.shifts || [])
      .filter((s: any) => s.empId === empId)
      .sort((a: any, b: any) => a.day - b.day || (a.start < b.start ? -1 : 1));
    if (!mine.length) continue;
    if (span > 1) lines.push(`Week of ${k.slice(5)}:`);
    for (const s of mine) {
      const dd = new Date(k + 'T12:00:00Z');
      dd.setUTCDate(dd.getUTCDate() + s.day);
      const label = dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      lines.push(`• ${DAYS[s.day]} ${label}: ${t12(s.start)}–${t12(s.end)}${s.tpl ? ' (' + s.tpl + ')' : ''}`);
      const [a1, a2] = [s.start, s.end].map((t: string) => { const [h, m] = t.split(':').map(Number); return h + m / 60; });
      total += Math.max(0, a2 - a1);
    }
  }
  if (!lines.length) return null;
  return `🥐 ${state.shopName || 'Colette French Pastries'} — your schedule:\n${lines.join('\n')}\nTotal: ${total.toFixed(1)} hrs.\nReply YES to confirm or NO if you can't make it.`;
}

// ---------- Twilio send (SMS or WhatsApp, same account) ----------
export async function sendMessage(to: string, body: string, channel: 'sms' | 'whatsapp' = 'sms') {
  const sid = process.env.TWILIO_SID, token = process.env.TWILIO_TOKEN;
  const smsFrom = process.env.TWILIO_FROM, waFrom = process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_FROM;
  if (!sid || !token) return { sent: false, reason: 'Twilio not configured (TWILIO_SID / TWILIO_TOKEN)' };
  const from = channel === 'whatsapp' ? `whatsapp:${(waFrom || '').replace(/^whatsapp:/, '')}` : smsFrom;
  if (!from) return { sent: false, reason: 'No from number (TWILIO_FROM / TWILIO_WHATSAPP_FROM)' };
  const toAddr = channel === 'whatsapp' ? `whatsapp:${to.replace(/^whatsapp:/, '')}` : to;
  const params = new URLSearchParams({ To: toAddr, From: from, Body: body });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const out: any = await r.json().catch(() => ({}));
  if (!r.ok) return { sent: false, reason: out?.message || `HTTP ${r.status}` };
  return { sent: true, sid: out.sid };
}

// ---------- shared response helpers ----------
export function cors(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

export function notConfigured(res: VercelResponse): void {
  res.status(503).json({
    ok: false,
    error: 'Shared storage not set up yet',
    fix: 'In Vercel: Storage → Create → Upstash for Redis (free), connect to this project, then redeploy.',
  });
}
