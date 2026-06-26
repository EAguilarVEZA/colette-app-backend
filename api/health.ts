// GET /api/health — quick check that the function runs and config is present.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, assertConfigured, cfg } from '../lib/clover.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  const missing = assertConfigured();
  res.status(200).json({
    ok: true,
    service: 'colette-app-backend',
    env: {
      apiBase: cfg.apiBase,
      ecommBase: cfg.ecommBase,
      merchantId: cfg.merchantId,
      merchantIdLen: cfg.merchantId.length,
      tokenPreview: cfg.apiToken ? cfg.apiToken.slice(0, 6) + '…' + cfg.apiToken.slice(-4) : 'none',
      tokenLen: cfg.apiToken.length,
      merchantConfigured: !!cfg.merchantId,
      tokenConfigured: !!cfg.apiToken,
      ecommKeyConfigured: !!cfg.ecommKey,
    },
    missingEnvVars: missing,
  });
}
