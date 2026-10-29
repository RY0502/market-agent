import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { createAgent } from 'langchain';
import { TodoListMiddleware } from 'freetier-deepagent-framework';
import { z } from 'zod';
import {
  LiveEvidence, createAssessmentGate, resolveSubmission, submissionExamples, submissionSchema,
  validateAssessment, type Assessment, type ResearchWarning,
} from '../src/research.js';
import { ResearchDiagnostics, researchLimitsSchema } from '../src/research-control.js';
import {
  compactResearchContext, researchEvidencePage, createCachedRefreshPolicy, createResearchEvidenceTool,
  CACHED_CONTEXT_MAX_CHARS, EVIDENCE_PAGE_MAX_CHARS,
  qualitativeCachedText,
} from '../src/research-refresh.js';
import { candidate, research, ScriptedModel } from './helpers.js';

const { createDeepAgent }: { createDeepAgent: typeof createAgent } =
  createRequire(import.meta.resolve('freetier-deepagent-framework'))('deepagents');

function cachedContext() {
  return {
    result: research(), baselineDate: '2026-09-25', asOfDate: '2026-10-26',
    validUntil: new Date(Date.now() + 15 * 86_400_000).toISOString(),
  };
}

function assessmentMessage(args: Record<string, unknown> = submissionExamples.unclassified) {
  return new AIMessage({ content: '', tool_calls: [
    { name: 'submit_stock_assessment', id: 'assessment', type: 'tool_call', args },
  ] });
}

function setup(replies: (AIMessage | Error)[], options: { searchError?: Error; maxTools?: number; maxModels?: number } = {}) {
  const cached = cachedContext();
  const evidence = new LiveEvidence(cached);
  const events: Record<string, unknown>[] = [];
  const warnings: ResearchWarning[] = [];
  const diagnostics = new ResearchDiagnostics(
    { runId: 'cache-refresh-test', symbol: 'EXAMPLE' },
    researchLimitsSchema.parse({
      RESEARCH_MAX_TOOL_CALLS: options.maxTools ?? 40, RESEARCH_MAX_MODEL_CALLS: options.maxModels ?? 20,
    }),
    submissionSchema, () => {}, event => events.push(event),
  );
  const model = new ScriptedModel(replies);
  let assessment: Assessment | undefined;
  const queries: Record<string, unknown>[] = [];
  const search = new DynamicStructuredTool({
    name: 'tavily_search', description: 'Framework-style search fixture',
    schema: z.object({ query: z.string(), topic: z.literal('news'), days: z.number(), maxResults: z.number() }),
    func: async args => {
      queries.push(args);
      if (options.searchError) throw options.searchError;
      return JSON.stringify({ results: [{
        url: `https://fresh.example.org/${queries.length}`,
        content: `Price 510 at ${new Date().toISOString()}; fresh material company announcement with significant uncertainty.`,
        published_date: new Date().toISOString(),
      }] });
    },
  });
  const submit = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Submit', schema: submissionSchema,
    func: async input => {
      assessment = resolveSubmission(input, evidence);
      assessment.warnings = [...assessment.warnings ?? [], ...warnings];
      assessment.risks.push(...warnings.map(warning => warning.message));
      validateAssessment(assessment, candidate(), evidence.reads);
      return JSON.stringify({ accepted: true });
    },
  });
  const read = createResearchEvidenceTool(evidence, diagnostics, warnings);
  const forbidden = new DynamicStructuredTool({
    name: 'vision_scrape', description: 'Must not be used', schema: z.object({}),
    func: async () => { throw new Error('No scraping on cache hits'); },
  });
  const gate = createAssessmentGate('EXAMPLE', diagnostics);
  const agent = createDeepAgent({
    model, tools: [search, submit, read, forbidden],
    systemPrompt: 'Framework instruction: immediately plan using write_todos.',
    middleware: [
      TodoListMiddleware(),
      createCachedRefreshPolicy({
        candidate: candidate(), cached, evidence, diagnostics, warnings,
        hasAssessment: () => assessment !== undefined,
      }),
      { name: 'gate', wrapToolCall: (request, handler) => gate(request.toolCall, async args => handler(args
        ? { ...request, toolCall: { ...request.toolCall, args } } : request)) },
    ],
  });
  return {
    cached, evidence, model, events, queries, warnings, assessment: () => assessment,
    run: () => agent.invoke({ messages: [{ role: 'user', content: JSON.stringify(candidate()) }] },
      { callbacks: [diagnostics] }),
  };
}

