/** Identify a TradingView NSE symbol overview source. */
export function isTradingViewSource(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'in.tradingview.com' &&
      /^\/symbols\/NSE-[^/]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}
