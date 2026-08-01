// POST /api/lead — capture a marketing opt-in (the 15% welcome offer).
// Builds the first-party database inside Clover Customers, with dedup + consent.
//   - Requires explicit consent (email and/or SMS) — no consent, no capture.
//   - If the email/phone already exists, we DO NOT reissue the offer.
// Body: { email?, phone?, firstName?, emailConsent:bool, smsConsent:bool, source? }
// Returns: { ok, alreadyClaimed, code? }
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, fail, findLead, createLead } from '../lib/clover.js';

const WELCOME_CODE = 'COLETTE15';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const missing = assertConfigured();
  if (missing.length) return fail(res, 500, 'Missing env vars', missing);

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const email = (body?.email || '').trim();
  const phone = (body?.phone || '').trim();
  const emailConsent = !!body?.emailConsent;
  const smsConsent = !!body?.smsConsent;

  if (!email && !phone) return fail(res, 400, 'Provide an email or phone number');
  // Compliance: we only capture people who explicitly opted in.
  if (!emailConsent && !smsConsent) {
    return fail(res, 400, 'Consent required to receive email or text offers');
  }
  if (phone && !smsConsent) {
    return fail(res, 400, 'SMS consent is required to store a mobile number');
  }

  try {
    // Dedup — one welcome offer per person.
    const existing = await findLead(email, phone);
    if (existing) {
      return res.status(200).json({ ok: true, alreadyClaimed: true });
    }
    await createLead({
      email, phone, firstName: body?.firstName,
      emailConsent, smsConsent, source: body?.source || 'web',
    });
    return res.status(200).json({ ok: true, alreadyClaimed: false, code: WELCOME_CODE });
  } catch (e: any) {
    return fail(res, e?.status || 502, 'Lead capture failed', e?.body ?? String(e));
  }
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return null; } }
