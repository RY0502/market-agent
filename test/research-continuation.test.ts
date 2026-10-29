import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Jobs } from '../src/jobs.js';
import { addDays, todayIST } from '../src/dates.js';
import { createPublisher, publicationRow } from '../src/publish.js';
import { loadScreeningConfig } from '../src/screening.js';
import { ResearchLimitError } from '../src/research-control.js';
import { runResearchProcess } from '../src/research-process.js';
import {
  LiveEvidence, resolveSubmission, selectStocks, submissionExamples, type ResearchResult,
} from '../src/research.js';
import { candidate, csv, equity, research, reportReference, reportStub, seedNse } from './helpers.js';

test('a job publishes all top 25 gainers despite a real worker timeout, provider failures and evidence problems', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-continuation-'));
  const called: string[] = [];
  const inserted: Record<string, unknown>[][] = [];
  const worker = path.join(root, 'stuck-worker.mjs');
  const request: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname.split('/').at(-1), 'top_gainers');
    if (init?.method === 'GET') {
      assert.equal(new URL(String(input)).searchParams.get('limit'), '1');
      return Response.json([], { headers: { 'content-range': '*/0' } });
    }
    assert.equal(init?.method, 'POST');
    inserted.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 201 });
  };
  const jobs = new Jobs({
    root, report: reportStub, screeningConfig: () => loadScreeningConfig({}), resetFrameworkState: async () => {},
    request: async () => { throw new Error('All bhavcopies must come from the seeded cache'); },
    publish: createPublisher('https://example.supabase.co', 'test-key', root, request),
    researcher: () => async c => {
      called.push(c.symbol);
      if (c.symbol === 'STOCK00') return runResearchProcess<ResearchResult>(pathToFileURL(worker), {}, 200);
      if (c.symbol === 'STOCK01') throw new Error('Provider unavailable');
      if (c.symbol === 'STOCK02') throw new Error('Agent did not submit an assessment for STOCK02');
      if (c.symbol === 'STOCK03') throw new ResearchLimitError('Per-stock research budget exhausted');
      if (c.symbol === 'STOCK04') return research('WRONG');
      if (c.symbol === 'STOCK05') return { ...research(c.symbol), reads: [] };
      if (c.symbol === 'STOCK06') {
        const result = research(c.symbol, {
          livePrice: null, quoteAsOf: null, marketEvidence: null, corporateActionsClear: false,
          pe: null, sectorPe: null, earningsGrowthPercent: null,
        });
        result.assessment.marketCapCrore!.value = 132928258048;
        return result;
      }
      if (c.symbol === 'STOCK07') {
        const evidence = new LiveEvidence();
        evidence.handleToolStart(
          { lc: 1, type: 'not_implemented', id: ['vision_scrape'] }, '{"url":"https://example.org/research"}',
          'read', undefined, [], {}, 'vision_scrape',
        );
        evidence.handleToolEnd('Available company context indicates a balanced outlook with material uncertainty.', 'read');
        return {
          assessment: resolveSubmission({
            ...submissionExamples.classified, symbol: c.symbol, marketCapCrore: null,
            evidenceIds: { marketCapCrore: 'unused-citation' },
          }, evidence),
          reads: evidence.reads, researchedAt: new Date().toISOString(),
        };
      }
      return research(c.symbol);
    },
  });
  try {
    await jobs.initialize();
    await writeFile(worker, 'process.on("message", () => { setInterval(() => {}, 1000); });');
    const date = todayIST();
    for (let day = addDays(date, -30); day <= date; day = addDays(day, 1)) {
      await seedNse(root, day);
      await writeFile(path.join(root, 'bhav', `${day}.csv`), csv(day, Array.from({ length: 30 }, (_, index) => {
        const symbol = `STOCK${String(index).padStart(2, '0')}`;
        return equity({
          date: day, symbol, name: symbol, isin: `INE${String(index).padStart(6, '0')}001`,
          close: day === date ? 500 : 300, high: day === date ? 520 : 320, low: day === date ? 480 : 280,
        });
      })));
    }
    const job = await jobs.start(date);
    await jobs.wait();
    const stored = (await jobs.get(job.id))!;
    assert.equal(stored.status, 'completed', stored.error ?? stored.skippedReason);
    const expected = Array.from({ length: 25 }, (_, index) => `STOCK${String(index).padStart(2, '0')}`);
    assert.deepEqual([...called].sort(), expected, 'Parallel cache reads may start researchers in a different order');
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.length, 25);
    assert.deepEqual(inserted[0]!.map(row => row.name), expected);
    for (const row of inserted[0]!) {
      assert.equal(row.price, 500);
      assert.equal(row.change, 200);
      assert.equal(row.change_percent, 62.5);
      assert.deepEqual(Object.keys(row).sort(), ['change', 'change_percent', 'name', 'price', 'profit_probability', 'report_url', 'updated_at']);
      assert.equal(row.report_url, reportReference(String(row.name), job.id).url);
    }
    assert.deepEqual(inserted[0]!.slice(0, 6).map(row => row.profit_probability), Array(6).fill(null));
    assert.equal(inserted[0]![6]!.profit_probability, 'high', 'Missing metrics and uncorroborated cap do not block classification');
    assert.equal(inserted[0]![7]!.profit_probability, 'medium', 'Null cap with a leftover citation does not block classification');
    assert.equal(stored.status, 'completed');
    assert.deepEqual(stored.inserted, { gainers: 25, losers: 0 });
    assert.equal(stored.screened!.length, 30, 'All screened matches remain inspectable even beyond the top-25 cap');
    assert.equal(stored.stockOutcomes!.length, 25);
    assert.equal(stored.stockOutcomes!.filter(outcome => outcome.failure).length, 5);
    assert.match(stored.stockOutcomes![0]!.failure!.message, /deadline exceeded \(200 ms\)/);
    assert.ok(!stored.stockOutcomes![6]!.warnings.some(warning => warning.field === 'marketCapCrore'),
      'Model market cap is ignored; the missing NSE figure is not replaced with an unsupported claim');
    assert.ok(!stored.stockOutcomes![7]!.warnings.some(warning => warning.field === 'marketCapCrore'));
    assert.equal(stored.results, undefined);
    const cacheFiles = await readdir(path.join(root, 'research-cache'));
    assert.ok(!cacheFiles.includes(`${stored.screened![0]!.isin}.json`), 'Worker failures are not cached as successful research');
  } finally { await jobs.wait(); await rm(root, { recursive: true }); }
});

