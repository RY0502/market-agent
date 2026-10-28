import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Jobs } from '../src/jobs.js';
import { createHttpServer } from '../src/http.js';
import { addDays, monthsBefore, todayIST } from '../src/dates.js';
import { initializeStorage } from '../src/storage.js';
import { csv, equity, research, zipResponse } from './helpers.js';
import { loadScreeningConfig } from '../src/screening.js';
import { publicationFile } from '../src/publish.js';

async function seed(root: string) {
  const date = todayIST();
  for (let day = monthsBefore(date, 1); day <= date; day = addDays(day, 1)) {
    await writeFile(path.join(root, 'bhav', `${day}.csv`), csv(day, [
      equity({ date: day, close: day === date ? 500 : 300, high: day === date ? 520 : 320, low: day === date ? 480 : 280 }),
      equity({ date: day, symbol: 'FALL', isin: 'INE000B01001', close: day === date ? 500 : 800,
        high: day === date ? 520 : 820, low: day === date ? 480 : 780 }),
    ]));
  }
}

test('unauthenticated HTTP trigger runs both groups, persists status, rejects overlaps and publishes once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-http-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let publications = 0;
  const jobs = new Jobs({
    root,
    screeningConfig: () => loadScreeningConfig({}),
    researcher: () => async c => { await gate; return research(c.symbol); },
    publish: async (result, id) => {
      publications++;
      assert.equal(result.gainers.length, 1);
      assert.equal(result.losers.length, 1);
      assert.equal(result.losers[0]!.candidate.change, -300);
      await writeFile(publicationFile(root, id), '{"phase":"inserted"}');
      await writeFile(path.join(root, 'runs', `${todayIST()}.${id}.jsonl`), 'legacy intermediate');
    },
    request: async () => { throw new Error('All bhavcopies should be cached'); },
  });
  const server = createHttpServer(jobs);
  try {
    await jobs.initialize();
    await seed(root);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const invalid = await fetch(`${base}/runs`, { method: 'POST', body: '{"date":"2026-02-30"}' });
    assert.equal(invalid.status, 400);
    const started = await fetch(`${base}/runs`, { method: 'POST', body: '{}' });
    assert.equal(started.status, 202);
    const response = await started.json() as { id: string; statusUrl: string };
    assert.equal((await fetch(`${base}/runs`, { method: 'POST', body: '{}' })).status, 409);
    release();
    await jobs.wait();
    const status = await fetch(`${base}${response.statusUrl}`);
    const result = await status.json() as { status: string; downloads: number };
    assert.equal(result.status, 'completed');
    assert.equal(result.downloads, 0);
    assert.equal(publications, 1);
    assert.deepEqual(await readdir(path.join(root, 'reduced')), []);
    assert.ok((await readdir(path.join(root, 'bhav'))).length > 1);
    assert.equal((await jobs.get(response.id))!.results, undefined);
    assert.deepEqual((await jobs.get(response.id))!.inserted, { gainers: 1, losers: 1 });
    assert.ok((await readdir(path.join(root, 'runs'))).every(file => file.endsWith(`.${response.id}.json`)));
    assert.equal((await fetch(`${base}/runs/invalid`)).status, 404);
  } finally {
    release();
    await jobs.wait();
    server.close();
    await rm(root, { recursive: true });
  }
});

for (const date of ['2026-10-25', '2026-10-20']) {
test(`missing requested-day bhavcopy (${date}) skips without research or Supabase operations`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-missing-'));
  let researched = false;
  let published = false;
  const jobs = new Jobs({
    root, request: async () => new Response('', { status: 404 }),
    screeningConfig: () => loadScreeningConfig({}),
    researcher: () => async c => { researched = true; return research(c.symbol); },
    publish: async () => { published = true; },
  });
  try {
    await jobs.initialize();
    const job = await jobs.start(date);
    await jobs.wait();
    const result = await jobs.get(job.id);
    assert.equal(result!.status, 'skipped');
    assert.match(result!.skippedReason!, /No NSE bhavcopy/);
    assert.equal(result!.error, undefined);
    assert.deepEqual(result!.missingDates, [job.date]);
    assert.equal(researched, false);
    assert.equal(published, false);
    assert.equal((await jobs.get(job.id))!.id, job.id);
  } finally { await rm(root, { recursive: true }); }
});
}

test('a run with no available historical baseline skips without touching Supabase', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-skip-history-'));
  let researched = false;
  let published = false;
  const jobs = new Jobs({
    root, screeningConfig: () => loadScreeningConfig({}),
    request: async input => String(input).includes('20261028')
      ? zipResponse(csv('2026-10-28')) : new Response('', { status: 404 }),
    researcher: () => async c => { researched = true; return research(c.symbol); },
    publish: async () => { published = true; },
  });
  try {
    await jobs.initialize();
    const job = await jobs.start('2026-10-28');
    await jobs.wait();
    const result = await jobs.get(job.id);
    assert.equal(result!.status, 'skipped');
    assert.match(result!.skippedReason!, /No historical bhavcopy/);
    assert.equal(researched, false);
    assert.equal(published, false);
  } finally { await rm(root, { recursive: true }); }
});

test('publication failure persists failed state and preserves audit research', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-pubfail-'));
  const jobs = new Jobs({
    root,
    screeningConfig: () => loadScreeningConfig({}),
    researcher: () => async c => research(c.symbol),
    publish: async (_results, id) => {
      await writeFile(publicationFile(root, id), '{"phase":"insert_started"}');
      throw new Error('Supabase unavailable');
    },
  });

  try {
    await initializeStorage(root);
    await seed(root);
    await jobs.initialize();
    const job = await jobs.start();
    await jobs.wait();
    const result = await jobs.get(job.id);
    assert.equal(result!.status, 'failed');
    assert.equal(result!.phase, 'publishing');
    assert.match(result!.error!, /Supabase unavailable/);
    assert.equal(result!.results!.gainers.length, 1);
    assert.ok((await readdir(path.join(root, 'reduced'))).length > 0);
    assert.ok((await readdir(path.join(root, 'runs'))).includes(`${job.id}.publication.json`));
  } finally { await rm(root, { recursive: true }); }
});

test('each new run snapshots fresh screening settings and reuses cached files without fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-settings-'));
  let settings = loadScreeningConfig({});
  let researched = 0;
  const counts: number[] = [];
  const jobs = new Jobs({
    root, screeningConfig: () => settings,
    researcher: () => async c => { researched++; return research(c.symbol); },
    publish: async results => { counts.push(results.gainers.length + results.losers.length); },
    request: async () => { throw new Error('New settings must reuse original cached CSVs'); },
  });
  try {
    await jobs.initialize();
    await seed(root);
    const first = await jobs.start();
    await jobs.wait();
    settings = loadScreeningConfig({ GAINERS_INCREASE_RS: '300', LOSERS_DECREASE_RS: '400' });
    const second = await jobs.start();
    await jobs.wait();
    assert.deepEqual(counts, [2, 0]);
    assert.equal(researched, 2);
    assert.equal((await jobs.get(first.id))!.settings.gainers.threshold, 100);
    assert.equal((await jobs.get(second.id))!.settings.gainers.threshold, 300);
    assert.equal((await jobs.get(second.id))!.downloads, 0);
  } finally { await rm(root, { recursive: true }); }
});
