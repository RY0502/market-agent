import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { unzipSync, strFromU8 } from 'fflate';
import { addDays, dateValue } from './dates.js';
import { atomicWrite, readOptional } from './storage.js';
import type { BhavHistory, Candidate } from './bhav.js';

interface Source { url: string; excerpt: string }
interface HistoricalMetric { value: number; asOf: string; source: Source }
export interface NseFundamentals {
  asOf: string;
  pe: { value: number; source: Source } | null;
  adjustedPe: number | null;
  marketCapCrore: { value: number; source: Source } | null;
  historical: {
    pe: HistoricalMetric | null;
    adjustedPe: HistoricalMetric | null;
    marketCapCrore: HistoricalMetric | null;
  };
  history: { date: string; symbol: string; pe: number | null; adjustedPe: number | null; marketCapCrore: number | null }[];
  corporateActions: { reportedOn: string; symbol: string; exDate: string | null; recordDate: string | null;
    bookStart: string | null; bookEnd: string | null; purpose: string; source: Source }[];
  missingFiles: { date: string; type: 'pe' | 'pr' }[];
}

function stamp(date: string, fullYear = false): string {
  dateValue(date);
  return date.slice(8) + date.slice(5, 7) + date.slice(fullYear ? 0 : 2, 4);
}
export const peUrl = (date: string) => `https://nsearchives.nseindia.com/content/equities/peDetail/PE_${stamp(date)}.csv`;
export const prUrl = (date: string) => `https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PR${stamp(date)}.zip`;

function rows(text: string, required: string[], allowEmpty = false): Record<string, string>[] {
  let headersSeen = false;
  const parsed: Record<string, string>[] = parse(text, {
    columns: (headers: string[]) => {
      const clean = headers.map(header => header.trim());
      headersSeen = true;
      if (new Set(clean).size !== clean.length || required.some(header => !clean.includes(header))) throw new Error('Invalid NSE fundamentals CSV headers');
      return clean;
    },
    bom: true, trim: true, skip_empty_lines: true,
  });
  if (!headersSeen || (!allowEmpty && !parsed.length)) throw new Error('Empty NSE fundamentals data');
  return parsed;
}
function numeric(text: string | undefined): number | null {
  if (text === undefined || /^(?:|NA|N\/A|-|--|NIL)$/i.test(text.trim())) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(text.trim())) throw new Error(`Invalid NSE financial number: ${text}`);
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER ||
    (value === 0 && /[1-9]/.test(text))) throw new Error('NSE financial number is outside the safe range');
  return value;
}
function nseDate(text: string): string | null {
  if (!text.trim() || text.trim() === '-') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) { dateValue(text); return text; }
  const match = /^(\d{2})[ -]([A-Za-z]{3})[ -](\d{4})$/.exec(text);
  const month = match ? ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(match[2]!.toUpperCase()) + 1 : 0;
  if (!match || !month) throw new Error(`Invalid NSE fundamentals date: ${text}`);
  const date = `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}`;
  dateValue(date);
  return date;
}

export function parsePe(text: string, date: string) {
  const result = new Map<string, { pe: number | null; adjustedPe: number | null; source: Source }>();
  for (const row of rows(text, ['SYMBOL', 'SYMBOL P/E', 'ADJUSTED P/E'])) {
    const symbol = row.SYMBOL!;
    if (!symbol || result.has(symbol)) throw new Error('Invalid or duplicate NSE P/E symbol');
    const ratio = (field: 'SYMBOL P/E' | 'ADJUSTED P/E') => {
      if (/^(?:[+-]?Infinity|NaN)$/i.test(row[field]!)) {
        console.warn(JSON.stringify({ event: 'nse_pe_undefined', date, symbol, field }));
        return null;
      }
      return numeric(row[field]);
    };
    const pe = ratio('SYMBOL P/E');
    const adjustedPe = ratio('ADJUSTED P/E');
    result.set(symbol, {
      pe: pe !== null && pe > 0 ? pe : null, adjustedPe: adjustedPe !== null && adjustedPe > 0 ? adjustedPe : null,
      source: { url: peUrl(date), excerpt: `NSE P/E file ${date}; SYMBOL=${symbol}; SYMBOL P/E=${row['SYMBOL P/E']}; ADJUSTED P/E=${row['ADJUSTED P/E']}` },
    });
  }
  return result;
}

export function parsePr(data: Uint8Array, date: string) {
  const names = [`mcap${stamp(date, true)}.csv`, `bc${stamp(date, true)}.csv`];
  const entries = unzipSync(data, { filter: entry => names.includes(entry.name) && entry.originalSize <= 20_000_000 });
  if (names.some(name => !entries[name])) throw new Error('NSE PR archive is missing its dated market-cap or corporate-action file');
  const caps = new Map<string, { value: number; source: Source }>();
  for (const row of rows(strFromU8(entries[names[0]!]!), ['Trade Date', 'Symbol', 'Series', 'Market Cap(Rs.)'])) {
    if (row.Series !== 'EQ') continue;
    if (nseDate(row['Trade Date']!) !== date) throw new Error('NSE market-cap trade date mismatch');
    const value = numeric(row['Market Cap(Rs.)']);
    if (value === null || value <= 0) continue;
    if (!row.Symbol || caps.has(row.Symbol)) throw new Error('Invalid or duplicate NSE market-cap symbol');
    caps.set(row.Symbol, { value: value / 10_000_000, source: {
      url: prUrl(date),
      excerpt: `NSE ${names[0]}: Symbol=${row.Symbol}; Trade Date=${date}; Market Cap(Rs.)=${row['Market Cap(Rs.)']}; converted market cap INR crore=${value / 10_000_000}`,
    } });
  }
  const actions: NseFundamentals['corporateActions'] = [];
  for (const row of rows(strFromU8(entries[names[1]!]!), ['SERIES','SYMBOL','RECORD_DT','BC_STRT_DT','BC_END_DT','EX_DT','PURPOSE'], true)) {
    if (row.SERIES !== 'EQ') continue;
    if (!row.SYMBOL || !row.PURPOSE) throw new Error('Invalid NSE corporate-action row');
    actions.push({
      reportedOn: date, symbol: row.SYMBOL,
      exDate: nseDate(row.EX_DT!), recordDate: nseDate(row.RECORD_DT!),
      bookStart: nseDate(row.BC_STRT_DT!), bookEnd: nseDate(row.BC_END_DT!), purpose: row.PURPOSE,
      source: { url: prUrl(date), excerpt: `NSE ${names[1]}: ${JSON.stringify(row)}` },
    });
  }
  return { caps, actions };
}

