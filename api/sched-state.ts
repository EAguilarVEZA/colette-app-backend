// GET  /api/sched-state           → sanitized state (employees; no wages/PINs)
// GET  /api/sched-state (x-admin-key) → full state
// POST /api/sched-state (x-admin-key) → replace state (admin publish/sync)
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cors, isAdminReq, kvConfigured, kvGetState, kvSetState, notConfigured, sanitize } from '../lib/sched.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (!kvConfigured()) return notConfigured(res);

  if (req.method === 'POST') {
    if (!isAdminReq(req)) return res.status(401).json({ ok: false, error: 'Bad or missing x-admin-key' });
    const state = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    if (!state?.employees || !state?.weeks) return res.status(400).json({ ok: false, error: 'Not a scheduler state' });
    state.syncedAt = new Date().toISOString();
    const ok = await kvSetState(state);
    return res.status(ok ? 200 : 500).json({ ok, syncedAt: state.syncedAt });
  }

  const state = await kvGetState();
  if (!state) return res.status(404).json({ ok: false, error: 'No schedule published yet' });
  return res.status(200).json({ ok: true, state: isAdminReq(req) ? state : sanitize(state) });
}
