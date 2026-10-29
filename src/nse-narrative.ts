import type { NseFundamentals } from './nse-fundamentals.js';

export function hasMismatchedNseDate(text: string, nse: NseFundamentals): boolean {
  if (!/\b(?:P\/?E|market\s*cap|valuation)\b/i.test(text)) return false;
  for (const date of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) {
    if (!nse.history.some(point => point.date === date)) return true;
  }
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:x|times|crore|cr)?\s*[([]?\s*(?:on|asOf|as of)\s+(\d{4}-\d{2}-\d{2})/gi)) {
    const value = Number(match[1]!.replace(/,/g, ''));
    const point = nse.history.find(point => point.date === match[2]);
    if (!point || ![point.pe, point.adjustedPe, point.marketCapCrore].some(number =>
      number !== null && Math.abs(number - value) < 0.0051)) return true;
  }
  return false;
}
