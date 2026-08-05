// POST /api/sched-login {pin} → {empId,name} when the PIN matches an employee.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cors, findByPin, kvConfigured, kvGetState, notConfigured } from '../lib/sched.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!kvConfigured()) return notConfigured(res);
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const state = await kvGetState();
  if (!state) return res.status(404).json({ ok: false, error: 'No schedule published yet' });
  const e = findByPin(state, String(body.pin || ''));
  if (!e) return res.status(401).json({ ok: false, error: 'PIN not recognized' });
  return res.status(200).json({ ok: true, empId: e.id, name: e.name });
}
