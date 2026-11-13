import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BhavStore, MissingBhavcopy, UnavailableHistory, archiveUrl, fallbackArchiveUrl, parseBhav, parseBhavDate, screen, shortlist } from '../src/bhav.js';
import { loadScreeningConfig } from '../src/screening.js';
import { addDays, dateValue, monthsBefore, todayIST } from '../src/dates.js';
import { initializeStorage, prune } from '../src/storage.js';
import { csv, equity, secFullCsv, zipResponse } from './helpers.js';

test('calendar-month arithmetic, leap years and IST date', () => {
  assert.equal(monthsBefore('2026-03-31', 1), '2026-02-28');
  assert.equal(monthsBefore('2024-03-31', 1), '2024-02-29');
  assert.equal(monthsBefore('2026-01-31', 2), '2025-11-30');
  assert.equal(todayIST(new Date('2026-10-26T19:00:00Z')), '2026-10-27');
  assert.throws(() => dateValue('2026-02-30'));
});

test('configured day duration changes the baseline and qualifying movement while reusing downloaded history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'day-window-'));
  const date = '2026-10-26';
  const requests: string[] = [];
  const store = new BhavStore(root, async input => {
    const match = String(input).match(/_(\d{8})_F_/)!;
    const raw = match[1]!;
    const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    requests.push(day);
    return zipResponse(csv(day, [equity({
      date: day, close: day === date ? 500 : 350,
      high: day === date ? 520 : day === addDays(date, -30) ? 510 : 400,
      low: 300,
    })]));
  });
  try {
    await initializeStorage(root);
    const week = loadScreeningConfig({ LOOKBACK_DAYS: '7' });
    const short = await store.history(date, week);
    assert.equal(short.baseline, addDays(date, -7));
    assert.equal(requests.length, 31, 'Always downloads 30 days back even for a 7-day screening window');
    assert.deepEqual(screen(short, week).map(c => c.change), [120]);
    const defaults = loadScreeningConfig({});
    const long = await store.history(date, defaults);
    assert.equal(long.baseline, addDays(date, -30));
    assert.equal(requests.length, 31, 'Reuses previously downloaded 30-day history without extra requests');
    assert.deepEqual(screen(long, defaults), []);
  } finally { await rm(root, { recursive: true }); }
});

test('short lookback over weekends/holidays selects latest prior trading day instead of falling back to oldest 30-day date', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holiday-lookback-'));
  // Wednesday 2026-11-11; Tuesday 2026-11-10 was a market holiday
  const date = '2026-11-11';
  const tradingDays = ['2026-10-12', '2026-11-06', '2026-11-09', '2026-11-11'];
  const store = new BhavStore(root, async input => {
    const compact = /_(\d{8})_F_/.exec(String(input))?.[1];
    if (!compact) return new Response('', { status: 404 });
    const day = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    if (!tradingDays.includes(day)) return new Response('', { status: 404 });
    return zipResponse(csv(day, [equity({
      date: day, close: day === date ? 500 : 450,
      high: day === date ? 520 : 460, low: 400,
    })]));
  });
  try {
    await initializeStorage(root);
    const oneDayConfig = loadScreeningConfig({ LOOKBACK_DAYS: '1' });
    const history = await store.history(date, oneDayConfig);
    // Baseline should be the latest trading day prior to screenTarget (2026-11-09), NOT 30 days ago (2026-10-12)
    assert.equal(history.baseline, '2026-11-09');
    assert.equal(history.days.length, 2);
    assert.equal(history.days[0]![0]!.date, '2026-11-09');
    const candidates = screen(history, oneDayConfig);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.baselineDate, '2026-11-09');
    assert.equal(candidates[0]!.asOfDate, '2026-11-11');
  } finally { await rm(root, { recursive: true }); }
});

