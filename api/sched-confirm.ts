// POST /api/sched-confirm {pin, span?} → mark that employee's shifts confirmed
// for this week (span 1) or this + next week (span 2). App and SMS both land here.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cors, findByPin, kvConfigured, kvGetState, kvSetState, notConfigured, setConfirmed } from '../lib/sched.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!kvConfigured()) return notConfigured(res);
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const state = await kvGetState();
  if (!state) return res.status(404).json({ ok: false, error: 'No schedule published yet' });
  const e = findByPin(state, String(body.pin || ''));
  if (!e) return res.status(401).json({ ok: false, error: 'PIN not recognized' });
  const span = body.span === 2 ? 2 : 1;
  const n = setConfirmed(state, e.id, span, true);
  await kvSetState(state);
  return res.status(200).json({ ok: true, confirmed: n });
}
