import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BhavStore, MissingBhavcopy, UnavailableHistory, archiveUrl, parseBhav, screen, shortlist } from '../src/bhav.js';
import { loadScreeningConfig } from '../src/screening.js';
import { addDays, dateValue, monthsBefore, todayIST } from '../src/dates.js';
import { initializeStorage, prune } from '../src/storage.js';
import { csv, equity, zipResponse } from './helpers.js';

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

test('official modern and legacy URL conventions', () => {
  assert.equal(archiveUrl('2026-10-26'), 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20261026_F_0000.csv.zip');
  assert.equal(archiveUrl('2024-01-02'), 'https://nsearchives.nseindia.com/content/historical/EQUITIES/2024/JAN/cm02JAN2024bhav.csv.zip');
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

test('history filters latest price only, reuses raw cache and probes weekend baseline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-bhav-'));
  try {
    await initializeStorage(root);
    let calls = 0;
    const request: typeof fetch = async input => {
      calls++;
      const match = /_(\d{8})_F_/.exec(String(input));
      const compact = match![1]!;
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
      const compact = /_(\d{8})_F_/.exec(String(input))![1]!;
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

test('retention removes only recognized files older than 45 days', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-prune-'));
  try {
    await initializeStorage(root);
    await Promise.all(['2026-09-11.csv', '2026-09-11.csv.abcd.tmp', '2026-09-12.csv', 'notes.txt'].map(file =>
      writeFile(path.join(root, 'bhav', file), 'test')));
    await Promise.all(['2026-09-11.pe.csv', '2026-09-11.pr.zip', '2026-09-11.pe.csv.abcd.tmp',
      '2026-09-12.pe.csv', '2026-09-12.pr.zip', 'notes.txt'].map(file =>
      writeFile(path.join(root, 'nse', file), 'test')));
    await prune(root, '2026-10-27');
    assert.deepEqual((await readdir(path.join(root, 'bhav'))).sort(), ['2026-09-12.csv', 'notes.txt']);
    assert.deepEqual((await readdir(path.join(root, 'nse'))).sort(), ['2026-09-12.pe.csv', '2026-09-12.pr.zip', 'notes.txt']);
  } finally { await rm(root, { recursive: true }); }
});