test('official modern and legacy URL conventions and fallback URL', () => {
  assert.equal(archiveUrl('2026-10-26'), 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20261026_F_0000.csv.zip');
  assert.equal(archiveUrl('2024-01-02'), 'https://nsearchives.nseindia.com/content/historical/EQUITIES/2024/JAN/cm02JAN2024bhav.csv.zip');
  assert.equal(fallbackArchiveUrl('2026-11-11'), 'https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_11112026.csv');
  assert.equal(fallbackArchiveUrl('2026-03-02'), 'https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_02032026.csv');
});

test('parseBhavDate handles ISO, legacy NSE format, and Full bhavcopy DATE1 format', () => {
  assert.equal(parseBhavDate('2026-11-11'), '2026-11-11');
  assert.equal(parseBhavDate('11-Nov-2026'), '2026-11-11');
  assert.equal(parseBhavDate('02-JAN-2024'), '2024-01-02');
  assert.equal(parseBhavDate(' 15-Mar-2025 '), '2025-03-15');
  assert.throws(() => parseBhavDate('invalid-date'), /Invalid bhavcopy date/);
});

test('sec_bhavdata_full parser validates dates, converts turnover from lacs, and assigns valid ISIN', () => {
  const full = secFullCsv('2026-11-11', [
    equity({ symbol: 'STOCKA', close: 100, high: 105, low: 95, volume: 1000, turnover: 100_000 }),
    equity({ symbol: 'STOCKB', isin: 'INE123B01020', close: 200, high: 210, low: 190, volume: 500, turnover: 100_000 }),
  ]);
  const isinMap = new Map([['STOCKB', 'INE123B01020']]);
  const parsed = parseBhav(full, '2026-11-11', isinMap);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.symbol, 'STOCKA');
  assert.ok(/^IN[A-Z0-9]{10}$/.test(parsed[0]!.isin));
  assert.equal(parsed[0]!.close, 100);
  assert.equal(parsed[0]!.high, 105);
  assert.equal(parsed[0]!.low, 95);
  assert.equal(parsed[0]!.volume, 1000);
  assert.equal(parsed[0]!.turnover, 100_000);
  assert.equal(parsed[1]!.symbol, 'STOCKB');
  assert.equal(parsed[1]!.isin, 'INE123B01020');

  assert.throws(() => parseBhav(full, '2026-11-12'), /date mismatch/);
  assert.throws(() => parseBhav(full.replace('TURNOVER_LACS', 'BAD_COL'), '2026-11-11'), /Missing bhavcopy column/);
  assert.throws(() => parseBhav(full.replace(/, EQ,/g, ', BE,'), '2026-11-11'), /No EQ/);
});

test('modern/legacy parsers validate dates, series, schema and numbers', () => {
  const modern = csv('2026-10-26');
  assert.equal(parseBhav('\uFEFF' + modern, '2026-10-26')[0]!.close, 500);
  const legacy = 'SYMBOL,SERIES,ISIN,TIMESTAMP,CLOSE,HIGH,LOW,TOTTRDQTY,TOTTRDVAL\nEXAMPLE,EQ,INE000A01001,02-JAN-2024,500,520,480,100000,50000000';
  assert.equal(parseBhav(legacy, '2024-01-02')[0]!.symbol, 'EXAMPLE');
  assert.throws(() => parseBhav(modern, '2026-10-25'), /date mismatch/);
  assert.throws(() => parseBhav(modern.replace('500,520', 'oops,520'), '2026-10-26'), /Invalid ClsPric/);
  assert.throws(() => parseBhav(modern.replace('TtlTrfVal', 'bad'), '2026-10-26'), /Missing bhavcopy column/);
  assert.throws(() => parseBhav(modern.replace(',EQ,', ',BE,'), '2026-10-26'), /No EQ/);
  assert.throws(() => parseBhav(modern + '\n' + modern.split('\n')[1], '2026-10-26'), /duplicate/);
  const withUntraded = csv('2026-10-26', [
    equity(),
    equity({ symbol: 'UNTRADED', isin: 'INE000B01001', high: 0, low: 0, close: 500, volume: 0 }),
  ]);
  assert.equal(parseBhav(withUntraded, '2026-10-26').length, 1);
});

test('endpoint HIGH/LOW deltas, exact thresholds, percent denominator and ISIN continuity', () => {
  const base = [
    equity({ symbol: 'OLDNAME', high: 400, low: 300, close: 400, date: '2026-09-25' }),
    equity({ symbol: 'OTHER', isin: 'INE000B01001', high: 650, low: 600, close: 620, date: '2026-09-25' }),
  ];
  const current = [
    equity({ high: 500, low: 200, close: 450 }),
    equity({ symbol: 'OTHER', isin: 'INE000B01001', high: 600, low: 550, close: 570 }),
  ];
  const found = screen({ current, baseline: '2026-09-25', days: [base, current] }, loadScreeningConfig({}));
  assert.equal(found.length, 1);
  assert.deepEqual(found.map(c => [c.symbol, c.group, c.threshold, c.change]),
    [['EXAMPLE', 'gainers', 5, 100]]);
  assert.equal(found[0]!.changePercent, 25);
  assert.equal(found[0]!.volumeRatio, 1);
});

