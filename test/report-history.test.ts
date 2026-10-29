import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BhavStore } from '../src/bhav.js';
import { initializeStorage } from '../src/storage.js';
import { loadScreeningConfig } from '../src/screening.js';
import { candidate, csv, equity, zipResponse } from './helpers.js';

test('charts collect latest trading closes by ISIN across weekends/holidays and cap at min(5, lookback)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'report-history-'));
  const trading = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-23', '2026-10-26'];
  let downloads = 0;
  try {
    await initializeStorage(root);
    const store = new BhavStore(root, async input => {
      const compact = /_(\d{8})_F_/.exec(String(input))![1]!;
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
      if (!trading.includes(date)) return new Response('', { status: 404 });
      downloads++;
      return zipResponse(csv(date, [equity({ date, symbol: date === trading.at(-1) ? 'NEWNAME' : 'OLDNAME',
        close: 480 + trading.indexOf(date) * 5 })]));
    });
    const settings = loadScreeningConfig({ LOOKBACK_DAYS: '7' });
    const history = await store.history('2026-10-26', settings);
    for (const lookback of [2, 3, 5, 30]) {
      const count = Math.min(5, lookback);
      const points = (await store.chartPrices(history, [candidate()], count)).get(candidate().isin)!;
      assert.deepEqual(points, trading.slice(-count).map((date, index) => ({
        date, close: 480 + (trading.length - count + index) * 5,
      })));
    }
    assert.equal(downloads, 5);
    assert.equal(store.downloads, 5, 'Chart generation does not re-download loaded history');
    assert.ok(store.missingDates.includes('2026-10-22'));
    assert.ok(store.missingDates.includes('2026-10-25'));
  } finally { await rm(root, { recursive: true }); }
});

test('short windows backfill earlier trading observations; download cap returns honest partial history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'report-backfill-'));
  const requested: string[] = [];
  try {
    await initializeStorage(root);
    const store = new BhavStore(root, async input => {
      const compact = /_(\d{8})_F_/.exec(String(input))![1]!;
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
      requested.push(date);
      return date === '2026-10-23' ? zipResponse(csv(date)) : new Response('', { status: 404 });
    });
    const current = equity({ date: '2026-10-26' });
    const history = { current: [current], days: [[current]], baseline: '2026-10-26' };
    assert.deepEqual((await store.chartPrices(history, [candidate()], 2)).get(current.isin), [
      { date: '2026-10-23', close: 500 }, { date: '2026-10-26', close: 500 },
    ]);
    assert.deepEqual(requested, ['2026-10-25', '2026-10-24', '2026-10-23']);
    store.downloads = 31;
    await writeFile(path.join(root, 'bhav', '2026-10-25.csv'), csv('2026-10-25'));
    const calls = requested.length;
    assert.equal((await store.chartPrices(history, [candidate()], 5)).get(current.isin)!.length, 3,
      'At the download cap, skip uncached gaps and still use older files already on disk');
    assert.equal(requested.length, calls);
    assert.equal(store.downloads, 31);
    assert.deepEqual(await store.chartPrices(history, [], 5), new Map());
  } finally { await rm(root, { recursive: true }); }
});
