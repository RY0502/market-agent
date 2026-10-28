import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessmentSchema, LiveEvidence, refreshClassification, selectStocks, validateAssessment } from '../src/research.js';
import { shortlist } from '../src/bhav.js';
import { publicationRow } from '../src/publish.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { candidate, research } from './helpers.js';

test('live callbacks capture only completed vision page reads', () => {
  const evidence = new LiveEvidence();
  const tool = { lc: 1 as const, type: 'not_implemented' as const, id: ['vision_scrape'] };
  evidence.handleToolStart(tool, '{"url":"https://example.org"}', 'one', undefined, [], {}, 'vision_scrape');
  evidence.handleToolEnd({ content: 'PE is 20 at this page' }, 'one');
  assert.equal(evidence.reads[0]!.url, 'https://example.org');
  assert.equal(evidence.reads[0]!.output, 'PE is 20 at this page');
  evidence.handleToolStart(tool, '{"url":"https://example.org"}', 'two', undefined, [], {}, 'vision_scrape');
  evidence.handleToolError(new Error('timeout'), 'two');
  evidence.handleToolEnd('failed', 'two');
  assert.equal(evidence.reads.length, 1);
});

test('live evidence callbacks work with the installed LangChain tool runtime', async () => {
  const evidence = new LiveEvidence();
  const tool = new DynamicStructuredTool({
    name: 'vision_scrape',
    description: 'Fixture live-page reader',
    schema: z.object({ url: z.string() }),
    func: async () => 'The captured fixture price is 500.',
  });
  await tool.invoke({ url: 'https://example.org/quote' }, { callbacks: [evidence] });
  assert.equal(evidence.reads.length, 1);
  assert.equal(evidence.reads[0]!.output, 'The captured fixture price is 500.');
});

test('assessment rejects fabricated, stale, uncorroborated and corporate-action evidence', () => {
  const c = candidate();
  const valid = research();
  assert.doesNotThrow(() => validateAssessment(valid.assessment, c, valid.reads));
  assert.throws(() => validateAssessment(valid.assessment, c, []), /not observed/);
  assert.throws(() => validateAssessment({ ...valid.assessment, symbol: 'WRONG' }, c, valid.reads), /mismatch/);
  assert.throws(() => validateAssessment({ ...valid.assessment, corporateActionsClear: false }, c, valid.reads), /Classified stocks/);
  assert.throws(() => validateAssessment({ ...valid.assessment, quoteAsOf: '2020-01-01T00:00:00Z' }, c, valid.reads), /stale/);
  assert.throws(() => validateAssessment({
    ...valid.assessment, pe: { ...valid.assessment.pe!, value: 99 },
  }, c, valid.reads), /does not occur/);
  const unclassified = research('EXAMPLE', {
    profitProbability: null, dataGapReason: 'Insufficient verified current financial data to assess the stock.',
  });
  assert.doesNotThrow(() => validateAssessment(unclassified.assessment, c, unclassified.reads));
  assert.throws(() => validateAssessment(unclassified.assessment, c, []), /not observed/);
  assert.throws(() => validateAssessment(research('EXAMPLE', {
    profitProbability: null, dataGapReason: null,
  }).assessment, c, []), /data-gap reason/);
});

test('all shortlisted stocks remain in percentage order regardless of category or data gaps', async () => {
  const candidates = [
    candidate({ symbol: 'LOW', isin: 'INE000A01001', changePercent: 40 }),
    candidate({ symbol: 'HIGH', isin: 'INE000B01001', changePercent: 20 }),
    candidate({ symbol: 'UNKNOWN', isin: 'INE000C01001', changePercent: 30 }),
    candidate({ symbol: 'FALL1', isin: 'INE000D01001', group: 'losers', change: -120, changePercent: -10 }),
    candidate({ symbol: 'FALL2', isin: 'INE000E01001', group: 'losers', change: -150, changePercent: -20 }),
  ];
  const audited: string[] = [];
  const selected = await selectStocks(candidates, async c => {
    const result = research(c.symbol, {
      profitProbability: c.symbol === 'UNKNOWN' ? null : c.symbol === 'LOW' || c.symbol === 'FALL2' ? 'low' : 'high',
      dataGapReason: c.symbol === 'UNKNOWN' ? 'Insufficient verified live financial data to classify the outlook.' : null,
    });
    if (c.symbol === 'UNKNOWN') result.assessment.livePrice = null;
    return result;
  }, async c => { audited.push(c.symbol); });
  assert.equal(selected.gainers.length, 3);
  assert.deepEqual(selected.gainers.map(s => s.candidate.symbol), ['LOW', 'UNKNOWN', 'HIGH']);
  assert.deepEqual(selected.losers.map(s => s.candidate.symbol), ['FALL2', 'FALL1']);
  assert.equal(audited.length, 5);
  const row = publicationRow(selected.gainers[1]!, new Date().toISOString());
  assert.equal(row.price, 500);
  assert.equal(row.change, 120);
  assert.equal(row.profit_probability, null);
  assert.ok(selected.gainers[1]!.research.assessment.dataGapReason);
});

