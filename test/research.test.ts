import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessmentSchema, LiveEvidence, refreshClassification, selectStocks, validateAssessment } from '../src/research.js';
import { shortlist } from '../src/bhav.js';
import { ACTIVE_GROUPS } from '../src/screening.js';
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

test('Tavily search captures per-result evidence and recency with the installed tool runtime', async () => {
  const evidence = new LiveEvidence();
  const tool = new DynamicStructuredTool({
    name: 'tavily_search', description: 'Fixture recent search',
    schema: z.object({ query: z.string(), topic: z.string(), days: z.number() }),
    func: async () => JSON.stringify({
      answer: 'Generated answer is not evidence',
      results: [
        { url: 'https://example.org/quote', content: 'Price is 500 on this page.', published_date: new Date().toISOString() },
        { url: 'https://other.org/earnings', raw_content: 'Quarterly growth is 12 percent.' },
      ],
    }),
  });
  await tool.invoke({ query: 'example quote', topic: 'news', days: 1 }, { callbacks: [evidence] });
  assert.equal(evidence.reads.length, 2);
  assert.equal(evidence.reads[0]!.output, 'Price is 500 on this page.');
  assert.equal(evidence.reads[0]!.newsDays, 1);
  assert.equal(evidence.reads[1]!.output, 'Quarterly growth is 12 percent.');
  assert.ok(evidence.reads.every(read => !read.output.includes('Generated answer')));
});

test('Tavily crawl is captured as indexed evidence, never as a scraped live page', () => {
  const evidence = new LiveEvidence();
  const tool = { lc: 1 as const, type: 'not_implemented' as const, id: ['tavily_crawl'] };
  evidence.handleToolStart(tool, '{"url":"https://example.org"}', 'crawl', undefined, [], {}, 'tavily_crawl');
  evidence.handleToolEnd(JSON.stringify({ results: [{ url: 'https://example.org', raw_content: 'PE is 20 on this page.' }] }), 'crawl');
  assert.equal(evidence.reads[0]!.kind, 'tavily');
  assert.equal(evidence.reads[0]!.newsDays, undefined);
  evidence.handleToolStart(tool, '{"url":"https://example.org"}', 'bad', undefined, [], {}, 'tavily_crawl');
  assert.throws(() => evidence.handleToolEnd('not JSON', 'bad'), /invalid JSON/);
});

test('Tavily publication-date, quote and source-quality problems are nonblocking warnings', () => {
  const result = research();
  const reads = result.reads.map(read => ({
    ...read, kind: 'tavily' as const, publishedAt: new Date().toISOString(), newsDays: 1,
  }));
  assert.doesNotThrow(() => validateAssessment(result.assessment, candidate(), reads));
  for (const publishedAt of [undefined, 'not a date', '2020-01-01T00:00:00Z', new Date(Date.now() + 86_400_000).toISOString()]) {
    assert.ok(validateAssessment(result.assessment, candidate(),
      reads.map(read => ({ ...read, publishedAt }))).some(warning => warning.code === 'publication_date_unverified'));
  }
  for (const newsDays of [undefined, 0, 8]) {
    assert.ok(validateAssessment(result.assessment, candidate(),
      reads.map(read => ({ ...read, newsDays }))).some(warning => warning.code === 'publication_date_unverified'));
  }
  const wrongQuote = { ...result.assessment, quoteAsOf: new Date(Date.now() - 3_600_000).toISOString() };
  assert.ok(validateAssessment(wrongQuote, candidate(), reads).some(warning => warning.code === 'quote_timestamp_not_in_excerpt'));
  assert.ok(validateAssessment(result.assessment, candidate(),
    reads.map(read => ({ ...read, url: 'https://unrelated.org' }))).some(warning => warning.code === 'unobserved_source'));
  assert.ok(validateAssessment(result.assessment, candidate(),
    reads.map(read => ({ ...read, observedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })))
    .some(warning => warning.code === 'stale_evidence'));
  assert.equal(result.assessment.profitProbability, 'high');
});