test('a complete research outage still retains every selected row as Unsure with bhavcopy pricing', async () => {
  const candidates = Array.from({ length: 25 }, (_, i) => candidate({
    symbol: `STOCK${i}`, isin: `INE${String(i).padStart(6, '0')}001`, changePercent: 25 - i,
  }));
  const audited: string[] = [];
  const result = await selectStocks(candidates, async () => { throw new Error(''); },
    async c => { audited.push(c.symbol); });
  assert.equal(result.gainers.length, 25);
  assert.equal(audited.length, 25);
  assert.deepEqual(result.gainers.map(stock => stock.rank), Array.from({ length: 25 }, (_, i) => i + 1));
  for (const stock of result.gainers) {
    stock.report = reportReference(stock.candidate.symbol);
    assert.equal(publicationRow(stock, new Date().toISOString()).profit_probability, null);
    assert.equal(publicationRow(stock, new Date().toISOString()).price, 500);
    assert.ok(stock.research.failure);
    assert.ok(stock.research.assessment.dataGapReason);
  }
});

test('audit persistence failures remain explicit operational errors rather than being hidden as research success', async () => {
  await assert.rejects(selectStocks([candidate()], async () => research(), async () => {
    throw new Error('Disk audit write failed');
  }), /Disk audit write failed/);
});