test('a cache hit runs one bounded news search then one assessment, without metric searches or planning', async () => {
  const state = setup([assessmentMessage({ ...submissionExamples.classified, profitProbability: 'low' })]);
  await state.run();
  assert.equal(state.model.calls.length, 1);
  assert.equal(state.assessment()!.profitProbability, 'low', 'The previous high category is not replayed');
  assert.equal(state.queries.length, 1);
  assert.ok(state.queries.every(query => query.topic === 'news' && query.days === 7 && query.maxResults === 3));
  assert.match(String(state.queries[0]!.query), /material company news/);
  assert.doesNotMatch(String(state.queries[0]!.query), /share price|quote|corporate actions/);
  assert.equal(state.evidence.reads.length, 3);
  assert.ok(state.evidence.reads.slice(2).every(read => read.evidenceId && read.toolCallId && !read.cachedAt));
  assert.equal(state.events.filter(event => event.event === 'research_tool_requested').length, 2);
  assert.equal(state.events.filter(event => event.event === 'research_model_start').length, 1);
  assert.ok(!JSON.stringify(state.model.calls).includes('immediately plan using write_todos'));
  const tools = state.model.bindings[0]![0];
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(),
    ['read_research_evidence', 'submit_stock_assessment']);
  const context = state.events.find(event => event.event === 'cached_refresh_assessment')!;
  assert.ok(Number(context.contextChars) <= CACHED_CONTEXT_MAX_CHARS);
});

test('one on-demand evidence read is allowed, then only the final assessment tool remains', async () => {
  const replies: (AIMessage | Error)[] = [];
  const state = setup(replies);
  replies.push(
    new AIMessage({ content: '', tool_calls: [
      { name: 'read_research_evidence', id: 'read', type: 'tool_call',
        args: { evidenceId: state.evidence.reads[0]!.evidenceId! } },
    ] }),
    assessmentMessage(),
  );
  await state.run();
  assert.equal(state.model.calls.length, 2);
  assert.equal(state.queries.length, 1, 'The evidence read does not restart refresh searches');
  const tools = state.model.bindings[1]![0];
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ['submit_stock_assessment']);
  assert.deepEqual(state.model.bindings[1]![1],
    { tool_choice: { type: 'function', function: { name: 'submit_stock_assessment' } } });
});

test('network failures retry only the same bounded searches and cannot evade the tool budget', async () => {
  const state = setup([assessmentMessage()], { searchError: new TypeError('fetch failed') });
  await state.run();
  assert.equal(state.queries.length, 2);
  assert.equal(state.warnings.length, 1);
  assert.equal(state.events.filter(event => event.event === 'research_network_retry').length, 1);
  const limited = setup([assessmentMessage()], { searchError: new TypeError('fetch failed'), maxTools: 1 });
  await assert.rejects(limited.run(), /budget exhausted/);
  assert.equal(limited.queries.length, 1);
  assert.equal(limited.model.calls.length, 0);
});

test('refresh failures are explicit warnings and still permit assessment from dated background', async () => {
  const state = setup([assessmentMessage()], { searchError: new Error('Search unavailable') });
  await state.run();
  assert.ok(state.assessment());
  assert.equal(state.queries.length, 1, 'Non-network search failures are not retried');
  assert.equal(state.warnings.length, 1);
  assert.equal(state.events.filter(event => event.event === 'cached_refresh_warning').length, 1);
  assert.equal(state.assessment()!.warnings!.filter(warning => warning.code === 'refresh_failed').length, 1);
  assert.match(JSON.stringify(state.model.calls), /refresh_failed/);
});

