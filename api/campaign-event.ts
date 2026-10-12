import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, fail } from '../lib/clover.js';
import { campaignEventName, normalizeCampaignAttribution } from '../lib/campaign-attribution.js';

let redisClient: any = null;

async function redis(): Promise<any> {
  const url = process.env.KV_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL || process.env.REDIS_TLS_URL;
  if (!url) return null;
  if (!redisClient) {
    try {
      // @ts-ignore -- loaded dynamically in Vercel, matching the existing API pattern.
      const mod: any = await import('ioredis');
      const Redis = mod.default || mod;
      redisClient = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: false });
    } catch {
      redisClient = null;
    }
  }
  return redisClient;
}

function safeParse(value: string) {
  try { return JSON.parse(value); } catch { return null; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Use POST');

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const event = campaignEventName(body?.event);
  if (!event) return fail(res, 400, 'Unsupported campaign event');

  const attribution = normalizeCampaignAttribution(body?.attribution);
  const product = typeof body?.product === 'string'
    ? body.product.trim().replace(/[^a-zA-Z0-9 .&'/-]/g, '').slice(0, 96)
    : undefined;
  const record = {
    event,
    at: Date.now(),
    attribution,
    ...(product ? { product } : {}),
  };

  const client = await redis();
  if (!client) return res.status(202).json({ ok: true, stored: false, reason: 'event_store_not_configured' });
  try {
    await client.lpush('colette:campaign-events:v1', JSON.stringify(record));
    await client.ltrim('colette:campaign-events:v1', 0, 49999);
    return res.status(202).json({ ok: true, stored: true });
  } catch {
    return res.status(202).json({ ok: true, stored: false, reason: 'event_store_unavailable' });
  }
}
