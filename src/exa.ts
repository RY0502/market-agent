import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Candidate } from './bhav.js';
import type { LiveRead } from './research.js';
import { evidenceUrl } from './research-quality.js';
import { isResearchNetworkError } from './research-control.js';

export function loadExaConfig(env: Record<string, string | undefined> = process.env) {
  const settings = z.object({
    EXA_ENABLED: z.enum(['true', 'false']).default('true'),
    EXA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(20_000),
    EXA_MAX_KEY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  }).parse(env);
  const numbered = Object.keys(env).filter(key => /^EXA_API_KEY_\d+$/.test(key))
    .sort((a, b) => Number(a.split('_').at(-1)) - Number(b.split('_').at(-1))).map(key => env[key] ?? '');
  const keys = [...new Set([env.EXA_API_KEYS ?? '', env.EXA_API_KEY ?? '', ...numbered]
    .flatMap(value => value.split(/[,\s]+/)).filter(Boolean))];
  if (env.EXA_ENABLED === 'true' && !keys.length) throw new Error('EXA_ENABLED=true requires an Exa API key');
  return { ...settings, keys, enabled: settings.EXA_ENABLED === 'true' && keys.length > 0 };
}

const responseSchema = z.object({
  results: z.array(z.object({
    url: z.string().url(),
    title: z.string().nullish(),
    text: z.string().nullish(),
    highlights: z.array(z.string()).nullish(),
    publishedDate: z.string().nullish(),
  })).max(3),
});

export type ExaSearch = (candidate: Candidate, existing: LiveRead[]) => Promise<LiveRead[]>;

/** One search per stock; bounded key rotation is shared by concurrent stocks in the parent process. */
export function createExaSearch(
  config = loadExaConfig(), request: typeof fetch = fetch, now: () => number = Date.now,
): ExaSearch {
  let cursor = 0;
  const unavailableUntil = config.keys.map(() => 0);
  return async (candidate, existing) => {
    if (!config.enabled) throw new Error('Exa search is not configured');
    const attempted = new Set<number>();
    let lastFailure = 'No Exa keys are currently available';
    const deadline = now() + config.EXA_TIMEOUT_MS;
    for (let attempt = 0; attempt < Math.min(config.keys.length, config.EXA_MAX_KEY_ATTEMPTS); attempt++) {
      let index: number | undefined;
      for (let offset = 0; offset < config.keys.length; offset++) {
        const next = cursor++ % config.keys.length;
        if (!attempted.has(next) && unavailableUntil[next]! <= now()) { index = next; break; }
      }
      if (index === undefined) break;
      attempted.add(index);
      const remaining = deadline - now();
      if (remaining <= 0) break;
      let response: Response;
      try {
        response = await request('https://api.exa.ai/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.keys[index]! },
          body: JSON.stringify({
            query: `"${candidate.name}" ${candidate.symbol} NSE India official company announcements investor relations business news risks`,
            type: 'auto', numResults: 3,
            startPublishedDate: new Date(now() - 7 * 86_400_000).toISOString(),
            endPublishedDate: new Date(now()).toISOString(),
            contents: { text: { maxCharacters: 6000 }, highlights: { maxCharacters: 1500 } },
          }),
          signal: AbortSignal.timeout(remaining),
        });
      } catch (error) {
        // Never propagate provider/network messages that may contain request headers.
        if (!isResearchNetworkError(error) && !(error instanceof Error &&
          ['AbortError', 'TimeoutError'].includes(error.name))) {
          throw new Error('Exa request failed before usable evidence was returned');
        }
        lastFailure = 'Exa network request failed or exceeded its time budget';
        console.warn(JSON.stringify({ event: 'exa_request_failed', symbol: candidate.symbol, attempt: attempt + 1, reason: 'network_or_timeout' }));
        continue;
      }
      if (!response.ok) {
        lastFailure = `Exa search HTTP ${response.status}`;
        if ([401, 403].includes(response.status)) unavailableUntil[index] = Infinity;
        else if ([402, 429].includes(response.status)) unavailableUntil[index] = now() + 60_000;
        if (![401, 402, 403, 408, 429].includes(response.status) && response.status < 500) throw new Error(lastFailure);
        console.warn(JSON.stringify({ event: 'exa_request_failed', symbol: candidate.symbol, attempt: attempt + 1, status: response.status }));
        continue;
      }
      let raw: string;
      try { raw = await response.text(); }
      catch { throw new Error('Exa response could not be read within its time budget'); }
      if (Buffer.byteLength(raw, 'utf8') > 256_000) throw new Error('Exa response exceeds the evidence size limit');
      let parsed: z.infer<typeof responseSchema>;
      try { parsed = responseSchema.parse(JSON.parse(raw)); }
      catch { throw new Error('Exa returned invalid search evidence'); }
      const urls = new Set(existing.map(read => evidenceUrl(read.url)));
      const texts = new Set(existing.map(read => read.output.replace(/\s+/g, ' ').trim().toLowerCase()));
      const result: LiveRead[] = [];
      const name = candidate.name.replace(/\b(?:limited|ltd|pvt)\.?\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const symbol = candidate.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const identity = new RegExp(`(?:^|[^a-z0-9])${symbol}(?:$|[^a-z0-9])`, 'i');
      for (const item of parsed.results) {
        const url = new URL(item.url);
        if (url.protocol !== 'https:' || url.username || url.password) continue;
        const content = (item.text?.trim() || item.highlights?.join('\n').trim() || '').slice(0, 6000);
        const output = content;
        if (content.length < 40 || !(identity.test(output) || name.length >= 4 && output.toLowerCase().includes(name))) continue;
        const canonical = evidenceUrl(item.url);
        const normalized = output.replace(/\s+/g, ' ').trim().toLowerCase();
        const normalizedContent = content.replace(/\s+/g, ' ').trim().toLowerCase();
        if (urls.has(canonical) || texts.has(normalized) || texts.has(normalizedContent)) continue;
        urls.add(canonical);
        texts.add(normalized);
        texts.add(normalizedContent);
        const published = Date.parse(item.publishedDate ?? '');
        result.push({
          evidenceId: `exa_${randomUUID()}`, kind: 'exa', url: item.url, output,
          observedAt: new Date(now()).toISOString(),
          ...(Number.isFinite(published) ? { publishedAt: new Date(published).toISOString() } : {}),
          newsDays: 7,
        });
      }
      return result;
    }
    throw new Error(lastFailure);
  };
}

export async function queryExaNews(
  query: string,
  config = loadExaConfig(),
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ title?: string; url: string; text: string }[]> {
  if (!config.enabled || !config.keys.length) return [];
  const deadline = now() + config.EXA_TIMEOUT_MS;
  for (let attempt = 0; attempt < Math.min(config.keys.length, config.EXA_MAX_KEY_ATTEMPTS); attempt++) {
    const key = config.keys[attempt % config.keys.length]!;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      const response = await request('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          query,
          type: 'auto',
          numResults: 3,
          contents: { text: { maxCharacters: 4000 }, highlights: { maxCharacters: 1000 } },
        }),
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok) continue;
      const raw = await response.text();
      const parsed = responseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      return parsed.data.results.map(r => ({
        title: r.title ?? undefined,
        url: r.url,
        text: (r.text?.trim() || r.highlights?.join('\n').trim() || '').slice(0, 4000),
      })).filter(r => r.text.length > 20);
    } catch {
      continue;
    }
  }
  return [];
}