test('percentage thresholds screen stocks meeting minimum gain', () => {
  const base = equity({ close: 400.1, high: 400, low: 390, date: '2026-09-25' });
  const latest = equity({ close: 500.1, high: 500, low: 480 });
  const found = screen({ current: [latest], baseline: base.date, days: [[base], [latest]] }, loadScreeningConfig({}));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.threshold, 5);
  assert.equal(found[0]!.change, 100);
});

test('separate price ranges and configurable thresholds apply per group, with no fallback', () => {
  const settings = loadScreeningConfig({
    GAINERS_INCREASE_PCT: '12.5', LOSERS_DECREASE_PCT: '7.5',
    GAINERS_MIN_PRICE: '400', GAINERS_MAX_PRICE: '2100',
    LOSERS_MIN_PRICE: '400', LOSERS_MAX_PRICE: '1500',
  });
  const make = (close: number, high: number, low: number, rules = settings) => {
    const current = [equity({ close, high, low })];
    const base = [equity({ date: '2026-09-25', close: 1700, high: 1800, low: 1600 })];
    return screen({ current, baseline: '2026-09-25', days: [base, current] }, rules);
  };
  assert.deepEqual(make(1500, 2070, 1500).map(c => [c.group, c.threshold]), [['gainers', 12.5]]);
  assert.deepEqual(make(1600, 2070, 1500).map(c => c.group), ['gainers']);
  assert.equal(make(1550, 1900, 1524.51, {
    ...settings, losers: { ...settings.losers, maxPrice: 1600 },
  }).length, 0);
});

test('screening env validates values and both range bounds', () => {
  const defaults = loadScreeningConfig({});
  assert.deepEqual(defaults, {
    lookbackDays: 30,
    gainers: { threshold: 5, minPrice: 400, maxPrice: 2000 },
    losers: { threshold: 5, minPrice: 400, maxPrice: 1500 },
  });
  assert.equal(loadScreeningConfig({ LOOKBACK_DAYS: '10' }).lookbackDays, 10);
  for (const invalid of ['0', '-1', '1.5', '', 'NaN']) {
    assert.throws(() => loadScreeningConfig({ LOOKBACK_DAYS: invalid }));
  }
  for (const invalid of ['0', '-1', '', 'NaN', 'Infinity']) {
    assert.throws(() => loadScreeningConfig({ GAINERS_INCREASE_PCT: invalid }));
  }
  assert.throws(() => loadScreeningConfig({ LOSERS_MIN_PRICE: '1600', LOSERS_MAX_PRICE: '1500' }));
  assert.deepEqual(shortlist([]), { gainers: [], losers: [] });
});

test('turnover filtering excludes stocks below minimum daily turnover threshold', () => {
  const settings = loadScreeningConfig({
    GAINERS_MIN_TURNOVER_CR: '5',
  });
  assert.equal(settings.gainers.minTurnoverCr, 5);

  const baseLow = equity({ date: '2026-09-25', isin: 'INE001A01001', symbol: 'LOWTURN', close: 500, high: 500, low: 480, turnover: 10_000_000 });
  const currentLow = equity({ date: '2026-10-25', isin: 'INE001A01001', symbol: 'LOWTURN', close: 600, high: 620, low: 580, turnover: 10_000_000 });

  const baseHigh = equity({ date: '2026-09-25', isin: 'INE002B01002', symbol: 'HIGHTURN', close: 500, high: 500, low: 480, turnover: 60_000_000 });
  const currentHigh = equity({ date: '2026-10-25', isin: 'INE002B01002', symbol: 'HIGHTURN', close: 600, high: 620, low: 580, turnover: 60_000_000 });

  const history = {
    current: [currentLow, currentHigh],
    baseline: '2026-09-25',
    days: [[baseLow, baseHigh], [currentLow, currentHigh]],
  };

  const filtered = screen(history, settings);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.symbol, 'HIGHTURN');
  assert.equal(filtered[0]!.averageTurnoverCr, 6);
});

