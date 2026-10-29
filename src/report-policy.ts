export const REPORT_DAYS = 5;
export const REPORT_LIFETIME_MS = REPORT_DAYS * 86_400_000;

export function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Report hosting requires an HTTPS origin without a path, credentials, query or fragment');
  }
  return url.origin;
}

export function reportPath(runId: string, group: string, symbol: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId) ||
    !['gainers', 'losers'].includes(group) || !/^[A-Za-z0-9&_.-]{1,64}$/.test(symbol) || ['.', '..'].includes(symbol)) {
    throw new Error('Unsafe stock report identity');
  }
  return `stock-reports/${runId}/${group}/${symbol}.html`;
}

export function isReportPath(path: string): boolean {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'stock-reports' || !parts[3]?.endsWith('.html')) return false;
  try {
    return reportPath(parts[1]!, parts[2]!, parts[3].slice(0, -5)) === path;
  } catch {
    return false;
  }
}

export function reportHeaders(expiresAt: number, now: number): Headers {
  const ttl = Math.max(0, Math.min(300, Math.floor((expiresAt - now) / 1000)));
  return new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': ttl ? `public, max-age=${ttl}, s-maxage=${ttl}, must-revalidate` : 'no-store',
    'X-Report-Expires-At': String(expiresAt),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
  });
}
