// POST /api/sched-punch {pin, dir:'in'|'out', lat, lng}
// Server-verified GPS time clock: must be on today's schedule, inside the
// geofence, and within the clock-in window. Punches live in shared state so
// the admin sees them instantly. Server time is authoritative.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cors, findByPin, kvConfigured, kvGetState, kvSetState, mondayKey, notConfigured } from '../lib/sched.js';

const TZ = 'America/New_York';

function localNow(): { dstr: string; minutes: number; day: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const dstr = `${get('year')}-${get('month')}-${get('day')}`;
  const minutes = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const dayMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { dstr, minutes, day: dayMap[get('weekday')] ?? 0 };
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function distM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toR = (x: number) => (x * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!kvConfigured()) return notConfigured(res);
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const state = await kvGetState();
  if (!state) return res.status(404).json({ ok: false, error: 'No schedule published yet' });
  const e = findByPin(state, String(body.pin || ''));
  if (!e) return res.status(401).json({ ok: false, error: 'PIN not recognized' });

  const dir = body.dir === 'out' ? 'out' : 'in';
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ ok: false, error: 'Missing GPS coordinates' });

  const loc = state.location || {};
  const d = Math.round(distM(lat, lng, Number(loc.lat), Number(loc.lng)));
  const radius = Number(loc.radius) || 150;
  if (d > radius) {
    const dd = d >= 1000 ? (d / 1000).toFixed(1) + ' km' : d + ' m';
    return res.status(403).json({ ok: false, error: `You're ${dd} from the store — punches only work on site`, dist: d });
  }

  const t = localNow();
  state.punches = state.punches || [];
  const open = state.punches.find((p: any) => p.empId === e.id && p.date === t.dstr && !p.out);

  if (dir === 'in') {
    if (open) return res.status(409).json({ ok: false, error: 'Already clocked in' });
    const wk = state.weeks?.[mondayKey(new Date())];
    const todays = (wk?.shifts || [])
      .filter((s: any) => s.empId === e.id && s.day === t.day)
      .sort((a: any, b: any) => (a.start < b.start ? -1 : 1));
    if (!todays.length) return res.status(403).json({ ok: false, error: "You're not on today's schedule" });
    if (t.minutes < toMin(todays[0].start) - 20)
      return res.status(403).json({ ok: false, error: `Too early — clock-in opens 20 min before your shift` });
    state.punches.push({
      id: 'p' + Date.now().toString(36), empId: e.id, date: t.dstr,
      in: new Date().toISOString(), out: null, inDist: d, outDist: null, verified: 'server',
    });
    await kvSetState(state);
    return res.status(200).json({ ok: true, dir, dist: d });
  }

  if (!open) return res.status(409).json({ ok: false, error: "You're not clocked in" });
  open.out = new Date().toISOString();
  open.outDist = d;
  await kvSetState(state);
  return res.status(200).json({ ok: true, dir, dist: d });
}
