import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ResearchDiagnostics, researchLimitsSchema, isResearchNetworkError, retryResearchNetwork } from '../src/research-control.js';
import { runResearchProcess } from '../src/research-process.js';
import { submissionExamples, submissionSchema } from '../src/research.js';

const limits = researchLimitsSchema.parse({});
const fixture = new URL('../../test/fixtures/research-process.mjs', import.meta.url);
// Source tests run one directory shallower than compiled tests.
const sourceFixture = import.meta.url.endsWith('.ts') ? new URL('./fixtures/research-process.mjs', import.meta.url) : fixture;

function diagnostics(overrides: Partial<typeof limits> = {}) {
  const events: Record<string, unknown>[] = [];
  const failures: Error[] = [];
  const handler = new ResearchDiagnostics(
    { runId: 'test-run', symbol: 'EXAMPLE' }, { ...limits, ...overrides }, submissionSchema,
    error => failures.push(error), event => events.push(event),
  );
  return { handler, events, failures };
}

function propose(handler: ResearchDiagnostics, name: string, args: Record<string, unknown> = {}) {
  const generation = { text: '', message: new AIMessage({
    content: '', tool_calls: [{ name, args, id: 'tool-call' }],
  }) };
  handler.handleLLMEnd({ generations: [[generation]] });
}

test('model and tool budgets enforce thresholds; submission proposals no longer have a three-attempt budget', () => {
  const model = diagnostics({ RESEARCH_MAX_MODEL_CALLS: 1 });
  model.handler.handleLLMStart();
  assert.throws(() => model.handler.handleLLMStart(), /budget exhausted/);
  assert.throws(() => model.handler.handleLLMStart(), /budget exhausted/);
  assert.equal(model.failures.length, 1);
  const tools = diagnostics({ RESEARCH_MAX_TOOL_CALLS: 1 });
  propose(tools.handler, 'tavily_search');
  assert.throws(() => propose(tools.handler, 'tavily_search'), /budget exhausted/);
  const submit = diagnostics();
  for (let i = 0; i < 5; i++) propose(submit.handler, 'submit_stock_assessment');
  assert.equal(submit.failures.length, 0);
});

test('schema warnings are diagnosed before normalization reaches the tool body without logging arguments', async () => {
  const { handler, events } = diagnostics();
  const args = { symbol: 'EXAMPLE', secret: 'must-not-be-logged' };
  propose(handler, 'submit_stock_assessment', args);
  let entered = false;
  const tool = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Fixture submission',
    schema: submissionSchema, func: async () => { entered = true; return 'accepted'; },
  });
  await assert.rejects(tool.invoke({
    type: 'tool_call', name: 'submit_stock_assessment', id: 'bad-schema', args,
  }, { callbacks: [handler] }));
  assert.equal(entered, false);
  assert.ok(events.some(event => event.event === 'assessment_schema_warning'));
  const rejected = events.find(event => event.event === 'assessment_schema_warning')!;
  const text = JSON.stringify(rejected);
  assert.ok(text.includes('"received":"undefined"'));
  assert.ok(text.includes('"expected":"number"'));
  assert.ok(!JSON.stringify(events).includes('must-not-be-logged'));
});

test('tool diagnostics log starts, ends and errors without input or output contents', async () => {
  const { handler, events } = diagnostics();
  const tool = { lc: 1 as const, type: 'not_implemented' as const, id: ['fixture'] };
  handler.handleToolStart(tool, 'secret input', 'one', undefined, [], {}, 'tavily_search');
  handler.handleToolEnd('private page content', 'one');
  handler.handleToolStart(tool, 'secret input', 'two', undefined, [], {}, 'tavily_search');
  handler.handleToolError(new Error('secret credentials'), 'two');
  assert.deepEqual(events.map(event => event.event), ['research_tool_start', 'research_tool_end', 'research_tool_start', 'research_tool_error']);
  assert.ok(!JSON.stringify(events).match(/secret|private page/));
});

