import type { NseFundamentals } from './nse-fundamentals.js';
import { normalizeMetricText } from './financial-metrics.js';

/** Reject unsupported dated valuation claims, allowing explicitly attributed TradingView observations. */
export function hasMismatchedNseDate(
  text: string, nse: NseFundamentals, tradingView: { date: string; values: number[] }[] = [],
): boolean {
  if (!/\b(?:P\/?E|market\s*cap|valuation)\b/i.test(text)) return false;
  const supplemental = /\btradingview\b/i.test(text) ? tradingView : [];
  for (const date of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) {
    if (!nse.history.some(point => point.date === date) && !supplemental.some(item => item.date === date)) return true;
  }
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(x|times|crore|cr|trillion|tn|t|billion|bn|b|million|mn|m)?\s*(?:INR\s*)?[([]?\s*(?:on|asOf|as of)\s+(\d{4}-\d{2}-\d{2})/gi)) {
    const amount = match[1]!.replace(/,/g, '');
    const unit = (match[2] ?? '').toLowerCase();
    const value = /^(?:crore|cr|trillion|tn|t|billion|bn|b|million|mn|m)$/.test(unit)
      ? normalizeMetricText('marketCapCrore', `${amount} ${unit}`) : Number(amount);
    const point = nse.history.find(point => point.date === match[3]);
    const values = [point?.pe, point?.adjustedPe, point?.marketCapCrore,
      ...supplemental.filter(item => item.date === match[3]).flatMap(item => item.values)];
    if (value === undefined || !values.some(number => number != null && Math.abs(number - value) < 0.0051)) return true;
  }
  return false;
}
