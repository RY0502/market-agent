import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { unzipSync, strFromU8 } from 'fflate';
import { addDays, dateValue } from './dates.js';
import { atomicWrite, readOptional } from './storage.js';
import { ACTIVE_GROUPS, loadScreeningConfig, SHORTLIST_SIZE, withinPrice, withinTurnover, type ScreeningConfig } from './screening.js';
import type { NseFundamentals } from './nse-fundamentals.js';
import { calculatePriceSignals, type PriceSignals } from './price-signals.js';

export interface Equity {
  symbol: string;
  isin: string;
  name: string;
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number;
  turnover: number;
}

export interface Candidate {
  nse?: NseFundamentals;
  priceSignals?: PriceSignals;
  symbol: string;
  isin: string;
  name: string;
  group: 'gainers' | 'losers';
  threshold: number;
  minPrice: number;
  maxPrice: number;
  price: number;
  change: number;
  changePercent: number;
  baselineDate: string;
  asOfDate: string;
  averageVolume: number;
  volumeRatio: number;
  averageTurnover: number;
  averageTurnoverCr?: number;
  volatility: number;
  observations: number;
  insightFortified?: number;
  insightText?: string;
  shortTermGuidance?: string;
  monthlyGuidance?: string;
}

export interface PricePoint {
  date: string;
  close: number;
  high?: number;
}

export interface BhavHistory {
  dates?: string[];
  missingDates?: string[];
  current: Equity[];
  days: Equity[][];
  baseline: string;
}

export class MissingBhavcopy extends Error {}
export class UnavailableHistory extends Error {}

export function archiveUrl(date: string): string {
  dateValue(date);
  if (date >= '2024-07-08') {
    return `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${date.replaceAll('-', '')}_F_0000.csv.zip`;
  }
  const d = dateValue(date);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  return `https://nsearchives.nseindia.com/content/historical/EQUITIES/${date.slice(0, 4)}/${month}/cm${date.slice(8)}${month}${date.slice(0, 4)}bhav.csv.zip`;
}

export function fallbackArchiveUrl(date: string): string {
  dateValue(date);
  const stamp = date.slice(8, 10) + date.slice(5, 7) + date.slice(0, 4);
  return `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${stamp}.csv`;
}

export function parseBhavDate(text: string): string {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    dateValue(trimmed);
    return trimmed;
  }
  const match = /^(\d{2})[ -]([A-Za-z]{3})[ -](\d{4})$/.exec(trimmed);
  if (match) {
    const monthIndex = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
      .indexOf(match[2]!.toUpperCase()) + 1;
    if (monthIndex) {
      const parsed = `${match[3]}-${String(monthIndex).padStart(2, '0')}-${match[1]}`;
      dateValue(parsed);
      return parsed;
    }
  }
  const utcDate = new Date(`${trimmed} UTC`);
  if (!Number.isNaN(utcDate.getTime())) {
    const iso = utcDate.toISOString().slice(0, 10);
    dateValue(iso);
    return iso;
  }
  throw new Error(`Invalid bhavcopy date: ${text}`);
}

