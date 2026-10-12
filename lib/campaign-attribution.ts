export interface CampaignAttribution {
  campaign?: string;
  source?: string;
  medium?: string;
  content?: string;
  term?: string;
  gclid?: string;
  fbclid?: string;
  landingPath?: string;
}

const CLEAN_VALUE = /[^a-zA-Z0-9._~:/?=&+-]/g;

function clean(value: unknown, max = 96): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim().replace(CLEAN_VALUE, '').slice(0, max);
  return result || undefined;
}

export function normalizeCampaignAttribution(input: unknown): CampaignAttribution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  return {
    campaign: clean(raw.campaign),
    source: clean(raw.source, 48),
    medium: clean(raw.medium, 48),
    content: clean(raw.content),
    term: clean(raw.term),
    gclid: clean(raw.gclid, 160),
    fbclid: clean(raw.fbclid, 160),
    landingPath: clean(raw.landingPath, 120),
  };
}

export function campaignAttributionTag(attribution: CampaignAttribution): string {
  const pairs: Array<[string, string | undefined]> = [
    ['cmp', attribution.campaign],
    ['src', attribution.source],
    ['med', attribution.medium],
    ['cnt', attribution.content],
    ['trm', attribution.term],
    ['gcl', attribution.gclid],
    ['fbc', attribution.fbclid],
  ];
  const compact = pairs.filter(([, value]) => value).map(([key, value]) => `${key}=${value}`);
  return compact.length ? `[MKT ${compact.join('|')}]`.slice(0, 420) : '';
}

export function campaignEventName(value: unknown): string | null {
  const name = clean(value, 48);
  return name && ['landing_view', 'product_view', 'order_click', 'directions_click', 'call_click'].includes(name)
    ? name
    : null;
}
