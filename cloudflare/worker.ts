import { z } from 'zod';
import { isReportPath, reportHeaders, REPORT_DAYS, REPORT_LIFETIME_MS } from '../src/report-policy.js';

interface ReportMetadata { expiresAt: number }
export interface ReportNamespace {
  getWithMetadata<T>(key: string, type: 'text'): Promise<{ value: string | null; metadata: T | null }>;
  put(key: string, value: string, options: { expiration: number; metadata: ReportMetadata }): Promise<void>;
}
export interface ReportEnvironment {
  REPORTS: ReportNamespace;
  REPORT_UPLOAD_TOKEN: string;
}
type ReportCache = Pick<Cache, 'match' | 'put' | 'delete'>;
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };
const uploadSchema = z.object({
  path: z.string().refine(isReportPath),
  html: z.string().min(1).refine(value => new TextEncoder().encode(value).length <= 64_000),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
const errorResponse = (status: number, message: string) =>
  new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });

async function authorized(request: Request, token: string): Promise<boolean> {
  if (!token || token.length < 32) throw new Error('REPORT_UPLOAD_TOKEN must contain at least 32 characters');
  const encoder = new TextEncoder();
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [expected, supplied] = await Promise.all([
    digest(`Bearer ${token}`), digest(request.headers.get('Authorization') ?? ''),
  ]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i]! ^ supplied[i]!;
  return difference === 0;
}

export async function handleReportRequest(
  request: Request, env: ReportEnvironment, cache: ReportCache, ctx: ExecutionContext,
  now: () => number = Date.now,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/stock-report-upload' || url.pathname === '/stock-report-health') {
    if (!await authorized(request, env.REPORT_UPLOAD_TOKEN)) return errorResponse(401, 'Unauthorized');
    if (url.pathname === '/stock-report-health' && request.method === 'GET') {
      await env.REPORTS.getWithMetadata('__report_health__', 'text');
      return Response.json({ retentionDays: REPORT_DAYS }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname !== '/stock-report-upload' || request.method !== 'POST') return errorResponse(405, 'Method not allowed');
    if (request.headers.get('Content-Type') !== 'application/json') return errorResponse(415, 'Expected application/json');
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 400_000) return errorResponse(413, 'Report too large');
    let data: unknown;
    try { data = JSON.parse(text); } catch { return errorResponse(400, 'Invalid JSON'); }
    const parsed = uploadSchema.safeParse(data);
    if (!parsed.success) return errorResponse(400, 'Invalid report');
    const report = parsed.data;
    const createdAt = Date.parse(report.createdAt);
    const expiresAt = Date.parse(report.expiresAt);
    if (Math.abs(createdAt - now()) > 300_000 || expiresAt - createdAt !== REPORT_LIFETIME_MS) {
      return errorResponse(400, 'Reports require a recent creation time and exactly five-day retention');
    }
    await env.REPORTS.put(report.path, report.html, {
      expiration: Math.ceil(expiresAt / 1000), metadata: { expiresAt },
    });
    return Response.json({ path: report.path, expiresAt: report.expiresAt }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!['GET', 'HEAD'].includes(request.method)) return errorResponse(405, 'Method not allowed');
  let path: string;
  try { path = decodeURIComponent(url.pathname.slice(1)); } catch { return errorResponse(400, 'Invalid report path'); }
  if (!isReportPath(path)) return errorResponse(404, 'Report not found');
  // Canonical cache keys prevent query-string variants from duplicating stored pages.
  const key = new Request(`${url.origin}/${path.split('/').map(encodeURIComponent).join('/')}`);
  const cached = await cache.match(key);
  if (cached) {
    const expiresAt = Number(cached.headers.get('X-Report-Expires-At'));
    if (Number.isFinite(expiresAt) && expiresAt > now()) {
      return new Response(request.method === 'HEAD' ? null : cached.body, { headers: reportHeaders(expiresAt, now()) });
    }
    ctx.waitUntil(cache.delete(key).catch(error => console.error('Report cache deletion failed', error)));
    if (Number.isFinite(expiresAt) && expiresAt > 0) return errorResponse(410, 'Report expired');
  }
  const stored = await env.REPORTS.getWithMetadata<ReportMetadata>(path, 'text');
  if (stored.value === null) return errorResponse(404, 'Report not found or expired');
  const expiresAt = stored.metadata?.expiresAt;
  if (!expiresAt || !Number.isFinite(expiresAt)) throw new Error('Stored report has invalid expiry metadata');
  if (expiresAt <= now()) return errorResponse(410, 'Report expired');
  const response = new Response(stored.value, { headers: reportHeaders(expiresAt, now()) });
  if (expiresAt - now() >= 1000) {
    ctx.waitUntil(cache.put(key, response.clone()).catch(error => console.error('Report cache write failed', error)));
  }
  return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response;
}

export default {
  async fetch(request: Request, env: ReportEnvironment, ctx: ExecutionContext): Promise<Response> {
    try {
      const cache = (caches as CacheStorage & { default: Cache }).default;
      return await handleReportRequest(request, env, cache, ctx);
    } catch (error) {
      console.error('Cloudflare report request failed', error);
      return errorResponse(500, 'Report hosting unavailable');
    }
  },
};
