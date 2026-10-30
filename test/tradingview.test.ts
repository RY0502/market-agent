import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { TodoListMiddleware } from 'freetier-deepagent-framework';
import type { createAgent } from 'langchain';
import { z } from 'zod';
import { attachTradingView, enrichStocks, needsTradingView, parseTradingViewOutput, scrapeTradingView, tradingViewMarketCap, tradingViewPrompt } from '../src/tradingview.js';
import { renderStockReport } from '../src/reports.js';
import { createFinalAssessmentPolicy, activeSubmissionSchema, type RankedStock } from '../src/research.js';
import { ResearchDiagnostics, researchLimitsSchema } from '../src/research-control.js';
import { hasMismatchedNseDate } from '../src/nse-narrative.js';
import { candidate, research, ScriptedModel } from './helpers.js';

const output = JSON.stringify({
  symbol: 'EXAMPLE', pe: '31.1', marketCap: '20.36 B INR', basicEpsTtm: '30.00 INR',
  netIncomeFy: '646.55 M INR', revenueFy: '4.39 B INR', dividendYieldIndicated: null,
  beta1y: '1.61', sector: 'Consumer Durables', industry: 'Other Consumer Specialties',
  companyDescription: 'Company operates in the jewellery industry.',
});

/** Create a stock with no current or historical NSE valuation figures. */
function stock(symbol = 'EXAMPLE'): RankedStock {
  const c = candidate();
  c.symbol = symbol;
  c.nse = { asOf: c.asOfDate, pe: null, adjustedPe: null, marketCapCrore: null,
    historical: { pe: null, adjustedPe: null, marketCapCrore: null }, history: [], corporateActions: [], missingFiles: [] };
  return { candidate: c, research: research(symbol, { pe: null, marketCapCrore: null }), rank: 1, riskScore: 20, recoveryScore: 80 };
}

test('only missing NSE figures or an unsure assessment trigger enrichment', () => {
  const s = stock();
  assert.equal(needsTradingView(s), true);
  s.candidate.nse!.historical.pe = { value: 20, asOf: '2026-10-20', source: { url: 'https://nse.example/pe', excerpt: 'P/E 20' } };
  s.candidate.nse!.marketCapCrore = { value: 100, source: { url: 'https://nse.example/cap', excerpt: '100 Cr' } };
  assert.equal(needsTradingView(s), false);
  s.research.assessment.profitProbability = null;
  assert.equal(needsTradingView(s), true);
  assert.match(tradingViewPrompt('EXAMPLE'), /Basic EPS \(TTM\)/);
  assert.match(tradingViewPrompt('EXAMPLE'), /Net income \(FY\)/);
  assert.doesNotMatch(tradingViewPrompt('EXAMPLE'), /pros|cons/i);
});

test('the scrape request uses the exact TradingView NSE URL and retries 429 once after 45 seconds', async () => {
  const calls: { url: string; prompt: string }[] = [];
  const sleeps: number[] = [];
  const page = await scrapeTradingView('EXAMPLE', async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return calls.length === 1 ? new Response('', { status: 429 }) : new Response(output);
  }, async ms => { sleeps.push(ms); });
  assert.equal(page.url, 'https://in.tradingview.com/symbols/NSE-EXAMPLE/');
  assert.deepEqual(sleeps, [45_000]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, page.url);
  assert.match(calls[0]!.prompt, /earnings Ratio \(TTM\)/);
});

test('network failures retry only once; other failures and invalid symbols do not retry', async () => {
  let calls = 0;
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  await assert.rejects(scrapeTradingView('EXAMPLE', async () => {
    calls++; throw new TypeError('fetch failed');
  }, sleep));
  assert.equal(calls, 2);
  assert.deepEqual(waits, [45_000]);
  calls = 0;
  await assert.rejects(scrapeTradingView('EXAMPLE', async () => { calls++; return new Response('', { status: 403 }); }, sleep));
  assert.equal(calls, 1);
  await assert.rejects(scrapeTradingView('../OTHER', async () => { throw new Error('must not call'); }, sleep), /Invalid NSE symbol/);
});

