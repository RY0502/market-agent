import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { BhavStore, screen, shortlist } from './bhav.js';
import { dateValue, todayIST } from './dates.js';
import { atomicWrite, initializeStorage } from './storage.js';
import { ACTIVE_GROUPS, loadScreeningConfig } from './screening.js';

const [baselineDate, asOfDate] = process.argv.slice(2);
if (!baselineDate || !asOfDate) {
  throw new Error('Usage: npm run test:bhav -- YYYY-MM-DD_BASELINE YYYY-MM-DD_CURRENT');
}
dateValue(baselineDate);
dateValue(asOfDate);
if (baselineDate >= asOfDate) throw new Error('Baseline must precede the current date');

const root = path.resolve('data/live-verification');
await initializeStorage(root);
const store = new BhavStore(root);
const baseline = await store.load(baselineDate);
const latest = await store.load(asOfDate);
const settings = loadScreeningConfig();
const current = latest.filter(row => ACTIVE_GROUPS.some(group => row.close >= settings[group].minPrice && row.close <= settings[group].maxPrice));
const ids = new Set(current.map(row => row.isin));
const history = { baseline: baselineDate, current, days: [baseline.filter(row => ids.has(row.isin)), current] };
const candidates = screen(history, settings);
const selected = shortlist(candidates);

function rawRows(date: string): Promise<Record<string, string>[]> {
  return readFile(path.join(root, 'bhav', `${date}.csv`), 'utf8').then(csv => parse(csv, {
    columns: (headers: string[]) => headers.map(header => header.trim()),
    bom: true, skip_empty_lines: true, trim: true,
  }));
}

const [rawBaseline, rawLatest] = await Promise.all([rawRows(baselineDate), rawRows(asOfDate)]);
assert.ok(rawLatest[0] && 'TckrSymb' in rawLatest[0], 'This live verifier expects modern NSE UDiFF files');
const traded = (rows: Record<string, string>[]) => rows.filter(row =>
  row.SctySrs === 'EQ' && (!row.FinInstrmTp || row.FinInstrmTp === 'STK') && Number(row.TtlTradgVol) > 0);
assert.equal(baseline.length, traded(rawBaseline).length);
assert.equal(latest.length, traded(rawLatest).length);
const expectedCurrent = traded(rawLatest).filter(row => ACTIVE_GROUPS.some(group =>
  Number(row.ClsPric) >= settings[group].minPrice && Number(row.ClsPric) <= settings[group].maxPrice));
assert.deepEqual(current.map(row => row.isin).sort(), expectedCurrent.map(row => row.ISIN).sort());

const rawBaseByIsin = new Map(traded(rawBaseline).map(row => [row.ISIN, row]));
const expected: { symbol: string; isin: string; group: string; threshold: number; price: number; change: number; changePercent: number }[] = [];
for (const row of expectedCurrent) {
  const base = rawBaseByIsin.get(row.ISIN);
  if (!base) continue;
  for (const [group, column, direction] of [['gainers', 'HghPric', 1], ['losers', 'LwPric', -1]] as const) {
    if (!ACTIVE_GROUPS.includes(group)) continue;
    const rule = settings[group];
    if (Number(row.ClsPric) < rule.minPrice || Number(row.ClsPric) > rule.maxPrice) continue;
    const baselinePrice = Number(base[column]);
    if (baselinePrice <= 0) continue;
    const deltaPaise = Math.round(Number(row[column]) * 100) - Math.round(baselinePrice * 100);
    if (direction * deltaPaise < Math.round(rule.threshold * 100)) continue;
    expected.push({
      symbol: row.TckrSymb!, isin: row.ISIN!, group,
      threshold: rule.threshold, price: Number(row.ClsPric),
      change: deltaPaise / 100, changePercent: deltaPaise / 100 / baselinePrice * 100,
    });
  }
}
assert.deepEqual(candidates.map(({ symbol, isin, group, threshold, price, change, changePercent }) =>
  ({ symbol, isin, group, threshold, price, change, changePercent })), expected);
for (const group of ACTIVE_GROUPS) {
  const expectedTop = expected.filter(row => row.group === group)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) ||
      a.symbol.localeCompare(b.symbol) || a.isin.localeCompare(b.isin)).slice(0, 25);
  assert.deepEqual(selected[group].map(row => row.isin), expectedTop.map(row => row.isin));
}

const reducedFile = path.join(root, 'reduced', `${asOfDate}.json`);
const reduced = {
  mode: 'endpoint-only-verification',
  warning: 'Two bhavcopies only: not a full-month volume/volatility calculation, researched ranking or corporate-action-adjusted return.',
  ...history,
  settings,
  candidates,
  selected,
};
await atomicWrite(reducedFile, JSON.stringify(reduced, null, 2));
assert.deepEqual(JSON.parse(await readFile(reducedFile, 'utf8')), reduced);

const cached = new BhavStore(root, async () => { throw new Error('Cache verification unexpectedly attempted a download'); });
assert.deepEqual(await cached.load(baselineDate), baseline);
assert.deepEqual(await cached.load(asOfDate), latest);
assert.equal(cached.downloads, 0);

const sample = (group: 'gainers' | 'losers') => selected[group]
  .slice(0, 3).map(row => {
    const raw = expectedCurrent.find(value => value.ISIN === row.isin)!;
    const base = rawBaseByIsin.get(row.isin)!;
    const column = group === 'gainers' ? 'HghPric' : 'LwPric';
    return {
      symbol: row.symbol, close: row.price, changePercent: row.changePercent,
      baselineValue: Number(base[column]), currentValue: Number(raw[column]), delta: row.change,
    };
  });
const report = {
  mode: reduced.mode, baselineDate, asOfDate,
  downloadedThisInvocation: store.downloads,
  rawRows: { baseline: rawBaseline.length, latest: rawLatest.length },
  tradedEquities: { baseline: baseline.length, latest: latest.length },
  filteredEquities: current.length,
  settings,
  candidates: {
    gainers: candidates.filter(row => row.group === 'gainers').length,
    losers: candidates.filter(row => row.group === 'losers').length,
  },
  shortlisted: { gainers: selected.gainers.length, losers: selected.losers.length },
  selected: {
    gainers: selected.gainers.map(({ symbol, price, change, changePercent }, i) => ({ rank: i + 1, symbol, price, change, changePercent })),
    losers: selected.losers.map(({ symbol, price, change, changePercent }, i) => ({ rank: i + 1, symbol, price, change, changePercent })),
  },
  checks: {
    rawCsvCrossCheck: 'passed', reducedJsonRoundTrip: 'passed',
    cachedReadsWithoutNetwork: 'passed', cacheDownloads: cached.downloads, top25RupeeOrder: 'passed',
  },
  samples: { gainers: sample('gainers'), losers: sample('losers') },
  reducedFile,
  warning: reduced.warning,
};
const reportFile = path.join(root, 'runs', `${todayIST()}.${randomUUID()}.json`);
await atomicWrite(reportFile, JSON.stringify(report, null, 2));
assert.deepEqual(JSON.parse(await readFile(reportFile, 'utf8')), report);
console.log(JSON.stringify({ ...report, reportFile }, null, 2));