export class NseFundamentalsStore {
  downloads = { pe: 0, pr: 0 };
  constructor(private root: string, private request: typeof fetch = fetch) {}

  private async load<T>(date: string, type: 'pe' | 'pr', parseData: (data: Buffer) => T): Promise<T | undefined> {
    const file = path.join(this.root, 'nse', `${date}.${type}.${type === 'pe' ? 'csv' : 'zip'}`);
    const cached = await readOptional(file);
    if (cached) return parseData(cached);
    if (this.downloads[type] >= 31) throw new Error(`31 NSE ${type} report download limit reached`);
    const response = await this.request(type === 'pe' ? peUrl(date) : prUrl(date), {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nseindia.com/' },
      signal: AbortSignal.timeout(45_000),
    });
    if (response.status === 404) {
      console.warn(JSON.stringify({ event: 'nse_report_unavailable', date, type, status: 404 }));
      return undefined;
    }
    if (!response.ok) throw new Error(`NSE ${type} report failed for ${date}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 25_000_000) throw new Error('NSE fundamentals report exceeds size limit');
    const parsed = parseData(data);
    await atomicWrite(file, data);
    this.downloads[type]++;
    return parsed;
  }

  async contexts(history: BhavHistory, candidates: Candidate[]): Promise<Map<string, NseFundamentals>> {
    const result = new Map<string, NseFundamentals>(candidates.map(candidate => [candidate.isin, {
      asOf: candidate.asOfDate, pe: null, adjustedPe: null, marketCapCrore: null, history: [], corporateActions: [], missingFiles: [],
      historical: { pe: null, adjustedPe: null, marketCapCrore: null },
    }]));
    if (!result.size) return result;
    const dates = history.dates ?? history.days.map(day => day[0]?.date).filter((date): date is string => Boolean(date));
    const dayRows = new Map(history.days.map(day => [day[0]?.date, day]));
    for (const date of [...new Set(dates)].sort()) {
      const pe = await this.load(date, 'pe', data => parsePe(data.toString('utf8'), date));
      const pr = await this.load(date, 'pr', data => parsePr(data, date));
      for (const context of result.values()) {
        if (!pe) context.missingFiles.push({ date, type: 'pe' });
        if (!pr) context.missingFiles.push({ date, type: 'pr' });
      }
      for (const row of dayRows.get(date) ?? []) {
        const context = result.get(row.isin);
        if (!context) continue;
        const valuation = pe?.get(row.symbol);
        const cap = pr?.caps.get(row.symbol);
        context.history.push({ date, symbol: row.symbol, pe: valuation?.pe ?? null,
          adjustedPe: valuation?.adjustedPe ?? null, marketCapCrore: cap?.value ?? null });
        if (date === context.asOf) {
          context.pe = valuation?.pe != null ? { value: valuation.pe, source: valuation.source } : null;
          context.adjustedPe = valuation?.adjustedPe ?? null;
          context.marketCapCrore = cap ?? null;
        } else if (date >= history.baseline && date < context.asOf) {
          if (valuation?.pe != null) {
            context.historical.pe = { value: valuation.pe, asOf: date, source: valuation.source };
          }
          if (valuation?.adjustedPe != null) {
            context.historical.adjustedPe = { value: valuation.adjustedPe, asOf: date, source: valuation.source };
          }
          if (cap) context.historical.marketCapCrore = { ...cap, asOf: date };
        }
        for (const action of pr?.actions ?? []) {
          if (action.symbol !== row.symbol) continue;
          const eventDate = action.exDate ?? action.recordDate ?? action.bookStart;
          if (!eventDate || eventDate < history.baseline || eventDate > addDays(context.asOf, 10)) continue;
          const index = context.corporateActions.findIndex(previous => previous.exDate === action.exDate &&
            previous.recordDate === action.recordDate && previous.bookStart === action.bookStart && previous.purpose === action.purpose);
          if (index >= 0) context.corporateActions[index] = action; else context.corporateActions.push(action);
        }
      }
    }
    for (const [isin, context] of result) {
      if (context.pe) context.historical.pe = null;
      if (context.adjustedPe !== null) context.historical.adjustedPe = null;
      if (context.marketCapCrore) context.historical.marketCapCrore = null;
      if (!context.pe || !context.marketCapCrore) console.warn(JSON.stringify({
        event: 'nse_stock_metrics_unavailable', isin, date: context.asOf,
        fields: [...(!context.pe ? ['pe'] : []), ...(!context.marketCapCrore ? ['marketCapCrore'] : [])],
        historicalDates: {
          pe: context.historical.pe?.asOf ?? null,
          marketCapCrore: context.historical.marketCapCrore?.asOf ?? null,
        },
      }));
    }
    return result;
  }
}
