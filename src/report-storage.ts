import { z } from 'zod';
import type { Reporter } from './reports.js';
import { renderStockReport } from './reports.js';
import { reportPath, REPORT_DAYS, REPORT_LIFETIME_MS, httpsOrigin } from './report-policy.js';

export interface ReportConfig {
  CLOUDFLARE_REPORT_URL: string;
  CLOUDFLARE_REPORT_UPLOAD_TOKEN: string;
}

export function reportLocation(config: ReportConfig, runId: string, group: string, symbol: string) {
  const key = reportPath(runId, group, symbol);
  return { key, url: `${httpsOrigin(config.CLOUDFLARE_REPORT_URL)}/${key.split('/').map(encodeURIComponent).join('/')}` };
}

export async function verifyReportHosting(config: ReportConfig, request: typeof fetch = fetch): Promise<void> {
  const response = await request(`${httpsOrigin(config.CLOUDFLARE_REPORT_URL)}/stock-report-health`, {
    headers: { Authorization: `Bearer ${config.CLOUDFLARE_REPORT_UPLOAD_TOKEN}` },
    signal: AbortSignal.timeout(45_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Cloudflare report hosting verification failed (HTTP ${response.status})`);
  z.object({ retentionDays: z.literal(REPORT_DAYS) }).parse(await response.json());
}

export function createReporter(config: ReportConfig, request: typeof fetch = fetch, now = () => Date.now()): Reporter {
  return async (stock, runId, prices, requestedPoints) => {
    const location = reportLocation(config, runId, stock.candidate.group, stock.candidate.symbol);
    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + REPORT_LIFETIME_MS).toISOString();
    const html = renderStockReport(stock, runId, prices, requestedPoints, createdAt, expiresAt);
    const response = await request(`${httpsOrigin(config.CLOUDFLARE_REPORT_URL)}/stock-report-upload`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: {
        Authorization: `Bearer ${config.CLOUDFLARE_REPORT_UPLOAD_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: location.key, html, createdAt, expiresAt }),
    });
    if (!response.ok) throw new Error(`Cloudflare report upload failed (HTTP ${response.status})`);
    z.object({ path: z.literal(location.key), expiresAt: z.literal(expiresAt) }).parse(await response.json());
    return { url: location.url, expiresAt };
  };
}