test('network retry classification excludes schema, evidence, authentication and cancellation failures', () => {
  for (const error of [
    new TypeError('fetch failed'), Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    new Error('request failed', { cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
    { status: 408 }, { status: 502 }, { status: 503 }, { status: 504 },
  ]) assert.equal(isResearchNetworkError(error), true);
  for (const error of [
    new Error('Evidence mismatch'), new SyntaxError('Invalid JSON'), new TypeError('Bad argument'),
    { status: 400 }, { status: 401 }, { status: 403 }, { status: 422 }, { status: 429 },
    { status: 403, cause: { code: 'ETIMEDOUT' } },
    Object.assign(new Error('cancelled'), { name: 'AbortError', cause: { code: 'ETIMEDOUT' } }),
    Object.assign(new Error('cancelled'), { name: 'AbortError', status: 503 }),
  ]) assert.equal(isResearchNetworkError(error), false);
  const circular: { cause?: unknown } = {};
  circular.cause = circular;
  assert.equal(isResearchNetworkError(circular), false);
});

test('network retries are bounded to one retry, logged without secrets and remain disabled for content errors', async () => {
  const { handler, events } = diagnostics();
  let calls = 0;
  await assert.rejects(retryResearchNetwork(async () => {
    calls++;
    throw new TypeError('fetch failed: private credentials must not be logged');
  }, handler, 'model'), /fetch failed/);
  assert.equal(calls, 2);
  assert.equal(events.filter(event => event.event === 'research_network_retry').length, 1);
  assert.ok(!JSON.stringify(events).includes('private credentials'));
  calls = 0;
  await assert.rejects(retryResearchNetwork(async () => {
    calls++;
    throw new Error('Evidence is missing');
  }, handler, 'submit_stock_assessment'), /Evidence is missing/);
  assert.equal(calls, 1);
});
test('model diagnostics validate normalized arguments instead of reporting repairable strings as schema rejections', () => {
  const { handler, events } = diagnostics();
  propose(handler, 'submit_stock_assessment', { ...submissionExamples.classified,
    livePrice: '500', pe: 'null', marketCapCrore: '10000', dataGapReason: '',
  });
  assert.ok(!events.some(event => event.event === 'assessment_schema_warning'));
  assert.ok(!JSON.stringify(events).includes('10000'));
  propose(handler, 'submit_stock_assessment', {
    ...submissionExamples.unclassified, profitProbability: 'None', fundamentalRisk: 'None',
    recoveryScore: 'None', quoteAsOf: 'None', quoteTimestampText: 'None', pe: 'None',
  });
  assert.ok(!events.some(event => event.event === 'assessment_schema_warning'));
});

test('model completions and errors correlate IDs and durations without logging prompts or provider errors', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { handler, events } = diagnostics();
  const model = { lc: 1 as const, type: 'not_implemented' as const, id: ['fixture-model'] };
  handler.handleLLMStart(model, ['secret prompt'], 'one');
  now = 1050;
  handler.handleLLMStart(model, ['another secret'], 'two');
  now = 1100;
  handler.handleLLMEnd({ generations: [] }, 'one');
  now = 1200;
  handler.handleLLMError(new Error('private provider response with credentials'), 'two');
  const completed = events.find(event => event.event === 'research_model_end')!;
  const failed = events.find(event => event.event === 'research_model_error')!;
  assert.equal(completed.modelRunId, 'one');
  assert.equal(completed.modelCall, 1);
  assert.equal(completed.durationMs, 100);
  assert.equal(failed.modelRunId, 'two');
  assert.equal(failed.modelCall, 2);
  assert.equal(failed.durationMs, 150);
  assert.equal(failed.errorType, 'Error');
  assert.ok(!JSON.stringify(events).match(/secret|private|credentials/));
});

test('research limit configuration rejects invalid, zero and fractional limits', () => {
  assert.deepEqual(researchLimitsSchema.parse({ RESEARCH_MAX_SUBMISSIONS: 'invalid' }), limits);
  for (const key of Object.keys(limits)) {
    for (const value of ['0', '-1', '1.5', 'invalid']) {
      assert.throws(() => researchLimitsSchema.parse({ [key]: value }));
    }
  }
});

test('isolated research returns results only after its process has stopped', async () => {
  const result = await runResearchProcess<{ pid: number }>(sourceFixture, { action: 'result' }, 5000);
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
  await assert.rejects(runResearchProcess(sourceFixture, { action: 'error' }, 5000), /Fixture research failure/);
  await assert.rejects(runResearchProcess(sourceFixture, { action: 'exit' }, 5000), /without a result/);
});

test('real research worker boots under the current TS or compiled JS runtime without network calls', async () => {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  await assert.rejects(runResearchProcess(new URL(`../src/research-worker.${extension}`, import.meta.url), {
    limits: { RESEARCH_MAX_MODEL_CALLS: 0 },
  }, 10_000), /RESEARCH_MAX_MODEL_CALLS/);
});

test('deadline terminates a stuck research process before rejecting', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'research-deadline-'));
  const pidFile = path.join(dir, 'pid');
  try {
    await assert.rejects(runResearchProcess(sourceFixture, { action: 'hang', pidFile }, 1500), /deadline exceeded/);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
