// POST /api/sched-send (x-admin-key) {span?:1|2, channel?:'sms'|'whatsapp', empId?}
// Sends each scheduled employee their shifts via Twilio and returns per-person results.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { composeMessage, cors, isAdminReq, kvConfigured, kvGetState, kvSetState, notConfigured, sendMessage } from '../lib/sched.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!kvConfigured()) return notConfigured(res);
  if (!isAdminReq(req)) return res.status(401).json({ ok: false, error: 'Bad or missing x-admin-key' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const span = body.span === 2 ? 2 : 1;
  const channel: 'sms' | 'whatsapp' = body.channel === 'whatsapp' ? 'whatsapp' : 'sms';

  const state = await kvGetState();
  if (!state) return res.status(404).json({ ok: false, error: 'No schedule published yet — sync first' });

  const targets = (state.employees || []).filter((e: any) => (!body.empId || e.id === body.empId) && e.phone);
  const results: any[] = [];
  for (const e of targets) {
    const msg = composeMessage(state, e.id, span);
    if (!msg) { results.push({ name: e.name, sent: false, reason: 'No shifts in period' }); continue; }
    const r = await sendMessage(e.phone, msg, channel);
    results.push({ name: e.name, ...r });
  }
  state.lastSend = { at: new Date().toISOString(), span, channel, count: results.filter((r) => r.sent).length };
  await kvSetState(state);
  return res.status(200).json({ ok: true, results, lastSend: state.lastSend });
}
