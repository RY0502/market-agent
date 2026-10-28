import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BhavStore, MissingBhavcopy, archiveUrl, parseBhav, screen, shortlist } from '../src/bhav.js';
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
    equity({ symbol: 'OLDNAME', high: 400, low: 300, close: 350, date: '2026-09-25' }),
    equity({ symbol: 'OTHER', isin: 'INE000B01001', high: 650, low: 600, close: 620, date: '2026-09-25' }),
  ];
  const current = [
    equity({ high: 500, low: 200, close: 400 }),
    equity({ symbol: 'OTHER', isin: 'INE000B01001', high: 600, low: 550, close: 570 }),
  ];
  const found = screen({ current, baseline: '2026-09-25', days: [base, current] }, loadScreeningConfig({}));
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(c => [c.symbol, c.group, c.threshold, c.change]),
    [['EXAMPLE', 'gainers', 100, 100], ['EXAMPLE', 'losers', 100, -100]]);
  assert.equal(found[0]!.changePercent, 25);
  assert.equal(found[1]!.changePercent, -100 / 300 * 100);
  assert.equal(found[0]!.volumeRatio, 1);
});

test('rupee thresholds use integer paise, avoiding floating-point boundary exclusion', () => {
  const base = equity({ close: 100.1, high: 100.2, low: 100, date: '2026-09-25' });
  const latest = equity({ close: 200.1, high: 200.2, low: 200 });
  const found = screen({ current: [latest], baseline: base.date, days: [[base], [latest]] }, loadScreeningConfig({}));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.threshold, 100);
  assert.equal(found[0]!.change, 100);
});

test('separate price ranges and configurable thresholds apply per group, with no fallback', () => {
  const settings = loadScreeningConfig({
    GAINERS_INCREASE_RS: '125.25', LOSERS_DECREASE_RS: '75.5',
    GAINERS_MIN_PRICE: '300', GAINERS_MAX_PRICE: '2100',
    LOSERS_MIN_PRICE: '200', LOSERS_MAX_PRICE: '1500',
  });
  const make = (close: number, high: number, low: number, rules = settings) => {
    const current = [equity({ close, high, low })];
    const base = [equity({ date: '2026-09-25', close: 1700, high: 1800, low: 1600 })];
    return screen({ current, baseline: '2026-09-25', days: [base, current] }, rules);
  };
  assert.deepEqual(make(1500, 1925.25, 1500).map(c => [c.group, c.threshold]), [['gainers', 125.25], ['losers', 75.5]]);
  assert.deepEqual(make(1600, 1925.25, 1500).map(c => c.group), ['gainers']);
  assert.equal(make(1550, 1925.24, 1524.51, {
    ...settings, losers: { ...settings.losers, maxPrice: 1600 },
  }).length, 0);
});

test('screening env validates values and both range bounds', () => {
  const defaults = loadScreeningConfig({});
  assert.deepEqual(defaults, {
    gainers: { threshold: 100, minPrice: 200, maxPrice: 2000 },
    losers: { threshold: 100, minPrice: 200, maxPrice: 1500 },
  });
  for (const invalid of ['0', '-1', '', 'NaN', 'Infinity', '0.001']) {
    assert.throws(() => loadScreeningConfig({ GAINERS_INCREASE_RS: invalid }));
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
        equity({ date, close: date === '2026-03-31' ? 200 : 150, high: 220, low: 100 }),
        equity({ date, symbol: 'OUT', isin: 'INE000B01001', close: 2001, high: 2100, low: 1900 }),
      ]));
    };
    const store = new BhavStore(root, request);
    const history = await store.history('2026-03-31', loadScreeningConfig({}));
    assert.equal(history.baseline, '2026-02-27');
    assert.equal(history.current.length, 1);
    assert.equal(history.days[0]![0]!.close, 150);
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

test('retention removes only recognized files older than two calendar months', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-prune-'));
  try {
    await initializeStorage(root);
    await Promise.all(['2026-08-26.csv', '2026-08-26.csv.abcd.tmp', '2026-08-27.csv', 'notes.txt'].map(file =>
      writeFile(path.join(root, 'bhav', file), 'test')));
    await prune(root, '2026-10-27');
    assert.deepEqual((await readdir(path.join(root, 'bhav'))).sort(), ['2026-08-27.csv', 'notes.txt']);
  } finally { await rm(root, { recursive: true }); }
});