test('an unknown evidence read becomes a warning, not a resubmission or research loop', async () => {
  const state = setup([
    new AIMessage({ content: '', tool_calls: [
      { name: 'read_research_evidence', id: 'read', type: 'tool_call',
        args: { evidenceId: 'private-value-must-not-be-logged' } },
    ] }),
    assessmentMessage(),
  ]);
  await state.run();
  assert.equal(state.model.calls.length, 2);
  assert.ok(state.assessment()!.warnings!.some(warning => warning.code === 'evidence_read_failed'));
  assert.ok(!JSON.stringify(state.events).includes('private-value'));
});

test('network retry reuses the refresh and only retries the assessment request', async () => {
  const state = setup([new TypeError('fetch failed'), assessmentMessage()]);
  await state.run();
  assert.equal(state.model.calls.length, 2);
  assert.equal(state.queries.length, 1);
  assert.equal(state.events.filter(event => event.event === 'research_network_retry').length, 1);
});

test('cached refresh honors tool budgets and stops after one unsuccessful completion repair', async () => {
  const limited = setup([assessmentMessage()], { maxTools: 1 });
  await assert.rejects(limited.run(), /budget exhausted/);
  assert.equal(limited.queries.length, 1);
  assert.equal(limited.model.calls.length, 1);
  for (const response of [
    new AIMessage('Only prose'),
    new AIMessage({ content: '', tool_calls: [
      { name: 'write_todos', id: 'todo', args: {} },
    ] }),
  ]) {
    const state = setup([response, new AIMessage('Still only prose')]);
    await assert.rejects(state.run(), /Cached refresh.*completion repair/);
    assert.equal(state.model.calls.length, 2);
    assert.equal(state.queries.length, 1);
    assert.equal(state.events.filter(event => event.event === 'cached_refresh_completion_repair').length, 1);
  }
});

test('prose instead of submission gets one forced completion without repeating searches', async () => {
  const state = setup([new AIMessage('A provisional outlook without a tool call'), assessmentMessage()]);
  await state.run();
  assert.ok(state.assessment());
  assert.equal(state.model.calls.length, 2);
  assert.equal(state.queries.length, 1);
  const tools = state.model.bindings[1]![0];
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ['submit_stock_assessment']);
  assert.deepEqual(state.model.bindings[1]![1],
    { tool_choice: { type: 'function', function: { name: 'submit_stock_assessment' } } });
  assert.equal(state.events.filter(event => event.event === 'cached_refresh_completion_repair').length, 1);
});

test('one assessment bundled with an evidence read is accepted without executing the extra tool', async () => {
  const state = setup([new AIMessage({ content: '', tool_calls: [
    { name: 'read_research_evidence', id: 'unnecessary-read', args: { evidenceId: 'not-a-real-id' } },
    { name: 'submit_stock_assessment', id: 'assessment', args: submissionExamples.classified },
  ] })]);
  await state.run();
  assert.ok(state.assessment());
  assert.equal(state.model.calls.length, 1);
  assert.equal(state.queries.length, 1);
  assert.equal(state.events.filter(event => event.event === 'cached_refresh_evidence_read').length, 0);
  assert.equal(state.events.filter(event => event.event === 'cached_refresh_extra_calls_discarded').length, 1);
  assert.equal(state.events.filter(event => event.event === 'cached_refresh_completion_repair').length, 0);
});

test('conflicting assessment calls are not executed or replayed; completion obtains a single decision', async () => {
  const state = setup([new AIMessage({ content: '', tool_calls: [
    { name: 'submit_stock_assessment', id: 'first', args: { ...submissionExamples.classified, profitProbability: 'high' } },
    { name: 'submit_stock_assessment', id: 'second', args: { ...submissionExamples.classified, profitProbability: 'low' } },
  ] }), assessmentMessage({ ...submissionExamples.classified, profitProbability: 'medium' })]);
  await state.run();
  assert.equal(state.assessment()!.profitProbability, 'medium');
  assert.equal(state.model.calls.length, 2);
  assert.equal(state.queries.length, 1);
  assert.deepEqual(state.model.calls[1]!.filter(AIMessage.isInstance).flatMap(message => message.tool_calls ?? []), [],
    'Discarded assistant calls are not replayed without matching tool results');
});

