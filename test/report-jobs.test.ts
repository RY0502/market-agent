import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from '../src/jobs.js';
import { todayIST, addDays } from '../src/dates.js';
import { loadScreeningConfig } from '../src/screening.js';
import { csv, equity, reportReference, research, seedNse } from './helpers.js';

for (const lookback of [2, 3, 30]) {
  test(`jobs persist report URLs and cache provenance before publication with a ${lookback}-day window`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'report-job-'));
    let reports = 0;
    let publications = 0;
    let failUpload = false;
    let enriched = 0;
    const date = todayIST();
    const jobs: Jobs = new Jobs({
      root, screeningConfig: () => loadScreeningConfig({ LOOKBACK_DAYS: String(lookback) }),
      resetFrameworkState: async () => {},
      researcher: () => async c => research(c.symbol),
      enrich: async stocks => {
        enriched++;
        stocks[0]!.research.assessment.profitProbability = 'medium';
        stocks[0]!.research.assessment.classificationReason = 'The completed enrichment changes the final investment outlook.';
      },
      request: async () => { throw new Error('All bhavcopies must be cached'); },
      report: async (stock, runId, prices, count) => {
        reports++;
        assert.equal(enriched, reports);
        assert.equal(stock.research.assessment.profitProbability, 'medium');
        if (failUpload) throw new Error('Cloudflare upload unavailable');
        assert.equal(count, Math.min(5, lookback));
        assert.equal(prices.length, count);
        assert.equal(prices.at(-1)!.date, date);
        return reportReference(stock.candidate.symbol, runId);
      },
      publish: async (results, runId) => {
        publications++;
        assert.equal(results.gainers[0]!.report!.url, reportReference('EXAMPLE', runId).url);
        const persisted = (await jobs.get(runId))!;
        assert.equal(results.gainers[0]!.research.assessment.profitProbability, 'medium');
        assert.equal(persisted.stockOutcomes![0]!.profitProbability, 'medium');
        assert.equal(persisted.stockOutcomes![0]!.classificationReason, 'The completed enrichment changes the final investment outlook.');
        assert.equal(persisted.stockOutcomes![0]!.report!.url, results.gainers[0]!.report!.url);
        assert.equal(persisted.stockOutcomes![0]!.cache!.hit, publications > 1);
      },
    });
    try {
      await jobs.initialize();
      for (let day = addDays(date, -30); day <= date; day = addDays(day, 1)) {
        await seedNse(root, day);
        await writeFile(path.join(root, 'bhav', `${day}.csv`), csv(day, [equity({
          date: day, close: day === date ? 500 : 300, high: day === date ? 520 : 320, low: day === date ? 480 : 280,
        })]));
      }
      for (let run = 0; run < 2; run++) {
        const job = await jobs.start(date);
        await jobs.wait();
        const saved = (await jobs.get(job.id))!;
        assert.equal(saved.status, 'completed', saved.error);
        assert.equal(saved.stockOutcomes![0]!.cache!.hit, run > 0);
        assert.ok(saved.stockOutcomes![0]!.report!.expiresAt);
      }
      failUpload = true;
      const failed = await jobs.start(date);
      await jobs.wait();
      const saved = (await jobs.get(failed.id))!;
      assert.equal(saved.status, 'failed');
      assert.equal(saved.phase, 'reporting');
      assert.match(saved.error!, /Cloudflare upload unavailable/);
      assert.equal(publications, 2, 'Upload failure must prevent Supabase cleanup and insertion');
      assert.equal(reports, 3);
    } finally { await jobs.wait(); await rm(root, { recursive: true }); }
  });
}