test('history filters latest price only, reuses raw cache and probes weekend baseline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-bhav-'));
  try {
    await initializeStorage(root);
    let calls = 0;
    const request: typeof fetch = async input => {
      calls++;
      const match = /_(\d{8})_F_/.exec(String(input));
      if (!match) return new Response('', { status: 404 });
      const compact = match[1]!;
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
      const weekday = dateValue(date).getUTCDay();
      if (weekday === 0 || weekday === 6) return new Response('', { status: 404 });
      return zipResponse(csv(date, [
        equity({ date, close: date === '2026-03-31' ? 500 : 450, high: 520, low: 400 }),
        equity({ date, symbol: 'OUT', isin: 'INE000B01001', close: 2001, high: 2100, low: 1900 }),
      ]));
    };
    const store = new BhavStore(root, request);
    const history = await store.history('2026-03-31', loadScreeningConfig({}));
    assert.equal(history.baseline, '2026-03-02');
    assert.ok(!store.missingDates.includes('2026-02-28'), '30 days before March 31 is March 1, not February 28');
    assert.ok(store.missingDates.includes('2026-03-01'));
    assert.equal(history.current.length, 1);
    assert.equal(history.days[0]![0]!.close, 450);
    assert.ok(history.days.every(day => day.length === 1));
    assert.ok(store.downloads <= 31);
    const previous = calls;
    await store.load('2026-03-31');
    assert.equal(calls, previous);
    assert.ok((await readFile(path.join(root, 'bhav', '2026-03-31.csv'), 'utf8')).includes('OUT'));
    assert.ok(!(await readFile(path.join(root, 'reduced', '2026-03-31.json'), 'utf8')).includes('"OUT"'));
  } finally { await rm(root, { recursive: true }); }
});

test('strict requested day, access failure, corrupt ZIP and download cap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-cap-'));
  try {
    await initializeStorage(root);
    const missing = new BhavStore(root, async () => new Response('', { status: 404 }));
    await assert.rejects(missing.history('2026-10-26', loadScreeningConfig({})), MissingBhavcopy);
    await assert.rejects(new BhavStore(root, async () => new Response('', { status: 403 })).load('2026-10-26'), /403/);
    await assert.rejects(new BhavStore(root, async () => new Response('not a zip')).load('2026-10-26'));
    let calls = 0;
    const store = new BhavStore(root, async () => { calls++; return zipResponse(csv('2026-10-26')); });
    store.downloads = 31;
    await assert.rejects(store.load('2026-10-26'), /31 bhavcopy/);
    assert.equal(calls, 0);
    assert.equal(store.downloads, 31);
  } finally { await rm(root, { recursive: true }); }
});

test('baseline advances over holidays; history omits gaps and includes special weekend sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-holidays-'));
  try {
    await initializeStorage(root);
    const requested: string[] = [];
    const request: typeof fetch = async input => {
      const match = /_(\d{8})_F_/.exec(String(input));
      if (!match) return new Response('', { status: 404 });
      const compact = match[1]!;
      const day = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
      requested.push(day);
      const weekday = dateValue(day).getUTCDay();
      const specialSession = day === '2026-10-03';
      if (['2026-09-28', '2026-09-29', '2026-10-02'].includes(day) ||
        (!specialSession && (weekday === 0 || weekday === 6))) return new Response('', { status: 404 });
      return zipResponse(csv(day, [equity({
        date: day, close: day === '2026-10-28' ? 500 : 350,
        high: day === '2026-10-28' ? 520 : 400, low: 300,
        volume: day === '2026-10-28' ? 200 : 100,
      })]));
    };
    const store = new BhavStore(root, request);
    const history = await store.history('2026-10-28', loadScreeningConfig({}));
    assert.equal(history.baseline, '2026-09-30');
    assert.ok(history.days.some(day => day[0]?.date === '2026-10-03'), 'Do not assume all weekends are closed');
    assert.ok(!history.days.some(day => day[0]?.date === '2026-10-02'));
    assert.ok(requested.every(day => day >= '2026-09-28'));
    assert.equal(new Set(requested).size, requested.length, 'Missing dates must not be probed twice');
    assert.ok(store.missingDates.includes('2026-10-02'));
    const candidates = screen(history, loadScreeningConfig({}));
    assert.equal(candidates[0]!.change, 120);
    assert.equal(candidates[0]!.baselineDate, '2026-09-30');
    assert.equal(candidates[0]!.observations, history.days.length);
    assert.equal(candidates[0]!.averageVolume, 100);
    assert.equal(candidates[0]!.volumeRatio, 2);
    assert.equal(store.downloads, history.days.length);
    assert.ok(store.downloads <= 31);
  } finally { await rm(root, { recursive: true }); }
});