test('only the top 25 by percentage movement in each group are researched, not by absolute rupees', async () => {
  const candidates = ['gainers', 'losers'].flatMap(group => Array.from({ length: 30 }, (_, i) => candidate({
    symbol: `STOCK${i}`, isin: `INE${String(i).padStart(6, '0')}001`,
    group: group as 'gainers' | 'losers', change: group === 'gainers' ? 1000 - i : -1000 + i,
    changePercent: group === 'gainers' ? i + 1 : -i - 1,
  })));
  const researched: string[] = [];
  const result = await selectStocks(candidates, async c => {
    researched.push(`${c.group}/${c.symbol}`);
    return research(c.symbol);
  }, async () => {});
  assert.equal(result.gainers.length, 25);
  assert.equal(result.losers.length, 25);
  assert.equal(researched.length, 50);
  assert.ok(!researched.some(symbol => symbol.endsWith('/STOCK4')));
  assert.equal(result.gainers[0]!.candidate.symbol, 'STOCK29');
  assert.equal(result.losers[0]!.candidate.symbol, 'STOCK29');
  assert.deepEqual(result.gainers.map(stock => stock.rank), Array.from({ length: 25 }, (_, i) => i + 1));
});

test('expired classifications become null with a reason without removing or reranking a stock', () => {
  const stock = { candidate: candidate(), research: research(), riskScore: 20, recoveryScore: 80, rank: 1 };
  refreshClassification(stock, Date.now() + 2 * 3_600_000);
  assert.equal(stock.research.assessment.profitProbability, null);
  assert.match(stock.research.assessment.dataGapReason!, /stale/);
  assert.equal(stock.rank, 1);
});

test('all qualitative categories validate, missing P/E does not exclude bearish stocks, and unknown categories fail', () => {
  for (const profitProbability of ['low', 'medium', 'high'] as const) {
    const result = research('EXAMPLE', { profitProbability, pe: null });
    assert.doesNotThrow(() => validateAssessment(result.assessment, candidate(), result.reads));
    assert.doesNotThrow(() => assessmentSchema.parse(result.assessment));
  }
  assert.throws(() => assessmentSchema.parse({ ...research().assessment, profitProbability: 'certain' }));
  assert.throws(() => assessmentSchema.parse({ ...research().assessment, outlookHorizon: 'next_month' }));
});

test('equal monthly percentage movements use deterministic symbol order', () => {
  const result = shortlist([
    candidate({ symbol: 'ZZZ' }), candidate({ symbol: 'AAA', isin: 'INE000B01001' }),
  ]);
  assert.deepEqual(result.gainers.map(stock => stock.symbol), ['AAA', 'ZZZ']);
});

test('a stock with no verified live metrics is retained with a null category and null context scores', async () => {
  const result = await selectStocks([candidate()], async () => ({
    ...research('EXAMPLE', {
      profitProbability: null, classificationReason: 'Unclassified because current financial evidence could not be verified.',
      dataGapReason: 'Current quote and financial data could not be verified on live sources.',
      fundamentalRisk: null, recoveryScore: null, livePrice: null, quoteAsOf: null,
      pe: null, sectorPe: null, marketCapCrore: null, debtToEquity: null, earningsGrowthPercent: null,
      financialPeriod: '', corporateActionsClear: false, corporateActionEvidence: null, marketEvidence: null, sources: [],
    }),
    reads: [],
  }), async () => {});
  assert.equal(result.gainers.length, 1);
  const row = publicationRow(result.gainers[0]!, new Date().toISOString());
  assert.equal(row.profit_probability, null);
  assert.equal(result.gainers[0]!.riskScore, null);
  assert.equal(result.gainers[0]!.recoveryScore, null);
  assert.ok(result.gainers[0]!.research.assessment.dataGapReason);
});