export function parseBhav(csv: string, date: string, isinMap?: Map<string, string>): Equity[] {
  const rows: Record<string, string>[] = parse(csv, {
    columns: (headers: string[]) => headers.map(h => h.trim()),
    bom: true, skip_empty_lines: true, trim: true,
  });
  if (!rows.length) throw new Error(`Empty bhavcopy for ${date}`);
  const modern = 'TckrSymb' in rows[0]!;
  const secFull = 'DATE1' in rows[0]! && 'TURNOVER_LACS' in rows[0]!;
  const required = modern
    ? ['TckrSymb', 'ISIN', 'SctySrs', 'TradDt', 'ClsPric', 'HghPric', 'LwPric', 'TtlTradgVol', 'TtlTrfVal']
    : secFull
      ? ['SYMBOL', 'SERIES', 'DATE1', 'CLOSE_PRICE', 'HIGH_PRICE', 'LOW_PRICE', 'TTL_TRD_QNTY', 'TURNOVER_LACS']
      : ['SYMBOL', 'ISIN', 'SERIES', 'TIMESTAMP', 'CLOSE', 'HIGH', 'LOW', 'TOTTRDQTY', 'TOTTRDVAL'];
  for (const header of required) {
    if (!(header in rows[0]!)) throw new Error(`Missing bhavcopy column ${header}`);
  }
  const number = (row: Record<string, string>, key: string): number => {
    const raw = row[key];
    if (!raw?.trim()) throw new Error(`Empty ${key} for ${row.TckrSymb ?? row.SYMBOL}`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}: ${raw}`);
    return value;
  };
  const seen = new Set<string>();
  const result: Equity[] = [];
  for (const row of rows) {
    if (row[modern ? 'SctySrs' : 'SERIES'] !== 'EQ') continue;
    if (modern && row.FinInstrmTp && row.FinInstrmTp !== 'STK') continue;
    const rowDate = modern
      ? row.TradDt?.slice(0, 10)
      : parseBhavDate(row[secFull ? 'DATE1' : 'TIMESTAMP']!);
    if (rowDate !== date) throw new Error(`Bhavcopy date mismatch: expected ${date}, got ${rowDate}`);
    const symbol = row[modern ? 'TckrSymb' : 'SYMBOL']!;
    let isin = row.ISIN?.trim();
    if (!isin && isinMap?.has(symbol)) {
      isin = isinMap.get(symbol)!;
    }
    if (!isin) {
      isin = `IN${createHash('sha256').update(symbol).digest('hex').slice(0, 10).toUpperCase()}`;
    }
    if (isinMap && row.ISIN?.trim() && !isinMap.has(symbol)) {
      isinMap.set(symbol, row.ISIN.trim());
    }
    if (!symbol || !/^IN[A-Z0-9]{10}$/.test(isin) || seen.has(isin)) {
      throw new Error(`Invalid or duplicate equity identity: ${symbol}/${isin}`);
    }
    seen.add(isin);
    const equity: Equity = {
      symbol, isin, name: row.FinInstrmNm || symbol, date,
      close: number(row, modern ? 'ClsPric' : secFull ? 'CLOSE_PRICE' : 'CLOSE'),
      high: number(row, modern ? 'HghPric' : secFull ? 'HIGH_PRICE' : 'HIGH'),
      low: number(row, modern ? 'LwPric' : secFull ? 'LOW_PRICE' : 'LOW'),
      volume: number(row, modern ? 'TtlTradgVol' : secFull ? 'TTL_TRD_QNTY' : 'TOTTRDQTY'),
      turnover: secFull ? number(row, 'TURNOVER_LACS') * 100_000 : number(row, modern ? 'TtlTrfVal' : 'TOTTRDVAL'),
    };
    if (equity.volume === 0) continue;
    if (equity.low > equity.high || equity.close < equity.low || equity.close > equity.high) {
      throw new Error(`Inconsistent OHLC for ${symbol}`);
    }
    result.push(equity);
  }
  if (!result.length) throw new Error(`No EQ equities in bhavcopy ${date}`);
  return result;
}

export class BhavStore {
  downloads = 0;
  missingDates: string[] = [];
  isinMap = new Map<string, string>();

  constructor(private root: string, private request: typeof fetch = fetch) {}

  async load(date: string): Promise<Equity[]> {
    const file = path.join(this.root, 'bhav', `${date}.csv`);
    const cached = await readOptional(file);
    if (cached) return parseBhav(cached.toString('utf8'), date, this.isinMap);
    const stamp = date.slice(8, 10) + date.slice(5, 7) + date.slice(0, 4);
    const fallbackCached = await readOptional(path.join(this.root, 'bhav', `sec_bhavdata_full_${stamp}.csv`));
    if (fallbackCached) return parseBhav(fallbackCached.toString('utf8'), date, this.isinMap);
    if (this.downloads >= 31) throw new Error('31 bhavcopy download limit reached');
    const response = await this.request(archiveUrl(date), {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/zip', Referer: 'https://www.nseindia.com/' },
      signal: AbortSignal.timeout(45_000),
    });
    if (response.status === 404) {
      const fallbackResponse = await this.request(fallbackArchiveUrl(date), {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv,application/zip,*/*', Referer: 'https://www.nseindia.com/' },
        signal: AbortSignal.timeout(45_000),
      });
      if (fallbackResponse.status === 404) {
        if (!this.missingDates.includes(date)) this.missingDates.push(date);
        throw new MissingBhavcopy(`No NSE bhavcopy for ${date}`);
      }
      if (!fallbackResponse.ok) throw new Error(`NSE download failed for ${date}: HTTP ${fallbackResponse.status}`);
      this.downloads++;
      const buffer = new Uint8Array(await fallbackResponse.arrayBuffer());
      if (buffer.byteLength > 20_000_000) throw new Error('NSE archive exceeds size limit');
      let csv: string;
      if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
        const entries = unzipSync(buffer, { filter: entry => entry.name.endsWith('.csv') && entry.originalSize <= 60_000_000 });
        const csvFiles = Object.entries(entries).filter(([name]) => name.endsWith('.csv'));
        if (csvFiles.length !== 1) throw new Error(`Expected one CSV in NSE archive for ${date}`);
        csv = strFromU8(csvFiles[0]![1]);
      } else {
        csv = Buffer.from(buffer).toString('utf8');
      }
      if (csv.trim().startsWith('<') || csv.trim().startsWith('<!DOCTYPE')) {
        this.downloads--;
        if (!this.missingDates.includes(date)) this.missingDates.push(date);
        throw new MissingBhavcopy(`No NSE bhavcopy for ${date}`);
      }
      try {
        const rows = parseBhav(csv, date, this.isinMap);
        await atomicWrite(file, csv);
        return rows;
      } catch (err) {
        if (err instanceof Error && (err.message.includes('Bhavcopy date mismatch') || err.message.includes('No EQ equities'))) {
          this.downloads--;
          if (!this.missingDates.includes(date)) this.missingDates.push(date);
          throw new MissingBhavcopy(`No NSE bhavcopy for ${date}`);
        }
        throw err;
      }
    }
    if (!response.ok) throw new Error(`NSE download failed for ${date}: HTTP ${response.status}`);
    this.downloads++;
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > 20_000_000) throw new Error('NSE archive exceeds size limit');
    const entries = unzipSync(buffer, { filter: entry => entry.name.endsWith('.csv') && entry.originalSize <= 60_000_000 });
    const csvFiles = Object.entries(entries).filter(([name]) => name.endsWith('.csv'));
    if (csvFiles.length !== 1) throw new Error(`Expected one CSV in NSE archive for ${date}`);
    const csv = strFromU8(csvFiles[0]![1]);
    const rows = parseBhav(csv, date, this.isinMap);
    await atomicWrite(file, csv);
    return rows;
  }

  async history(date: string, settings = loadScreeningConfig()): Promise<BhavHistory> {
    const current = (await this.load(date)).filter(row =>
      ACTIVE_GROUPS.some(group => withinPrice(row.close, settings[group])));
    const ids = new Set(current.map(row => row.isin));
    // Always download 30 days back regardless of screening lookbackDays.
    const downloadDays = 30;
    const downloadTarget = addDays(date, -downloadDays);
    const screenTarget = addDays(date, -settings.lookbackDays);
    const target = downloadTarget < screenTarget ? downloadTarget : screenTarget;
    const loadedDays = new Map<string, Equity[]>();
    for (let day = target; day < date; day = addDays(day, 1)) {
      try {
        const rows = await this.load(day);
        loadedDays.set(day, rows);
      } catch (error) {
        if (!(error instanceof MissingBhavcopy)) throw error;
      }
    }
    // Find the screening baseline: first trading day on or after screenTarget
    let baseline: string | undefined;
    for (const [day] of loadedDays) {
      if (day >= screenTarget) {
        baseline = day;
        break;
      }
    }
    if (!baseline && loadedDays.size > 0) {
      baseline = [...loadedDays.keys()].at(-1);
    }
    if (!baseline) throw new UnavailableHistory(`No historical bhavcopy available on or after ${target} and before ${date}; ${settings.lookbackDays}-day comparison skipped`);
    const days: Equity[][] = [];
    const dates: string[] = [];
    for (const [day, rows] of loadedDays) {
      if (day >= baseline) {
        days.push(rows.filter(row => ids.has(row.isin)));
        dates.push(day);
      }
    }
    days.push(current);
    dates.push(date);
    await atomicWrite(path.join(this.root, 'reduced', `${date}.json`), JSON.stringify({ settings, baseline, current, days }));
    return { current, days, baseline, dates, missingDates: [...this.missingDates] };
  }

  async chartPrices(history: BhavHistory, candidates: Candidate[], count: number): Promise<Map<string, PricePoint[]>> {
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Chart requires between one and ten trading observations');
    const series = new Map(candidates.map(candidate => [candidate.isin, new Map<string, { close: number; high: number }>()]));
    const collect = (rows: Equity[]) => {
      for (const row of rows) series.get(row.isin)?.set(row.date, { close: row.close, high: row.high });
    };
    for (const rows of history.days) collect(rows);
    const date = history.current[0]?.date;
    if (date && series.size) {
      const cutoff = addDays(date, -45);
      for (let day = addDays(history.baseline, -1);
        day >= cutoff && [...series.values()].some(points => points.size < count);
        day = addDays(day, -1)) {
        const stamp = day.slice(8, 10) + day.slice(5, 7) + day.slice(0, 4);
        if (this.downloads >= 31 && !await readOptional(path.join(this.root, 'bhav', `${day}.csv`)) && !await readOptional(path.join(this.root, 'bhav', `sec_bhavdata_full_${stamp}.csv`))) continue;
        try {
          collect(await this.load(day));
        } catch (error) {
          if (!(error instanceof MissingBhavcopy)) throw error;
        }
      }
    }
    return new Map([...series].map(([isin, points]) => [isin,
      [...points].sort(([a], [b]) => a.localeCompare(b)).slice(-count).map(([date, val]) => ({ date, close: val.close, high: val.high })),
    ]));
  }
}

export function screen(
  history: { current: Equity[]; days: Equity[][]; baseline: string; missingDates?: string[] },
  settings: ScreeningConfig = loadScreeningConfig(),
): Candidate[] {
  const first = new Map(history.days[0]!.map(row => [row.isin, row]));
  const series = new Map<string, Equity[]>();
  for (const day of history.days) {
    for (const row of day) {
      const values = series.get(row.isin) ?? [];
      values.push(row);
      series.set(row.isin, values);
    }
  }
  const candidates: Candidate[] = [];
  for (const current of history.current) {
    const base = first.get(current.isin);
    if (!base || base.high <= 0 || base.low <= 0) continue;
    const samples = series.get(current.isin)!.sort((a, b) => a.date.localeCompare(b.date));
    const prior = samples.slice(0, -1);
    const averageVolume = prior.reduce((sum, row) => sum + row.volume, 0) / prior.length;
    const averageTurnover = prior.reduce((sum, row) => sum + row.turnover, 0) / prior.length;
    const returns = samples.slice(1).map((row, i) => Math.log(row.close / samples[i]!.close));
    if (returns.some(value => !Number.isFinite(value))) continue;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const volatility = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length) * Math.sqrt(252);
    for (const group of ACTIVE_GROUPS) {
      const rule = settings[group];
      if (!withinPrice(current.close, rule)) continue;
      if (!withinTurnover(averageTurnover, rule)) continue;
      const change = group === 'gainers'
        ? (Math.round(current.high * 100) - Math.round(base.high * 100)) / 100
        : (Math.round(current.low * 100) - Math.round(base.low * 100)) / 100;
      const changePercent = change / (group === 'gainers' ? base.high : base.low) * 100;
      const magnitudePercent = group === 'gainers' ? changePercent : -changePercent;
      if (magnitudePercent < rule.threshold || averageVolume <= 0) continue;
      candidates.push({
        symbol: current.symbol, isin: current.isin, name: current.name, group,
        threshold: rule.threshold, minPrice: rule.minPrice, maxPrice: rule.maxPrice, price: current.close,
        change,
        changePercent,
        baselineDate: history.baseline, asOfDate: current.date,
        averageVolume, averageTurnover,
        averageTurnoverCr: Math.round((averageTurnover / 10_000_000) * 100) / 100,
        volumeRatio: current.volume / averageVolume,
        volatility, observations: samples.length,
        priceSignals: calculatePriceSignals(samples, history.days.length, history.missingDates),
      });
    }
  }
  return candidates;
}

export function shortlist(candidates: Candidate[]): { gainers: Candidate[]; losers: Candidate[] } {
  const order = (group: Candidate['group']) => candidates.filter(candidate => ACTIVE_GROUPS.includes(group) && candidate.group === group)
    .sort((a, b) => (group === 'gainers' ? b.changePercent - a.changePercent : a.changePercent - b.changePercent) ||
      a.symbol.localeCompare(b.symbol) || a.isin.localeCompare(b.isin))
    .slice(0, SHORTLIST_SIZE);
  return { gainers: order('gainers'), losers: order('losers') };
}
