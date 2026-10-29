import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import {
  createAssessmentCompletionGuard, createAssessmentGate, createResearchModelPolicy, LiveEvidence,
  resolveSubmission, submissionExamples, submissionSchema, validateAssessment,
} from '../src/research.js';
import { ResearchDiagnostics, researchLimitsSchema } from '../src/research-control.js';
import { candidate, ScriptedModel } from './helpers.js';

function setup(replies: (AIMessage | Error)[], maxModelCalls = 20) {
  const model = new ScriptedModel(replies);
  const events: Record<string, unknown>[] = [];
  const failures: Error[] = [];
  const diagnostics = new ResearchDiagnostics(
    { runId: 'completion-test', symbol: 'EXAMPLE' },
    researchLimitsSchema.parse({ RESEARCH_MAX_MODEL_CALLS: maxModelCalls }),
    submissionSchema, error => failures.push(error), event => events.push(event),
  );
  const evidence = new LiveEvidence();
  let accepted = false;
  let searches = 0;
  const submit = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Submit the required assessment', schema: submissionSchema,
    func: async input => {
      try {
        validateAssessment(resolveSubmission(input, evidence), candidate(), evidence.reads);
        accepted = true;
        return JSON.stringify({ accepted: true });
      } catch (error) {
        return JSON.stringify({ accepted: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  const search = new DynamicStructuredTool({
    name: 'test_search', description: 'Search', schema: z.object({}),
    func: async () => { searches++; return 'search result'; },
  });
  const todos = new DynamicStructuredTool({
    name: 'write_todos', description: 'Unnecessary TODO bookkeeping', schema: z.object({}),
    func: async () => { throw new Error('TODO bookkeeping must not run'); },
  });
  const gate = createAssessmentGate('EXAMPLE', diagnostics);
  const agent = createAgent({
    model, tools: [submit, search, todos],
    middleware: [createAssessmentCompletionGuard(() => accepted, diagnostics), createResearchModelPolicy(() => accepted, diagnostics), {
      name: 'submission-gate',
      wrapToolCall: (request, handler) => gate(request.toolCall, async args => handler(args
        ? { ...request, toolCall: { ...request.toolCall, args } } : request)),
    }],
  });
  return {
    model, events, failures,
    accepted: () => accepted, searches: () => searches,
    run: () => agent.invoke({ messages: [{ role: 'user', content: 'Research EXAMPLE and submit an assessment.' }] },
      { callbacks: [diagnostics] }),
  };
}

function submission(args: Record<string, unknown> = submissionExamples.unclassified) {
  return new AIMessage({ content: '', tool_calls: [{
    name: 'submit_stock_assessment', args, id: 'assessment-call', type: 'tool_call',
  }] });
}

test('prose-only completion is repaired through the real agent and submission gate without more searches', async () => {
  const state = setup([
    new AIMessage('All research TODOs are complete. Here is my assessment in prose.'),
    submission({ ...submissionExamples.unclassified, pe: 'None', earningsGrowthPercent: '12' }),
    new AIMessage('Done.'),
  ]);
  await state.run();
  assert.equal(state.accepted(), true);
  assert.equal(state.searches(), 0);
  assert.equal(state.model.calls.length, 2);
  assert.equal(state.events.filter(event => event.event === 'assessment_completion_repair').length, 1);
  assert.equal(state.events.filter(event => event.event === 'research_model_start').length, 2);
  assert.match(String(state.model.calls[1]!.at(-1)!.content), /No assessment has been accepted/);
  const binding = state.model.bindings[1]!;
  assert.deepEqual(binding[1], { tool_choice: { type: 'function', function: { name: 'submit_stock_assessment' } } });
  assert.ok(Array.isArray(binding[0]));
  assert.deepEqual(binding[0].map((tool: { name: string }) => tool.name), ['submit_stock_assessment']);
});

test('a second prose-only response fails explicitly after exactly one repair', async () => {
  const state = setup([new AIMessage('Finished.'), new AIMessage('Still only prose.')]);
  await assert.rejects(state.run(), /did not call submit_stock_assessment during its completion repair/);
  assert.equal(state.model.calls.length, 2);
  assert.equal(state.accepted(), false);
  assert.equal(state.searches(), 0);
});

test('an accepted submission needs no final model call, TODO update or completion repair', async () => {
  const state = setup([submission(), new AIMessage('Finished.')]);
  await state.run();
  assert.equal(state.accepted(), true);
  assert.equal(state.model.calls.length, 1);
  const tools = state.model.bindings[0]![0];
  assert.ok(Array.isArray(tools));
  assert.ok(tools.every((tool: { name: string }) => tool.name !== 'write_todos'));
  assert.equal(state.events.filter(event => event.event === 'assessment_completion_repair').length, 0);
});

test('a wrong-stock submission is retained as Unsure without reasking the model or using its claims', async () => {
  const state = setup([
    new AIMessage('Finished.'),
    submission({ ...submissionExamples.classified, symbol: 'WRONG' }),
    new AIMessage('Finished without correcting the evidence.'),
  ]);
  await state.run();
  assert.equal(state.accepted(), true);
  assert.equal(state.model.calls.length, 2);
  assert.equal(state.events.filter(event => event.event === 'assessment_rejected').length, 0);
  assert.ok(state.events.some(event => event.code === 'identity_mismatch'));
  assert.equal(state.events.filter(event => event.event === 'assessment_completion_repair').length, 1);
  assert.equal(state.searches(), 0);
});

test('a malformed model submission is accepted as partial information without a second model call', async () => {
  const state = setup([submission({ ...submissionExamples.unclassified, pe: { value: 20 } })]);
  await state.run();
  assert.equal(state.accepted(), true);
  assert.equal(state.model.calls.length, 1);
  assert.equal(state.events.filter(event => event.event === 'assessment_completion_repair').length, 0);
  assert.ok(state.events.some(event => event.field === 'pe' && event.code === 'invalid_submission_field'));
});

test('only network failures retry model requests; ordinary provider errors do not', async () => {
  const network = setup([new TypeError('fetch failed'), submission()]);
  await network.run();
  assert.equal(network.accepted(), true);
  assert.equal(network.model.calls.length, 2);
  assert.equal(network.events.filter(event => event.event === 'research_network_retry').length, 1);
  const invalid = setup([new Error('Malformed provider response')]);
  await assert.rejects(invalid.run(), /Malformed provider response/);
  assert.equal(invalid.model.calls.length, 1);
  assert.equal(invalid.events.filter(event => event.event === 'research_network_retry').length, 0);
});

test('a failed first structured-submission request retries that request rather than restarting research', async () => {
  const state = setup([new AIMessage('Here is a prose summary.'), new TypeError('fetch failed'), submission()]);
  await state.run();
  assert.equal(state.accepted(), true);
  assert.equal(state.model.calls.length, 3);
  assert.match(String(state.model.calls[1]!.at(-1)!.content), /No assessment has been accepted/);
  assert.equal(state.model.calls[1]!.at(-1)!.content, state.model.calls[2]!.at(-1)!.content);
  assert.equal(state.events.filter(event => event.event === 'assessment_completion_repair').length, 1);
  assert.equal(state.events.filter(event => event.event === 'research_network_retry').length, 1);
  assert.equal(state.searches(), 0);
});

test('repair model calls consume the original per-stock model budget', async () => {
  const state = setup([new AIMessage('Finished.'), submission()], 1);
  await assert.rejects(state.run(), /Per-stock research budget exhausted/);
  assert.equal(state.accepted(), false);
  assert.equal(state.failures.length, 1);
  assert.equal(state.events.filter(event => event.event === 'research_limit_exceeded').length, 1);
});

test('network retries cannot reset or exceed the original model budget', async () => {
  const state = setup([new TypeError('fetch failed'), submission()], 1);
  await assert.rejects(state.run(), /Per-stock research budget exhausted/);
  assert.equal(state.accepted(), false);
  assert.equal(state.model.calls.length, 1);
  assert.equal(state.failures.length, 1);
  assert.equal(state.events.filter(event => event.event === 'research_network_retry').length, 1);
  assert.equal(state.events.filter(event => event.event === 'research_limit_exceeded').length, 1);
});
