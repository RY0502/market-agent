import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { unzipSync, strFromU8 } from 'fflate';
import { addDays, dateValue, monthsBefore } from './dates.js';
import { atomicWrite, readOptional } from './storage.js';
import { ACTIVE_GROUPS, loadScreeningConfig, SHORTLIST_SIZE, withinPrice, type ScreeningConfig } from './screening.js';
import type { NseFundamentals } from './nse-fundamentals.js';

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
  volatility: number;
  observations: number;
}

export interface PricePoint {
  date: string;
  close: number;
}

export interface BhavHistory {
  dates?: string[];
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

export function parseBhav(csv: string, date: string): Equity[] {
  const rows: Record<string, string>[] = parse(csv, {
    columns: (headers: string[]) => headers.map(h => h.trim()),
    bom: true, skip_empty_lines: true, trim: true,
  });
  if (!rows.length) throw new Error(`Empty bhavcopy for ${date}`);
  const modern = 'TckrSymb' in rows[0]!;
  const required = modern
    ? ['TckrSymb', 'ISIN', 'SctySrs', 'TradDt', 'ClsPric', 'HghPric', 'LwPric', 'TtlTradgVol', 'TtlTrfVal']
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
    const rowDate = modern ? row.TradDt?.slice(0, 10)
      : new Date(`${row.TIMESTAMP} UTC`).toISOString().slice(0, 10);
    if (rowDate !== date) throw new Error(`Bhavcopy date mismatch: expected ${date}, got ${rowDate}`);
    const symbol = row[modern ? 'TckrSymb' : 'SYMBOL']!;
    const isin = row.ISIN!;
    if (!symbol || !/^IN[A-Z0-9]{10}$/.test(isin) || seen.has(isin)) {
      throw new Error(`Invalid or duplicate equity identity: ${symbol}/${isin}`);
    }
    seen.add(isin);
    const equity: Equity = {
      symbol, isin, name: row.FinInstrmNm || symbol, date,
      close: number(row, modern ? 'ClsPric' : 'CLOSE'),
      high: number(row, modern ? 'HghPric' : 'HIGH'),
      low: number(row, modern ? 'LwPric' : 'LOW'),
      volume: number(row, modern ? 'TtlTradgVol' : 'TOTTRDQTY'),
      turnover: number(row, modern ? 'TtlTrfVal' : 'TOTTRDVAL'),
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

  constructor(private root: string, private request: typeof fetch = fetch) {}

  async load(date: string): Promise<Equity[]> {
    const file = path.join(this.root, 'bhav', `${date}.csv`);
    const cached = await readOptional(file);
    if (cached) return parseBhav(cached.toString('utf8'), date);
    if (this.downloads >= 31) throw new Error('31 bhavcopy download limit reached');
    const response = await this.request(archiveUrl(date), {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/zip', Referer: 'https://www.nseindia.com/' },
      signal: AbortSignal.timeout(45_000),
    });
    if (response.status === 404) {
      if (!this.missingDates.includes(date)) this.missingDates.push(date);
      throw new MissingBhavcopy(`No NSE bhavcopy for ${date}`);
    }
    if (!response.ok) throw new Error(`NSE download failed for ${date}: HTTP ${response.status}`);
    this.downloads++;
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > 20_000_000) throw new Error('NSE archive exceeds size limit');
    const entries = unzipSync(buffer, { filter: entry => entry.name.endsWith('.csv') && entry.originalSize <= 60_000_000 });
    const csvFiles = Object.entries(entries).filter(([name]) => name.endsWith('.csv'));
    if (csvFiles.length !== 1) throw new Error(`Expected one CSV in NSE archive for ${date}`);
    const csv = strFromU8(csvFiles[0]![1]);
    const rows = parseBhav(csv, date);
    await atomicWrite(file, csv);
    return rows;
  }

  async history(date: string, settings = loadScreeningConfig()): Promise<BhavHistory> {
    const current = (await this.load(date)).filter(row =>
      ACTIVE_GROUPS.some(group => withinPrice(row.close, settings[group])));
    const ids = new Set(current.map(row => row.isin));
    const target = addDays(date, -settings.lookbackDays);
    let baseline: string | undefined;
    let baseRows: Equity[] = [];
    for (let day = target; day < date; day = addDays(day, 1)) {
      try {
        baseRows = await this.load(day);
        baseline = day;
        break;
      } catch (error) {
        if (!(error instanceof MissingBhavcopy)) throw error;
      }
    }
    if (!baseline) throw new UnavailableHistory(`No historical bhavcopy available on or after ${target} and before ${date}; ${settings.lookbackDays}-day comparison skipped`);
    const days = [baseRows.filter(row => ids.has(row.isin))];
    const dates = [baseline];
    for (let day = addDays(baseline, 1); day < date; day = addDays(day, 1)) {
      // Weekends can contain special NSE sessions, so probe them too.
      try {
        days.push((await this.load(day)).filter(row => ids.has(row.isin)));
        dates.push(day);
      } catch (error) {
        if (!(error instanceof MissingBhavcopy)) throw error;
      }
    }
    days.push(current);
    dates.push(date);
    await atomicWrite(path.join(this.root, 'reduced', `${date}.json`), JSON.stringify({ settings, baseline, current, days }));
    return { current, days, baseline, dates };
  }

  async chartPrices(history: BhavHistory, candidates: Candidate[], count: number): Promise<Map<string, PricePoint[]>> {
    if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error('Chart requires between one and five trading observations');
    const series = new Map(candidates.map(candidate => [candidate.isin, new Map<string, number>()]));
    const collect = (rows: Equity[]) => {
      for (const row of rows) series.get(row.isin)?.set(row.date, row.close);
    };
    for (const rows of history.days) collect(rows);
    const date = history.current[0]?.date;
    if (date && series.size) {
      const cutoff = monthsBefore(date, 2);
      for (let day = addDays(history.baseline, -1);
        day >= cutoff && [...series.values()].some(points => points.size < count);
        day = addDays(day, -1)) {
        if (this.downloads >= 31 && !await readOptional(path.join(this.root, 'bhav', `${day}.csv`))) continue;
        try {
          collect(await this.load(day));
        } catch (error) {
          if (!(error instanceof MissingBhavcopy)) throw error;
        }
      }
    }
    return new Map([...series].map(([isin, points]) => [isin,
      [...points].sort(([a], [b]) => a.localeCompare(b)).slice(-count).map(([date, close]) => ({ date, close })),
    ]));
  }
}

export function screen(
  history: { current: Equity[]; days: Equity[][]; baseline: string },
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
    const samples = series.get(current.isin)!;
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
      const change = group === 'gainers'
        ? (Math.round(current.high * 100) - Math.round(base.high * 100)) / 100
        : (Math.round(current.low * 100) - Math.round(base.low * 100)) / 100;
      const magnitude = group === 'gainers' ? change : -change;
      if (Math.round(magnitude * 100) < Math.round(rule.threshold * 100) || averageVolume <= 0) continue;
      candidates.push({
        symbol: current.symbol, isin: current.isin, name: current.name, group,
        threshold: rule.threshold, minPrice: rule.minPrice, maxPrice: rule.maxPrice, price: current.close,
        change,
        changePercent: change / (group === 'gainers' ? base.high : base.low) * 100,
        baselineDate: history.baseline, asOfDate: current.date,
        averageVolume, averageTurnover, volumeRatio: current.volume / averageVolume,
        volatility, observations: samples.length,
      });
    }
  }
  return candidates;
}

export function shortlist(candidates: Candidate[]): { gainers: Candidate[]; losers: Candidate[] } {
  const order = (group: Candidate['group']) => candidates.filter(candidate => ACTIVE_GROUPS.includes(group) && candidate.group === group)
    .sort((a, b) => (group === 'gainers' ? b.change - a.change : a.change - b.change) ||
      a.symbol.localeCompare(b.symbol) || a.isin.localeCompare(b.isin))
    .slice(0, SHORTLIST_SIZE);
  return { gainers: order('gainers'), losers: order('losers') };
}
