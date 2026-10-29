import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSubmissionSchema, activeSubmissionExamples, prepareSubmission, selectStocks,
  unsureResearch, validateAssessment, LiveEvidence,
} from '../src/research.js';
import { normalizeSubmissionArguments } from '../src/schema-diagnostics.js';
import { compactResearchContext, researchEvidencePage, qualitativeCachedText } from '../src/research-refresh.js';
import { hasMismatchedNseDate } from '../src/nse-narrative.js';
import { researchLimitsSchema } from '../src/research-control.js';
import type { NseFundamentals } from '../src/nse-fundamentals.js';
import { candidate, research } from './helpers.js';

function nse(): NseFundamentals {
  const source = { url: 'https://nsearchives.nseindia.com/test', excerpt: 'NSE 2026-10-26 SYMBOL P/E=3.85; market cap INR crore=1000' };
  return {
    asOf: '2026-10-26', pe: { value: 3.85, source }, adjustedPe: 4, marketCapCrore: { value: 1000, source },
    historical: { pe: null, adjustedPe: null, marketCapCrore: null }, missingFiles: [], corporateActions: [],
    history: [
      { date: '2026-09-30', symbol: 'EXAMPLE', pe: 5.13, adjustedPe: 5.2, marketCapCrore: 900 },
      { date: '2026-10-26', symbol: 'EXAMPLE', pe: 3.85, adjustedPe: 4, marketCapCrore: 1000 },
    ],
  };
}

test('decision formatting is normalized using model explanations, without inventing categories or rationales', () => {
  for (const [raw, expected] of [[' HIGH ', 'high'], ['Medium','medium'], ['LOW','low'], ['Unsure',null]] as const) {
    const { args } = normalizeSubmissionArguments({
      ...activeSubmissionExamples.classified, profitProbability: raw, classificationReason: 'Mixed',
      dataGapReason: expected === null ? 'The overall available evidence is inconclusive.' : '',
    }, activeSubmissionSchema);
    const prepared = prepareSubmission(args, 'EXAMPLE', activeSubmissionSchema);
    assert.equal(prepared.input.profitProbability, expected);
    assert.match(prepared.input.classificationReason, /Mixed/);
    assert.ok(prepared.input.classificationReason.length >= 20);
    assert.deepEqual(prepared.warnings, []);
  }
  const { args } = normalizeSubmissionArguments({
    ...activeSubmissionExamples.classified, profitProbability: '80%', classificationReason: 'Mixed', reasons: [],
  }, activeSubmissionSchema);
  assert.equal(prepareSubmission(args, 'EXAMPLE', activeSubmissionSchema).input.profitProbability, null);
});

test('cached narratives, previews and on-demand pages cannot reintroduce old numerical claims', () => {
  const result = research();
  result.assessment.marketContext = 'PE 762.85x is very high. Execution remains uncertain.';
  result.assessment.risks = ['Earnings growth 8.40% supports the thesis.', 'Competition remains material.'];
  result.assessment.recoveryCatalysts = ['An order worth 100 crore.', 'New customer relationships.'];
  result.reads[0]!.output = result.assessment.marketContext;
  const cached = { result, baselineDate: '2026-09-28', asOfDate: '2026-10-26', validUntil: '2026-11-15T12:00:00Z' };
  const evidence = new LiveEvidence(cached);
  const context = compactResearchContext(cached, evidence);
  assert.doesNotMatch(context, /762\.85|8\.40|100 crore/);
  assert.match(context, /Execution remains uncertain|Competition remains material/);
  assert.doesNotMatch(researchEvidencePage(evidence, evidence.reads[0]!.evidenceId!, 0), /762\.85/);
  assert.match(result.reads[0]!.output, /762\.85/, 'Original audit evidence remains unchanged');
  assert.equal(qualitativeCachedText('PE 762.85x. Competition remains.'), 'Competition remains.');
});