test('history never uses the current day as its baseline when no older file exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-no-history-'));
  try {
    await initializeStorage(root);
    const store = new BhavStore(root, async input => String(input).includes('20261028')
      ? zipResponse(csv('2026-10-28')) : new Response('', { status: 404 }));
    await assert.rejects(store.history('2026-10-28', loadScreeningConfig({})), UnavailableHistory);
    assert.equal(store.downloads, 1);
    assert.equal(store.missingDates.length, 30);
    assert.deepEqual(await readdir(path.join(root, 'reduced')), []);
  } finally { await rm(root, { recursive: true }); }
});

test('historical access errors and rate limits fail explicitly instead of masquerading as holidays', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-history-error-'));
  try {
    await initializeStorage(root);
    for (const status of [403, 429, 503]) {
      const store = new BhavStore(root, async input => String(input).includes('20261028')
        ? zipResponse(csv('2026-10-28')) : new Response('', { status }));
      await assert.rejects(store.history('2026-10-28', loadScreeningConfig({})), new RegExp(`HTTP ${status}`));
      assert.deepEqual(store.missingDates, []);
    }
  } finally { await rm(root, { recursive: true }); }
});

test('a run downloads exactly 31 files at most, but can still read cached files afterward', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-limit-'));
  try {
    await initializeStorage(root);
    let requests = 0;
    const store = new BhavStore(root, async input => {
      requests++;
      const compact = /_(\d{8})_F_/.exec(String(input))![1]!;
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
      return zipResponse(csv(date));
    });
    for (let i = 0; i < 31; i++) await store.load(addDays('2026-09-01', i));
    assert.equal(store.downloads, 31);
    assert.equal(requests, 31);
    await assert.rejects(store.load('2026-10-02'), /31 bhavcopy/);
    await store.load('2026-09-01');
    assert.equal(requests, 31);
    assert.equal((await readdir(path.join(root, 'bhav'))).length, 31);
  } finally { await rm(root, { recursive: true }); }
});

test('retention removes only recognized files older than 45 days including sec_bhavdata_full', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-prune-'));
  try {
    await initializeStorage(root);
    await Promise.all(['2026-09-11.csv', '2026-09-11.csv.abcd.tmp', '2026-09-12.csv',
      'sec_bhavdata_full_11092026.csv', 'sec_bhavdata_full_12092026.csv', 'notes.txt'].map(file =>
      writeFile(path.join(root, 'bhav', file), 'test')));
    await Promise.all(['2026-09-11.pe.csv', '2026-09-11.pr.zip', '2026-09-11.pe.csv.abcd.tmp',
      '2026-09-12.pe.csv', '2026-09-12.pr.zip', 'notes.txt'].map(file =>
      writeFile(path.join(root, 'nse', file), 'test')));
    await prune(root, '2026-10-27');
    assert.deepEqual((await readdir(path.join(root, 'bhav'))).sort(), ['2026-09-12.csv', 'notes.txt', 'sec_bhavdata_full_12092026.csv']);
    assert.deepEqual((await readdir(path.join(root, 'nse'))).sort(), ['2026-09-12.pe.csv', '2026-09-12.pr.zip', 'notes.txt']);
  } finally { await rm(root, { recursive: true }); }
});