test('extraction accepts numeric values and normalizes missing key statistics', () => {
  const parsed = parseTradingViewOutput(JSON.stringify({ symbol: 'NSE:EXAMPLE', pe: 31.1, marketCap: 'N/A', beta1y: '-' }), 'EXAMPLE');
  assert.equal(parsed.pe, '31.1');
  assert.equal(parsed.marketCap, null);
  assert.equal(parsed.beta1y, null);
  assert.equal(parsed.basicEpsTtm, null);
  assert.equal(parseTradingViewOutput(JSON.stringify({ symbol: 'NSE-EXAMPLE', pe: 20 }), 'EXAMPLE').pe, '20');
  assert.throws(() => parseTradingViewOutput(JSON.stringify({ symbol: 'BSE:EXAMPLE', pe: 20 }), 'EXAMPLE'), /symbol mismatch/);
  assert.throws(() => parseTradingViewOutput(JSON.stringify({ symbol: 'EXAMPLE', pe: 'null' }), 'EXAMPLE'), /no usable data/);
});

test('extraction verifies stock identity, units, and never overwrites current or historical NSE values', () => {
  assert.equal(parseTradingViewOutput(JSON.stringify({ result: output }), 'EXAMPLE').pe, '31.1');
  assert.throws(() => parseTradingViewOutput(output, 'OTHER'), /symbol mismatch/);
  assert.throws(() => parseTradingViewOutput('not json', 'EXAMPLE'));
  assert.equal(tradingViewMarketCap('20.36 B INR'), 2036);
  assert.equal(tradingViewMarketCap('INR 2.5 M'), 0.25);
  assert.equal(tradingViewMarketCap('1 T INR'), 100000);
  assert.equal(tradingViewMarketCap('10000000 INR'), 1);
  assert.equal(tradingViewMarketCap('INR 1,000 Cr'), 1000);
  assert.equal(tradingViewMarketCap('20.36 B USD'), undefined);
  assert.equal(tradingViewMarketCap('20.36 B'), undefined);
  const s = stock();
  s.candidate.nse!.historical.pe = { value: 18, asOf: '2026-10-20', source: { url: 'https://nse.example/pe', excerpt: 'P/E 18' } };
  s.research.assessment.pe = s.candidate.nse!.historical.pe;
  const page = { url: 'https://in.tradingview.com/symbols/NSE-EXAMPLE/', output, observedAt: new Date().toISOString() };
  const enriched = attachTradingView(s, page);
  assert.equal(enriched.assessment.pe!.value, 18);
  assert.equal(enriched.assessment.marketCapCrore!.value, 2036);
  assert.equal(enriched.reads.at(-1)!.output, output);
  assert.equal(s.research.assessment.marketCapCrore, null);
  const noUnits = attachTradingView(stock(), { ...page, output: output.replace('20.36 B INR', '16756') });
  assert.equal(noUnits.assessment.marketCapCrore, null);
});

test('the observed PNGSREVA TradingView response attaches a sourced TTM P/E and INR crore market cap', () => {
  const s = stock('PNGSREVA');
  const page = {
    url: 'https://in.tradingview.com/symbols/NSE-PNGSREVA/',
    output: '{"marketCap":"20.36 B INR","pe":"21.70","symbol":"PNGSREVA"}',
    observedAt: new Date().toISOString(),
  };
  const result = attachTradingView(s, page);
  assert.equal(result.assessment.pe?.value, 21.7);
  assert.equal(result.assessment.marketCapCrore?.value, 2036);
  assert.equal(result.assessment.pe?.source?.excerpt, page.output);
  assert.equal(result.reads.at(-1)?.url, page.url);
});