test('assessment collects all evidence caveats, retains model decisions, and still enforces stock identity', () => {
  const c = candidate();
  const valid = research();
  assert.doesNotThrow(() => validateAssessment(valid.assessment, c, valid.reads));
  assert.throws(() => validateAssessment({ ...valid.assessment, symbol: 'WRONG' }, c, valid.reads), /mismatch/);
  const partial = { ...valid.assessment, corporateActionsClear: false, quoteAsOf: '2020-01-01T00:00:00Z',
    pe: { ...valid.assessment.pe!, value: 99 } };
  const warnings = validateAssessment(partial, c, valid.reads);
  for (const code of ['corporate_actions_uncertain', 'quote_freshness', 'numeric_evidence_mismatch']) {
    assert.ok(warnings.some(warning => warning.code === code));
  }
  assert.equal(partial.profitProbability, 'high');
  const count = warnings.length;
  assert.equal(validateAssessment(partial, c, valid.reads).length, count, 'Repeated checks do not duplicate warnings');
  const unclassified = research('EXAMPLE', {
    profitProbability: null, dataGapReason: 'Insufficient verified current financial data to assess the stock.',
  });
  assert.doesNotThrow(() => validateAssessment(unclassified.assessment, c, unclassified.reads));
  assert.doesNotThrow(() => validateAssessment(unclassified.assessment, c, []));
  const unexplained = research('EXAMPLE', {
    profitProbability: null, dataGapReason: null,
  });
  validateAssessment(unexplained.assessment, c, unexplained.reads);
  assert.match(unexplained.assessment.dataGapReason!, /did not establish/);
});

test('all shortlisted stocks remain in rupee-gain order regardless of category or data gaps', async () => {
  const candidates = [
    candidate({ symbol: 'LOW', isin: 'INE000A01001', change: 150, changePercent: 20 }),
    candidate({ symbol: 'HIGH', isin: 'INE000B01001', change: 110, changePercent: 40 }),
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
  assert.deepEqual(selected.losers, []);
  assert.equal(audited.length, 3);
  const row = publicationRow({ ...selected.gainers[1]!, report: {
    url: 'https://reports.example.org/stock.html', expiresAt: '2100-01-01T00:00:00.000Z',
  } }, new Date().toISOString());
  assert.equal(row.price, 500);
  assert.equal(row.change, 120);
  assert.equal(row.profit_probability, null);
  assert.ok(selected.gainers[1]!.research.assessment.dataGapReason);
});

test('only the top 25 by rupee movement are researched, not by percentage, with losers still paused', async () => {
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
  assert.equal(result.losers.length, 0);
  assert.equal(researched.length, 25);
  assert.deepEqual(researched, Array.from({ length: 25 }, (_, index) => `gainers/STOCK${index}`));
  assert.equal(result.gainers[0]!.candidate.symbol, 'STOCK0');
  assert.deepEqual(result.gainers.map(stock => stock.rank), Array.from({ length: 25 }, (_, i) => i + 1));
});

test('the loser shortlist uses the 25 largest rupee falls when enabled, not percentage loss', t => {
  t.after(() => { Reflect.deleteProperty(ACTIVE_GROUPS, 'includes'); });
  Object.defineProperty(ACTIVE_GROUPS, 'includes', { configurable: true, value: () => true });
  const result = shortlist(Array.from({ length: 30 }, (_, index) => candidate({
    symbol: `LOSS${index}`, isin: `INE${String(index).padStart(6, '0')}001`,
    group: 'losers', change: -100 - index, changePercent: -100 + index,
  })));
  assert.deepEqual(result.gainers, []);
  assert.deepEqual(result.losers.map(stock => stock.symbol),
    Array.from({ length: 25 }, (_, index) => `LOSS${29 - index}`));
});

test('expired evidence adds explicit warnings without blocking, changing or reranking the model outlook', () => {
  const stock = { candidate: candidate(), research: research(), riskScore: 20, recoveryScore: 80, rank: 1 };
  refreshClassification(stock, Date.now() + 2 * 3_600_000);
  assert.equal(stock.research.assessment.profitProbability, 'high');
  assert.equal(stock.research.assessment.dataGapReason, null);
  assert.ok(stock.research.assessment.warnings?.some(warning => warning.code === 'stale_evidence'));
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

test('equal monthly rupee movements use deterministic symbol order regardless of percentage', () => {
  const result = shortlist([
    candidate({ symbol: 'ZZZ', changePercent: 90 }), candidate({ symbol: 'AAA', isin: 'INE000B01001', changePercent: 10 }),
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
  const row = publicationRow({ ...result.gainers[0]!, report: {
    url: 'https://reports.example.org/stock.html', expiresAt: '2100-01-01T00:00:00.000Z',
  } }, new Date().toISOString());
  assert.equal(row.profit_probability, null);
  assert.equal(result.gainers[0]!.riskScore, null);
  assert.equal(result.gainers[0]!.recoveryScore, null);
  assert.ok(result.gainers[0]!.research.assessment.dataGapReason);
});
