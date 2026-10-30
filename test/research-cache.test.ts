import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cacheReuseDays, withResearchCache } from '../src/research-cache.js';
import { LiveEvidence, resolveSubmission, submissionExamples, validateAssessment } from '../src/research.js';
import { candidate, research } from './helpers.js';
import { cleanupRun, initializeStorage } from '../src/storage.js';

test('cache reuse is half the window up to seven days, then capped at seven days', () => {
  assert.equal(cacheReuseDays(2), 1);
  assert.equal(cacheReuseDays(7), 3.5);
  assert.equal(cacheReuseDays(10), 7);
  assert.equal(cacheReuseDays(30), 7);
});

test('background cache reuses the capped window without extending it and still refreshes every assessment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-cache-'));
  let time = Date.now() + 1000;
  const createdAt = time;
  const hit: boolean[] = [];
  const researcher = withResearchCache(root, 30, 'run', async (_candidate, cached) => {
    hit.push(Boolean(cached));
    const result = research();
    result.researchedAt = new Date(time).toISOString();
    return result;
  }, () => time);
  try {
    await initializeStorage(root);
    const fresh = await researcher(candidate());
    assert.deepEqual(fresh.cache, { hit: false, backgroundResearchedAt: undefined, validUntil: undefined });
    time += 6 * 86_400_000;
    const refreshed = await researcher(candidate());
    assert.equal(refreshed.cache!.hit, true);
    assert.equal(refreshed.cache!.backgroundResearchedAt, new Date(createdAt).toISOString());
    assert.match(refreshed.assessment.risks.at(-1)!, /Background research from .* is reused/);
    const file = path.join(root, 'research-cache', `${candidate().isin}.json`);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).result.researchedAt, new Date(createdAt).toISOString());
    await cleanupRun(root, candidate().asOfDate, 'run');
    assert.ok(await readFile(file));
    time += 86_400_000;
    await researcher(candidate());
    assert.deepEqual(hit, [false, true, false]);
    const shorter = withResearchCache(root, 2, 'next', async (_c, cached) => {
      assert.equal(cached, undefined);
      return research();
    }, () => time + 2 * 86_400_000);
    await shorter(candidate());
  } finally { await rm(root, { recursive: true }); }
});

test('cache identity, future dates and corruption fail explicitly; missing evidence is not cached', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-cache-errors-'));
  const file = path.join(root, 'research-cache', `${candidate().isin}.json`);
  try {
    await initializeStorage(root);
    const empty = withResearchCache(root, 30, 'empty', async () => ({ ...research(), reads: [] }));
    await empty(candidate());
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    const first = withResearchCache(root, 30, 'first', async () => research(), () => Date.now() + 1000);
    await first(candidate());
    const valid = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...valid, baselineDate: '2026-02-30' }));
    await assert.rejects(first(candidate()), /date/);
    await writeFile(file, JSON.stringify({ ...valid, baselineDate: valid.asOfDate }));
    await assert.rejects(first(candidate()), /comparison window/);
    await writeFile(file, 'not JSON');
    await assert.rejects(first(candidate()), SyntaxError);
    await writeFile(file, JSON.stringify({ ...valid, isin: 'INE000B01001' }));
    await assert.rejects(first(candidate()), /identity mismatch/);
    valid.result.researchedAt = new Date(Date.now() + 86_400_000).toISOString();
    await writeFile(file, JSON.stringify(valid));
    await assert.rejects(first(candidate()), /future/);
  } finally { await rm(root, { recursive: true }); }
});

test('a failed refresh retains cache-hit provenance without overwriting or extending the cached background', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-cache-report-'));
  try {
    await initializeStorage(root);
    const now = Date.now() + 1000;
    await withResearchCache(root, 30, 'first', async () => research(), () => now)(candidate());
    const file = path.join(root, 'research-cache', `${candidate().isin}.json`);
    const before = await readFile(file, 'utf8');
    const result = await withResearchCache(root, 30, 'failed', async (_candidate, cached) => {
      assert.ok(cached);
      throw new Error('Refresh provider unavailable');
    }, () => now)(candidate());
    assert.equal(result.cache!.hit, true);
    assert.equal(result.cache!.backgroundResearchedAt, JSON.parse(before).result.researchedAt);
    assert.equal(result.assessment.profitProbability, null);
    assert.match(result.failure!.message, /Refresh provider unavailable/);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally { await rm(root, { recursive: true }); }
});

test('cached background retains its original age and uncovered quote/action dates produce warnings', () => {
  const previous = research();
  const now = Date.now();
  const old = new Date(now - 3 * 86_400_000).toISOString();
  previous.researchedAt = old;
  for (const read of previous.reads) read.observedAt = old;
  const evidence = new LiveEvidence({
    result: previous, baselineDate: '2026-09-25', asOfDate: '2026-10-26',
    validUntil: new Date(now + 12 * 86_400_000).toISOString(),
  });
  assert.equal(evidence.reads[0]!.observedAt, old);
  const cachedQuoteId = evidence.reads[0]!.evidenceId!;
  const cachedMarketId = evidence.reads[1]!.evidenceId!;
  evidence.handleToolStart(
    { lc: 1, type: 'not_implemented', id: ['vision_scrape'] }, '{"url":"https://quote.example.org"}',
    'quote', undefined, [], {}, 'vision_scrape',
  );
  evidence.handleToolEnd(previous.reads[0]!.output, 'quote');
  const freshId = evidence.reads[2]!.evidenceId!;
  const input = {
    ...submissionExamples.classified,
    quoteAsOf: previous.assessment.quoteAsOf, quoteTimestampText: previous.assessment.quoteAsOf,
    evidenceIds: {
      livePrice: freshId, marketCapCrore: cachedQuoteId,
      corporateActionEvidence: cachedQuoteId, marketEvidence: cachedMarketId,
    },
  };
  assert.doesNotThrow(() => validateAssessment(resolveSubmission(input, evidence), candidate(), evidence.reads));
  assert.ok(validateAssessment(resolveSubmission(input, evidence), {
    ...candidate(), asOfDate: '2026-10-27',
  }, evidence.reads).some(warning => warning.code === 'corporate_action_coverage'));
  assert.ok(validateAssessment(resolveSubmission({
    ...input, evidenceIds: { ...input.evidenceIds, livePrice: cachedQuoteId },
  }, evidence), candidate(), evidence.reads).some(warning => warning.field === 'livePrice' && warning.code === 'stale_evidence'));
  for (const read of evidence.reads) if (read.cachedAt) read.cacheUntil = new Date(now - 1000).toISOString();
  assert.ok(validateAssessment(resolveSubmission(input, evidence), candidate(), evidence.reads)
    .some(warning => warning.code === 'stale_evidence'));
});
