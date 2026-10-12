const HIGGSFIELD_BASE = 'https://api.higgsfield.ai';
export const HIGGSFIELD_MODEL = 'bytedance/seedance-2.5/image-to-video';

export type HiggsfieldResolution = '480p' | '720p';
export type HiggsfieldFormat = 'mp4' | 'mov';

export type HiggsfieldVideoPlan = {
  model: typeof HIGGSFIELD_MODEL;
  image_url: string;
  prompt?: string;
  duration: number;
  resolution: HiggsfieldResolution;
  output_format: HiggsfieldFormat;
  generate_audio: boolean;
  estimated_cost_usd: { low: number; high: number; note: string };
};

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sourceUrl(value: unknown): string {
  const raw = text(value, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('image_url must be a valid URL'); }
  if (url.protocol !== 'https:') throw new Error('image_url must use HTTPS');
  return url.toString();
}

export function buildVideoPlan(input: Record<string, unknown>): HiggsfieldVideoPlan {
  const duration = Number(input.duration ?? 5);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new Error('duration must be a whole number from 4 to 15 seconds');
  }
  const resolution = text(input.resolution, 16) || '720p';
  if (!['480p', '720p'].includes(resolution)) throw new Error('resolution must be 480p or 720p');
  const outputFormat = text(input.output_format, 16) || 'mp4';
  if (!['mp4', 'mov'].includes(outputFormat)) throw new Error('output_format must be mp4 or mov');
  const prompt = text(input.prompt, 1800);
  const low = Number((duration * 0.144).toFixed(2));
  const high = Number((duration * 0.3236).toFixed(2));
  return {
    model: HIGGSFIELD_MODEL,
    image_url: sourceUrl(input.image_url),
    ...(prompt ? { prompt } : {}),
    duration,
    resolution: resolution as HiggsfieldResolution,
    output_format: outputFormat as HiggsfieldFormat,
    generate_audio: input.generate_audio === true,
    estimated_cost_usd: {
      low,
      high,
      note: 'Estimate from Higgsfield pricing observed 2026-10-11; confirm current provider price before approval.',
    },
  };
}

function credentials(): string {
  const value = (process.env.HF_CREDENTIALS || '').trim();
  if (!value || !value.includes(':')) throw new Error('HF_CREDENTIALS is not configured');
  return value;
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${HIGGSFIELD_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Key ${credentials()}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body?.detail === 'string'
      ? body.detail
      : typeof body?.message === 'string'
        ? body.message
        : `Higgsfield HTTP ${response.status}`;
    const error: any = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function submitVideo(plan: HiggsfieldVideoPlan): Promise<any> {
  const { estimated_cost_usd: _estimate, model: _model, ...input } = plan;
  return request(`/${HIGGSFIELD_MODEL}`, { method: 'POST', body: JSON.stringify(input) });
}

export async function videoStatus(requestId: string): Promise<any> {
  const id = text(requestId, 128);
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(id)) throw new Error('Invalid request_id');
  return request(`/requests/${encodeURIComponent(id)}/status`, { method: 'GET' });
}

export function higgsfieldConfigured(): boolean {
  const value = (process.env.HF_CREDENTIALS || '').trim();
  return value.includes(':');
}