test('completion repair after an evidence read cannot restart reading and respects the model budget', async () => {
  const state = setup([
    new AIMessage({ content: '', tool_calls: [
      { name: 'read_research_evidence', id: 'read', args: { evidenceId: 'unknown' } },
    ] }),
    new AIMessage('Prose after evidence read'), assessmentMessage(),
  ]);
  await state.run();
  assert.ok(state.assessment());
  assert.equal(state.model.calls.length, 3);
  assert.equal(state.queries.length, 1);
  const limited = setup([new AIMessage('Only prose'), assessmentMessage()], { maxModels: 1 });
  await assert.rejects(limited.run(), /budget exhausted/);
  assert.equal(limited.queries.length, 1);
  assert.ok(!limited.assessment());
});

test('compact context and on-demand pages have measured bounds and preserve original source records', () => {
  const cached = cachedContext();
  const full = `${cached.result.reads[0]!.output}\n${'Long source text "with escapes" \\\n'.repeat(10_000)}`;
  cached.result.reads[0]!.output = full;
  for (let index = 0; index < 50; index++) cached.result.reads.push({
    url: `https://background.example.org/${index}`, output: full, observedAt: cached.result.researchedAt,
  });

  cached.result.assessment.risks = Array(30).fill(full);
  const evidence = new LiveEvidence(cached);
  const compact = compactResearchContext(cached, evidence);
  assert.ok(compact.length <= CACHED_CONTEXT_MAX_CHARS);
  assert.ok(compact.length < full.length / 10);
  assert.ok(!compact.includes('profitProbability'));
  assert.ok(!compact.includes('quoteAsOf'));
  assert.equal(evidence.reads[0]!.output, full);
  const data = JSON.parse(compact);
  assert.equal(data.fundamentals, undefined, 'Old numerical metrics are not reused');
  assert.equal(data.corporateActions, undefined, 'Old all-clear flags are not reused');
  assert.ok(data.evidence.length < evidence.reads.length);
  const page = researchEvidencePage(evidence, evidence.reads[0]!.evidenceId!, 0);
  assert.ok(page.length <= EVIDENCE_PAGE_MAX_CHARS);
  const first = JSON.parse(page);
  assert.equal(first.content, qualitativeCachedText(full.slice(0, first.nextOffset)));
  const next = JSON.parse(researchEvidencePage(evidence, evidence.reads[0]!.evidenceId!, first.nextOffset));
  assert.equal(next.content, qualitativeCachedText(full.slice(first.nextOffset, next.nextOffset ?? full.length)));
  assert.throws(() => researchEvidencePage(evidence, 'unknown', 0), /Unknown evidence ID/);
  assert.throws(() => researchEvidencePage(evidence, evidence.reads[0]!.evidenceId!, full.length + 1), /offset/);
  assert.equal(cached.result.reads[0]!.output, full);
});

test('NSE file records cannot crowd fresh news out of cache context, which omits old diagnostic risks', () => {
  const cached = cachedContext();
  const warning = { field: 'quoteAsOf', code: 'timestamp_unverified', message: 'Old quote warning' };
  cached.result.assessment.warnings = [warning];
  cached.result.assessment.risks = [
    warning.message, 'evidenceIds.debtToEquity: unusable model field',
    'Quote timestamp could not be normalized', 'Business execution remains uncertain',
  ];
  const evidence = new LiveEvidence(cached);
  for (let index = 0; index < 70; index++) evidence.reads.push({
    evidenceId: `nse_${index}`, kind: 'nse', url: `https://nsearchives.nseindia.com/day${index}`,
    output: 'NSE figures already supplied in the task. '.repeat(100), observedAt: new Date().toISOString(),
  });
  evidence.reads.push({
    evidenceId: 'fresh-news', kind: 'tavily', url: 'https://news.example.org/latest',
    output: 'A new material company development that must be considered.', observedAt: new Date().toISOString(),
  });
  const context = JSON.parse(compactResearchContext(cached, evidence));
  assert.equal(context.evidence[0].evidenceId, 'fresh-news');
  assert.ok(!context.evidence.some((item: { evidenceId: string }) => item.evidenceId.startsWith('nse_')));
  assert.deepEqual(context.datedRisks, ['Business execution remains uncertain']);
});
