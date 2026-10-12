import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, fail } from '../lib/clover.js';
import {
  buildVideoPlan,
  HIGGSFIELD_MODEL,
  higgsfieldConfigured,
  submitVideo,
  videoStatus,
} from '../lib/higgsfield.js';

let redisClient: any = null;

function bodyOf(req: VercelRequest): Record<string, any> {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function isAuthorized(req: VercelRequest): boolean {
  const expected = (process.env.SYNC_SECRET || '').trim();
  return !!expected && (req.headers['x-colette-secret'] as string || '') === expected;
}

async function redis(): Promise<any> {
  const url = process.env.KV_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL;
  if (!url) return null;
  if (!redisClient) {
    const mod: any = await import('ioredis');
    const Redis = mod.default || mod;
    redisClient = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: false });
  }
  return redisClient;
}

function cleanApprovalId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,79}$/.test(id) ? id : '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;

  if (req.method === 'GET' && !req.query.request_id) {
    return res.status(200).json({
      ok: true,
      configured: higgsfieldConfigured(),
      balance_verified: false,
      default_mode: 'plan_only',
      generation_requires_approval: true,
      model: HIGGSFIELD_MODEL,
      note: 'Generation requires an authenticated request, a unique approval_id, and approval=APPROVE_GENERATION.',
    });
  }

  if (!isAuthorized(req)) return fail(res, 401, 'Unauthorized');
  if (!higgsfieldConfigured()) return fail(res, 503, 'HF_CREDENTIALS is not configured');

  try {
    if (req.method === 'GET') {
      const requestId = Array.isArray(req.query.request_id) ? req.query.request_id[0] : req.query.request_id;
      const result = await videoStatus(String(requestId || ''));
      return res.status(200).json({ ok: true, result });
    }
    if (req.method !== 'POST') return fail(res, 405, 'Use GET or POST');

    const body = bodyOf(req);
    const plan = buildVideoPlan(body);
    if (body.action !== 'submit') {
      return res.status(200).json({
        ok: true,
        action: 'plan',
        billable: false,
        plan,
        next: 'Review the plan once, then submit with action=submit, approval=APPROVE_GENERATION, and a unique approval_id.',
      });
    }

    if (body.approval !== 'APPROVE_GENERATION') {
      return fail(res, 409, 'Explicit generation approval is required');
    }
    const approvalId = cleanApprovalId(body.approval_id);
    if (!approvalId) return fail(res, 400, 'A unique approval_id is required');

    const client = await redis();
    if (!client) return fail(res, 503, 'Idempotency store is unavailable');
    const key = `colette:higgsfield:approval:${approvalId}`;
    const locked = await client.set(key, JSON.stringify({ state: 'submitting', at: Date.now() }), 'EX', 86400, 'NX');
    if (locked !== 'OK') return fail(res, 409, 'This approval_id has already been used');

    try {
      const result = await submitVideo(plan);
      await client.set(key, JSON.stringify({ state: 'submitted', at: Date.now(), request_id: result?.request_id || null }), 'EX', 604800);
      return res.status(202).json({ ok: true, billable: true, approval_id: approvalId, result });
    } catch (error) {
      await client.del(key);
      throw error;
    }
  } catch (error: any) {
    const status = Number(error?.status) || 400;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return fail(res, safeStatus, error?.message || 'Higgsfield request failed');
  }
}