test('incorrect historical valuation dates and value/date pairs are removed rather than silently corrected', () => {
  const data = nse();
  assert.equal(hasMismatchedNseDate('NSE P/E of 3.85 (asOf 2026-10-26) is low.', data), false);
  assert.equal(hasMismatchedNseDate('Historical P/E 5.13 on 2026-09-30.', data), false);
  assert.equal(hasMismatchedNseDate('Historical P/E 5.13 on 2026-10-03.', data), true);
  assert.equal(hasMismatchedNseDate('Historical P/E 5.13 on 2026-10-26.', data), true);
  const c = candidate({ nse: data });
  const result = research();
  result.assessment.classificationReason = 'NSE P/E 5.13 on 2026-10-03 supports this decision.';
  result.assessment.reasons = [result.assessment.classificationReason];
  validateAssessment(result.assessment, c, result.reads);
  assert.equal(result.assessment.profitProbability, null);
  assert.ok(result.assessment.warnings?.some(warning => warning.code === 'historical_nse_claim_mismatch'));
  assert.doesNotMatch(result.assessment.classificationReason, /2026-10-03/);
  assert.ok(result.assessment.reasons.every(reason => !reason.includes('2026-10-03')));
});

test('research failure does not falsely discard or deny available NSE evidence', () => {
  const c = candidate({ nse: nse() });
  const result = unsureResearch(c, new Error('Model unavailable'));
  assert.equal(result.assessment.profitProbability, null);
  assert.equal(result.assessment.pe!.value, 3.85);
  assert.equal(result.assessment.marketCapCrore!.value, 1000);
  assert.ok(result.reads.some(read => read.kind === 'nse'));
  assert.ok(!result.assessment.warnings?.some(warning => warning.code === 'no_research_evidence'));
  assert.ok(!result.assessment.risks.some(risk => risk.includes('Only bhavcopy')));
  assert.ok(result.failure);
});

for (const concurrency of [1, 5]) {
  test(`research batches honor concurrency ${concurrency} while keeping audit order and stock failures isolated`, async () => {
    const candidates = Array.from({ length: 9 }, (_, i) => candidate({
      symbol: `STOCK${i}`, isin: `INE${String(i).padStart(6,'0')}001`, changePercent: 100 - i,
    }));
    let active = 0;
    let peak = 0;
    const audited: string[] = [];
    const result = await selectStocks(candidates, async c => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      if (c.symbol === 'STOCK2') throw new Error('Isolated provider error');
      return research(c.symbol);
    }, async c => {
      assert.equal(active, 0, 'Audit writes occur after the current research batch settles');
      audited.push(c.symbol);
    }, 'concurrency-test', concurrency);
    assert.equal(peak, concurrency);
    assert.deepEqual(audited, candidates.map(c => c.symbol));
    assert.deepEqual(result.gainers.map(stock => stock.rank), candidates.map((_, i) => i + 1));
    assert.equal(result.gainers.filter(stock => stock.research.failure).length, 1);
    assert.equal(result.gainers.length, 9);
  });
}

test('research defaults to a six-minute deadline', () => {
  assert.equal(researchLimitsSchema.parse({}).RESEARCH_TIMEOUT_MS, 360000);
});

test('default stock concurrency is five and invalid settings fail before any research', async () => {
  const previous = process.env.RESEARCH_CONCURRENCY;
  delete process.env.RESEARCH_CONCURRENCY;
  try {
    let active = 0;
    let peak = 0;
    const candidates = Array.from({ length: 6 }, (_, i) => candidate({
      symbol: `STOCK${i}`, isin: `INE${String(i).padStart(6,'0')}001`, changePercent: 100 - i,
    }));
    await selectStocks(candidates, async c => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return research(c.symbol);
    }, async () => {});
    assert.equal(peak, 5);
    await assert.rejects(selectStocks(candidates, async () => {
      assert.fail('Invalid concurrency must not launch research');
    }, async () => {}, 'invalid-concurrency', 0));
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_CONCURRENCY;
    else process.env.RESEARCH_CONCURRENCY = previous;
  }
});
