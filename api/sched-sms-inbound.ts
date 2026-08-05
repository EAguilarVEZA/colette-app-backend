// POST /api/sched-sms-inbound — Twilio webhook for replies (SMS and WhatsApp both
// arrive here; WhatsApp numbers come prefixed "whatsapp:+1..."). Point the Twilio
// number's "A message comes in" webhook at this URL.
//   YES / Y / SI / 👍  → confirm the employee's shifts (this week + next)
//   NO / N / CANT      → mark shifts declined so the admin sees amber flags
//   anything else      → saved as a note for the admin
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findByPhone, kvConfigured, kvGetState, kvSetState, setConfirmed } from '../lib/sched.js';

function twiml(res: VercelResponse, msg: string) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  if (!kvConfigured()) return twiml(res, 'Scheduler storage is not set up yet — tell the admin.');

  const body: any = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body)) : (req.body || {});
  const from = String(body.From || '').replace(/^whatsapp:/, '');
  const text = String(body.Body || '').trim().toUpperCase();

  const state = await kvGetState();
  if (!state) return twiml(res, 'No schedule is published yet.');
  const e = findByPhone(state, from);
  if (!e) return twiml(res, `This number isn't on the ${state.shopName || 'Colette'} crew list — ask the admin to add it.`);

  const yes = /^(YES|Y|SI|SÍ|OK|👍|CONFIRM)/.test(text);
  const no = /^(NO|N|CANT|CAN'T|❌)/.test(text);

  if (yes) {
    const n = setConfirmed(state, e.id, 2, true);
    await kvSetState(state);
    return twiml(res, `Thanks ${e.name}! ${n} shift${n === 1 ? '' : 's'} confirmed. See you at the bakery ☕`);
  }
  if (no) {
    const n = setConfirmed(state, e.id, 2, false, true);
    await kvSetState(state);
    return twiml(res, `Got it ${e.name} — flagged ${n} shift${n === 1 ? '' : 's'} for the manager. They'll reach out to sort it.`);
  }
  state.notes = state.notes || [];
  state.notes.push({ empId: e.id, name: e.name, text: String(body.Body || '').slice(0, 300), at: new Date().toISOString() });
  await kvSetState(state);
  return twiml(res, `Thanks ${e.name} — passed your message to the manager. Reply YES to confirm your shifts, NO if you can't make it.`);
}