test('BhavStore fallback behavior: prefers primary daily bhavcopy, falls back on 404, fails only when both are 404', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-fallback-'));
  try {
    await initializeStorage(root);
    const requestedUrls: string[] = [];

    // Case 1: Primary succeeds (200) -> 1st preference, fallback is never requested
    const primaryStore = new BhavStore(root, async input => {
      requestedUrls.push(String(input));
      return zipResponse(csv('2026-11-10'));
    });
    const primaryResult = await primaryStore.load('2026-11-10');
    assert.equal(primaryResult.length, 1);
    assert.equal(requestedUrls.length, 1);
    assert.ok(requestedUrls[0]!.includes('BhavCopy_NSE_CM'));

    // Case 2: Primary is 404, fallback is 200 -> falls back to sec_bhavdata_full
    requestedUrls.length = 0;
    const fallbackStore = new BhavStore(root, async input => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('BhavCopy_NSE_CM')) return new Response('', { status: 404 });
      if (url.includes('sec_bhavdata_full_11112026.csv')) {
        return new Response(secFullCsv('2026-11-11'), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    const fallbackResult = await fallbackStore.load('2026-11-11');
    assert.equal(fallbackResult.length, 1);
    assert.equal(requestedUrls.length, 2);
    assert.ok(requestedUrls[0]!.includes('BhavCopy_NSE_CM'));
    assert.ok(requestedUrls[1]!.includes('sec_bhavdata_full_11112026.csv'));

    // Case 3: Both primary and fallback are 404 -> fails with MissingBhavcopy
    requestedUrls.length = 0;
    const missingStore = new BhavStore(root, async input => {
      requestedUrls.push(String(input));
      return new Response('', { status: 404 });
    });
    await assert.rejects(missingStore.load('2026-11-12'), MissingBhavcopy);
    assert.equal(requestedUrls.length, 2);
    assert.ok(requestedUrls[0]!.includes('BhavCopy_NSE_CM'));
    assert.ok(requestedUrls[1]!.includes('sec_bhavdata_full_12112026.csv'));
    assert.deepEqual(missingStore.missingDates, ['2026-11-12']);

    // Case 4: Primary returns 403 / 503 -> fails immediately without requesting fallback
    requestedUrls.length = 0;
    const errorStore = new BhavStore(root, async input => {
      requestedUrls.push(String(input));
      return new Response('', { status: 403 });
    });
    await assert.rejects(errorStore.load('2026-11-13'), /HTTP 403/);
    assert.equal(requestedUrls.length, 1, 'Does not fallback on non-404 primary error');

    // Case 5: Cached fallback file in root/bhav/sec_bhavdata_full_14112026.csv loads without download
    await writeFile(path.join(root, 'bhav', 'sec_bhavdata_full_14112026.csv'), secFullCsv('2026-11-14'));
    const cachedStore = new BhavStore(root, async () => { throw new Error('Should not make network requests'); });
    const cachedResult = await cachedStore.load('2026-11-14');
    assert.equal(cachedResult.length, 1);
    assert.equal(cachedStore.downloads, 0);
  } finally { await rm(root, { recursive: true }); }
});

test('history analysis uses fallback when prior day primary bhav is missing, and continues as is if both missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-history-fallback-'));
  try {
    await initializeStorage(root);
    const date = '2026-10-28';
    const store = new BhavStore(root, async input => {
      const url = String(input);
      // Current day: primary is available
      if (url.includes('20261028')) {
        return zipResponse(csv('2026-10-28', [equity({ date: '2026-10-28', close: 500, high: 520, low: 400 })]));
      }
      // Special day 2026-10-01: primary is 404, fallback is available!
      if (url.includes('sec_bhavdata_full_01102026.csv')) {
        return new Response(secFullCsv('2026-10-01', [equity({ date: '2026-10-01', close: 350, high: 360, low: 340 })]));
      }
      // Weekend or missing dates: both primary and fallback return 404
      return new Response('', { status: 404 });
    });

    const config = loadScreeningConfig({ LOOKBACK_DAYS: '30' });
    const history = await store.history(date, config);
    // Baseline should be found (2026-10-01 from fallback)
    assert.equal(history.baseline, '2026-10-01');
    assert.equal(history.current.length, 1);
    assert.equal(history.days[0]![0]!.date, '2026-10-01');
    assert.equal(history.days[0]![0]!.close, 350);
    // Verified: history analysis continued as is despite missing primary bhav file on 2026-10-01!
  } finally { await rm(root, { recursive: true }); }
});

test('parseBhav successfully parses actual NSE sample file sec_bhavdata_full_11112026.csv', async () => {
  const samplePath = 'C:/Users/Swati/.gemini/antigravity/brain/6e4961f1-6920-41d4-8063-430dad880146/.user_uploaded/media_1794421415533_8351bd60.csv';
  try {
    const content = await readFile(samplePath, 'utf8');
    const parsed = parseBhav(content, '2026-11-11');
    assert.ok(parsed.length > 2000, `Expected >2000 equities, got ${parsed.length}`);
    const first = parsed[0]!;
    assert.equal(first.symbol, '20MICRONS');
    assert.equal(first.date, '2026-11-11');
    assert.equal(first.close, 188.12);
    assert.equal(first.high, 189.78);
    assert.equal(first.low, 186.2);
    assert.equal(first.volume, 52116);
    assert.equal(first.turnover, 9819000);
    assert.ok(/^IN[A-Z0-9]{10}$/.test(first.isin));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File not present in this test environment, skip
      return;
    }
    throw err;
  }
});
