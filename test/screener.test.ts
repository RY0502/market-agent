import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { TodoListMiddleware } from 'freetier-deepagent-framework';
import type { createAgent } from 'langchain';
import { z } from 'zod';
import { attachScreener, enrichStocks, needsScreener, parseScreenerOutput, scrapeScreener, screenerPrompt } from '../src/screener.js';
import { renderStockReport } from '../src/reports.js';
import { createFinalAssessmentPolicy, activeSubmissionSchema, type RankedStock } from '../src/research.js';
import { ResearchDiagnostics, researchLimitsSchema } from '../src/research-control.js';
import { candidate, research, ScriptedModel } from './helpers.js';

const output = JSON.stringify({
  nseSymbol: 'EXAMPLE', pe: '31.1', marketCap: 'INR 16,756 Cr',
  pros: ['Company delivered profit growth.'], cons: ['Company has low interest coverage.'],
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
  assert.equal(needsScreener(s), true);
  s.candidate.nse!.historical.pe = { value: 20, asOf: '2026-10-20', source: { url: 'https://nse.example/pe', excerpt: 'P/E 20' } };
  s.candidate.nse!.marketCapCrore = { value: 100, source: { url: 'https://nse.example/cap', excerpt: '100 Cr' } };
  assert.equal(needsScreener(s), false);
  s.research.assessment.profitProbability = null;
  assert.equal(needsScreener(s), true);
  assert.match(screenerPrompt('EXAMPLE'), /pros.*cons/i);
});

test('the scrape request uses the exact consolidated URL and retries 429 once after 45 seconds', async () => {
  const calls: { url: string; prompt: string }[] = [];
  const sleeps: number[] = [];
  const page = await scrapeScreener('EXAMPLE', async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return calls.length === 1 ? new Response('', { status: 429 }) : new Response(output);
  }, async ms => { sleeps.push(ms); });
  assert.equal(page.url, 'https://www.screener.in/company/EXAMPLE/consolidated/');
  assert.deepEqual(sleeps, [45_000]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, page.url);
  assert.match(calls[0]!.prompt, /Stock P\/E/);
});

test('network failures retry only once; other failures and invalid symbols do not retry', async () => {
  let calls = 0;
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  await assert.rejects(scrapeScreener('EXAMPLE', async () => {
    calls++; throw new TypeError('fetch failed');
  }, sleep));
  assert.equal(calls, 2);
  assert.deepEqual(waits, [45_000]);
  calls = 0;
  await assert.rejects(scrapeScreener('EXAMPLE', async () => { calls++; return new Response('', { status: 403 }); }, sleep));
  assert.equal(calls, 1);
  await assert.rejects(scrapeScreener('../OTHER', async () => { throw new Error('must not call'); }, sleep), /Invalid NSE symbol/);
});

test('extraction verifies stock identity, units, and never overwrites current or historical NSE values', () => {
  assert.equal(parseScreenerOutput(JSON.stringify({ result: output }), 'EXAMPLE').pe, '31.1');
  assert.throws(() => parseScreenerOutput(output, 'OTHER'), /symbol mismatch/);
  assert.throws(() => parseScreenerOutput('not json', 'EXAMPLE'));
  const s = stock();
  s.candidate.nse!.historical.pe = { value: 18, asOf: '2026-10-20', source: { url: 'https://nse.example/pe', excerpt: 'P/E 18' } };
  s.research.assessment.pe = s.candidate.nse!.historical.pe;
  const page = { url: 'https://www.screener.in/company/EXAMPLE/consolidated/', output, observedAt: new Date().toISOString() };
  const enriched = attachScreener(s, page);
  assert.equal(enriched.assessment.pe!.value, 18);
  assert.equal(enriched.assessment.marketCapCrore!.value, 16756);
  assert.equal(enriched.reads.at(-1)!.output, output);
  assert.equal(s.research.assessment.marketCapCrore, null);
  const noUnits = attachScreener(stock(), { ...page, output: output.replace('INR 16,756 Cr', '16756') });
  assert.equal(noUnits.assessment.marketCapCrore, null);
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
    return { url: `https://www.screener.in/company/${symbol}/consolidated/`, output, observedAt: new Date().toISOString() };
  }, async (_stock, prior) => {
    order.push('reassess EXAMPLE');
    assert.ok(prior.reads.some(read => read.kind === 'tavily'));
    assert.ok(prior.reads.some(read => read.output.includes('interest coverage')));
    prior.assessment.profitProbability = 'medium';
    return prior;
  });
  assert.deepEqual(order, ['scrape EXAMPLE', 'reassess EXAMPLE', 'scrape SECOND']);
  assert.equal(first.research.assessment.profitProbability, 'medium');
  assert.equal(first.research.assessment.marketCapCrore!.value, 16756);
  assert.equal(second.research.assessment.profitProbability, 'high');
  assert.ok(second.research.assessment.warnings?.some(warning => warning.code === 'screener_enrichment_failed'));
  const html = renderStockReport(first, 'run', [], 1, new Date().toISOString(), '2100-01-01T00:00:00Z');
  assert.match(html, /Screener retrieved/);
  assert.doesNotMatch(html, /NSE P\/E history/);
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