test('enrichment is sequential, reuses captured Tavily evidence and preserves original results on failure', async () => {
  const first = stock();
  first.research.reads[0]!.kind = 'tavily';
  const second = stock('SECOND');
  let active = 0;
  const order: string[] = [];
  await enrichStocks([first, second], '/unused', 'run', async symbol => {
    active++;
    assert.equal(active, 1);
    order.push(`scrape ${symbol}`);
    await Promise.resolve();
    active--;
    if (symbol === 'SECOND') throw new Error('unavailable');
    return { url: `https://in.tradingview.com/symbols/NSE-${symbol}/`, output, observedAt: new Date().toISOString() };
  }, async (_stock, prior) => {
    order.push('reassess EXAMPLE');
    assert.ok(prior.reads.some(read => read.kind === 'tavily'));
    assert.ok(prior.reads.some(read => read.output.includes('646.55 M INR')));
    prior.assessment.profitProbability = 'medium';
    return prior;
  });
  assert.deepEqual(order, ['scrape EXAMPLE', 'reassess EXAMPLE', 'scrape SECOND']);
  assert.equal(first.research.assessment.profitProbability, 'medium');
  assert.equal(first.research.assessment.marketCapCrore!.value, 2036);
  assert.equal(second.research.assessment.profitProbability, 'high');
  assert.ok(second.research.assessment.warnings?.some(warning => warning.code === 'tradingview_enrichment_failed'));
  const html = renderStockReport(first, 'run', [], 1, new Date().toISOString(), '2100-01-01T00:00:00Z');
  assert.match(html, /TradingView retrieved/);
  assert.match(html, /P\/E \(TTM\)/);
  assert.match(html, /2,036/);
  assert.ok(!first.research.assessment.warnings?.some(warning => warning.code === 'numeric_evidence_mismatch'));
  assert.doesNotMatch(html, /NSE P\/E history/);
});

test('an empty TradingView extraction preserves original research without reassessment', async () => {
  const s = stock();
  let reassessments = 0;
  await enrichStocks([s], '/unused', 'run', async () => ({
    url: 'https://in.tradingview.com/symbols/NSE-EXAMPLE/',
    output: JSON.stringify({ symbol: 'EXAMPLE', pe: null, marketCap: 'N/A' }),
    observedAt: new Date().toISOString(),
  }), async (_stock, prior) => { reassessments++; return prior; });
  assert.equal(reassessments, 0);
  assert.equal(s.research.assessment.profitProbability, 'high');
  assert.ok(s.research.assessment.warnings?.some(warning => warning.code === 'tradingview_enrichment_failed'));
});

test('dated TradingView valuations accept explicitly attributed, converted market-cap amounts', () => {
  const nse = stock().candidate.nse!;
  const evidence = [{ date: '2026-10-30', values: [2036, 31.1] }];
  assert.equal(hasMismatchedNseDate('TradingView market cap 20.36 B INR as of 2026-10-30.', nse, evidence), false);
  assert.equal(hasMismatchedNseDate('TradingView P/E 31.1 on 2026-10-30.', nse, evidence), false);
  assert.equal(hasMismatchedNseDate('TradingView market cap 20.37 B INR as of 2026-10-30.', nse, evidence), true);
  assert.equal(hasMismatchedNseDate('NSE market cap 20.36 B INR as of 2026-10-30.', nse, evidence), true);
});

test('final assessment exposes only submission and does not execute Tavily or scraping', async () => {
  const { createDeepAgent }: { createDeepAgent: typeof createAgent } =
    createRequire(import.meta.resolve('freetier-deepagent-framework'))('deepagents');
  let submitted = false;
  const model = new ScriptedModel([new AIMessage({ content: '', tool_calls: [
    { name: 'submit_stock_assessment', id: 'final', type: 'tool_call', args: {} },
  ] })]);
  const submit = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Submit', schema: z.object({}),
    func: async () => { submitted = true; return 'accepted'; },
  });
  const forbidden = ['tavily_search', 'vision_scrape'].map(name => new DynamicStructuredTool({
    name, description: 'Forbidden', schema: z.object({}),
    func: async () => { throw new Error(`${name} must not run`); },
  }));
  const diagnostics = new ResearchDiagnostics({ runId: 'test', symbol: 'EXAMPLE' },
    researchLimitsSchema.parse({}), activeSubmissionSchema, () => {}, () => {});
  const agent = createDeepAgent({ model, tools: [submit, ...forbidden], middleware: [
    TodoListMiddleware(), createFinalAssessmentPolicy(() => submitted, diagnostics),
  ] });
  await agent.invoke({ messages: [{ role: 'user', content: 'Reassess using prior evidence.' }] });
  assert.equal(submitted, true);
  const tools = model.bindings[0]![0];
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ['submit_stock_assessment']);
});
