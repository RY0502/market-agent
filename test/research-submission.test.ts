import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  submissionExamples, submissionSchema, createAssessmentGate, validateAssessment,
  LiveEvidence, resolveSubmission, prepareSubmission,
} from '../src/research.js';
import { ResearchDiagnostics, researchLimitsSchema } from '../src/research-control.js';
import { normalizeSubmissionArguments } from '../src/schema-diagnostics.js';
import { candidate, research } from './helpers.js';

function fixture() {
  const events: Record<string, unknown>[] = [];
  const failures: Error[] = [];
  const diagnostics = new ResearchDiagnostics(
    { runId: 'test-run', symbol: 'EXAMPLE' }, researchLimitsSchema.parse({}), submissionSchema,
    error => failures.push(error), event => events.push(event),
  );
  return { gate: createAssessmentGate('EXAMPLE', diagnostics), events, failures };
}

function capturedFixture() {
  const valid = research();
  const evidence = new LiveEvidence();
  for (const [index, read] of valid.reads.entries()) {
    evidence.handleToolStart(
      { lc: 1, type: 'not_implemented', id: ['vision_scrape'] }, JSON.stringify({ url: read.url }),
      `run-${index}`, undefined, [], {}, 'vision_scrape', `call-${index}`,
    );
    evidence.handleToolEnd(read.output, `run-${index}`);
  }
  const quoteId = evidence.reads[0]!.evidenceId!;
  const marketId = evidence.reads[1]!.evidenceId!;
  const input = submissionSchema.parse({
    ...submissionExamples.classified,
    quoteAsOf: valid.assessment.quoteAsOf, quoteTimestampText: valid.assessment.quoteAsOf,
    pe: 20, debtToEquity: 0.5, earningsGrowthPercent: 12,
    evidenceIds: {
      livePrice: quoteId, pe: quoteId, marketCapCrore: quoteId, debtToEquity: quoteId,
      earningsGrowthPercent: quoteId, corporateActionEvidence: quoteId, marketEvidence: marketId,
    },
  });
  return { evidence, input };
}

test('complete submission examples satisfy the strict schema', () => {
  for (const example of Object.values(submissionExamples)) assert.doesNotThrow(() => submissionSchema.parse(example));
  assert.doesNotThrow(() => validateAssessment(
    resolveSubmission(submissionExamples.unclassified, new LiveEvidence()), candidate(), [],
  ));
});

test('partial submission recovery retains valid metrics and does not invent a missing directional decision', () => {
  const { input, warnings } = prepareSubmission({
    symbol: 'EXAMPLE', profitProbability: 'certain', pe: 20, marketCapCrore: 10000,
    evidenceIds: { pe: 'captured-id', marketCapCrore: { invalid: true } },
  }, 'EXAMPLE');
  assert.equal(input.profitProbability, null);
  assert.equal(input.pe, 20);
  assert.equal(input.marketCapCrore, 10000);
  assert.equal(input.evidenceIds.pe, 'captured-id');
  assert.ok(input.dataGapReason);
  assert.ok(warnings.some(warning => warning.field === 'profitProbability'));
  const wrongStock = prepareSubmission({ ...submissionExamples.classified, symbol: 'WRONG' }, 'EXAMPLE');
  assert.equal(wrongStock.input.symbol, 'EXAMPLE');
  assert.equal(wrongStock.input.profitProbability, null);
  assert.equal(wrongStock.input.marketCapCrore, null);
  assert.ok(wrongStock.warnings.some(warning => warning.code === 'identity_mismatch'));
});
test('captured NVIDIA None response passes the actual tool and evidence checks after schema-scoped normalization', async () => {
  const file = new URL(import.meta.url.endsWith('.ts')
    ? './fixtures/nvidia-none-assessment.json' : '../../test/fixtures/nvidia-none-assessment.json', import.meta.url);
  const captured = z.object({
    toolCall: z.object({
      name: z.literal('submit_stock_assessment'), id: z.string(), type: z.literal('tool_call'),
      args: z.record(z.unknown()),
    }),
  }).parse(JSON.parse(await readFile(file, 'utf8')));
  const { gate, events } = fixture();
  const evidence = new LiveEvidence();
  let submissions = 0;
  const tool = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Captured provider regression', schema: submissionSchema,
    func: async input => {
      assert.deepEqual(input, submissionExamples.unclassified);
      validateAssessment(resolveSubmission(input, evidence), candidate(), evidence.reads);
      submissions++;
      return JSON.stringify({ accepted: true });
    },
  });
  assert.equal(submissionSchema.safeParse(captured.toolCall.args).success, false);
  const result = await gate(captured.toolCall, input => tool.invoke({ ...captured.toolCall, args: input! }));
  assert.ok(result instanceof ToolMessage);
  assert.equal(JSON.parse(String(result.content)).accepted, true);
  assert.equal(submissions, 1);
  const conversions = events.filter(event => event.event === 'assessment_argument_normalized');
  assert.equal(conversions.length, 5);
  assert.ok(conversions.every(event => event.reason === 'provider_null_token'));
  assert.ok(!events.some(event => event.event === 'assessment_rejected'));
  assert.equal(captured.toolCall.args.pe, 'None');
});

test('None conversion covers all eleven nullable scalar fields without changing non-nullable strings or inventing a gap explanation', () => {
  const input: Record<string, unknown> = { ...submissionExamples.unclassified };
  for (const [field, schema] of Object.entries(submissionSchema.shape)) {
    if (schema.isNullable() && field !== 'dataGapReason') input[field] = 'None';
  }
  const { args, conversions } = normalizeSubmissionArguments(input, submissionSchema);
  assert.equal(conversions.length, 11);
  assert.deepEqual(submissionSchema.parse(args), submissionExamples.unclassified);
  validateAssessment(resolveSubmission(submissionSchema.parse(args), new LiveEvidence()), candidate(), []);

  const narrative = normalizeSubmissionArguments({
    ...input, symbol: 'None', financialPeriod: 'None', reasons: ['None'],
  }, submissionSchema);
  const values = z.record(z.unknown()).parse(narrative.args);
  assert.equal(values.symbol, 'None');
  assert.equal(values.financialPeriod, 'None');
  assert.deepEqual(values.reasons, ['None']);

  const missingReason = normalizeSubmissionArguments({ ...input, dataGapReason: 'None' }, submissionSchema);
  const unsure = resolveSubmission(submissionSchema.parse(missingReason.args), new LiveEvidence());
  validateAssessment(unsure, candidate(), []);
  assert.equal(unsure.profitProbability, null);
  assert.match(unsure.dataGapReason!, /No captured research evidence/);
});

test('None citations are retained as unverified for all metrics while unknown schema keys remain strict', () => {
  const normalized = normalizeSubmissionArguments({
    ...submissionExamples.unclassified, pe: 20, evidenceIds: { pe: 'None' },
  }, submissionSchema);
  const input = submissionSchema.parse(normalized.args);
  assert.equal(input.evidenceIds.pe, null);
  const resolved = resolveSubmission(input, new LiveEvidence());
  assert.equal(resolved.pe!.value, 20);
  assert.equal(resolved.pe!.source, null);
  assert.ok(resolved.risks.some(risk => risk.includes('pe is model-reported')));
  const quote = resolveSubmission({
    ...input, pe: null, livePrice: 500, evidenceIds: {},
  }, new LiveEvidence());
  assert.equal(quote.livePrice!.value, 500);
  assert.equal(quote.livePrice!.source, null);
  const unknown = normalizeSubmissionArguments({
    ...submissionExamples.unclassified, arbitrary: 'None',
  }, submissionSchema);
  assert.equal(submissionSchema.safeParse(unknown.args).success, false);
  assert.equal(z.record(z.unknown()).parse(unknown.args).arbitrary, 'None');
});

test('invalid metric/evidence fields are finalized from usable fields without a model correction round', async () => {
  const { gate, events } = fixture();
  const { evidence, input } = capturedFixture();
  let submissions = 0;
  const tool = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Strict fixture submission', schema: submissionSchema,
    func: async input => {
      assert.equal(input.pe, null);
      assert.equal(input.marketCapCrore, 10000);
      assert.equal(input.evidenceIds.marketEvidence, undefined);
      assert.equal(input.evidenceIds.livePrice, evidence.reads[0]!.evidenceId);
      validateAssessment(resolveSubmission(input, evidence), candidate(), evidence.reads);
      submissions++;
      return JSON.stringify({ accepted: true });
    },
  });
  const bad = {
    name: 'submit_stock_assessment', id: 'bad',
    args: { ...input, dataGapReason: '', pe: { value: 20, source: { secret: 'private-value' } }, marketCapCrore: '10000',
      evidenceIds: { ...input.evidenceIds, marketEvidence: { secret: 'do-not-log-this' } } },
  };
  const response = await gate(bad, normalized => tool.invoke({ ...bad, args: normalized!, type: 'tool_call' }));
  assert.ok(response instanceof ToolMessage);
  assert.equal(response.tool_call_id, 'bad');
  assert.equal(submissions, 1);
  assert.equal(typeof response.content, 'string');
  const feedback = JSON.parse(String(response.content));
  assert.equal(feedback.accepted, true);
  assert.equal(feedback.remainingAttempts, undefined);
  assert.deepEqual(events.filter(event => event.event === 'assessment_warning').map(event => event.field).sort(),
    ['evidenceIds.marketEvidence', 'pe']);
  assert.deepEqual(events.filter(event => event.event === 'assessment_argument_normalized').map(event => event.field),
    ['marketCapCrore', 'dataGapReason']);
  assert.ok(!events.some(event => event.event === 'assessment_rejected'));
  assert.ok(!JSON.stringify(events).match(/private-value|do-not-log-this|10000/));

  const corrected = { name: bad.name, id: 'corrected', args: input };
  const result = await gate(corrected, () => tool.invoke({ ...corrected, type: 'tool_call' }));
  assert.ok(result instanceof ToolMessage);
  assert.equal(JSON.parse(String(result.content)).accepted, true);
  assert.equal(submissions, 1);
});

test('a malformed submission is finalized once and duplicate proposals do not execute or reset it', async () => {
  const { gate, failures } = fixture();
  let invoked = 0;
  const handler = async (input?: typeof submissionExamples.unclassified) => {
    invoked++;
    assert.equal(input!.profitProbability, null);
    assert.ok(input!.dataGapReason);
    return JSON.stringify({ accepted: true });
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await gate({ name: 'submit_stock_assessment', id: String(attempt), args: {} }, handler);
    assert.ok(result instanceof ToolMessage);
    assert.equal(result.tool_call_id, String(attempt));
    assert.equal(JSON.parse(String(result.content)).accepted, true);
  }
  assert.equal(invoked, 1);
  assert.equal(failures.length, 0);
});

test('parallel duplicate submissions share the first in-flight outcome', async () => {
  const { gate } = fixture();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const handler = async () => {
    calls++;
    await waiting;
    return JSON.stringify({ accepted: true });
  };
  const first = gate({ name: 'submit_stock_assessment', id: 'one', args: {} }, handler);
  const second = gate({ name: 'submit_stock_assessment', id: 'two', args: submissionExamples.classified }, handler);
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => {
    assert.ok(result instanceof ToolMessage);
    return result.tool_call_id;
  }), ['one', 'two']);
  assert.equal(calls, 1);
});

test('ambiguous metrics become unknown while non-network handler failures are not retried', async () => {
  const { gate } = fixture();
  const result = await gate({
    name: 'submit_stock_assessment', id: 'formatted-metric',
    args: { ...submissionExamples.unclassified, pe: 'about twenty' },
  }, async input => {
    assert.equal(input!.pe, null);
    return JSON.stringify({ accepted: true });
  });
  assert.ok(result instanceof ToolMessage);
  assert.equal(JSON.parse(String(result.content)).accepted, true);
  const failed = fixture();
  let calls = 0;
  await assert.rejects(failed.gate({
    name: 'submit_stock_assessment', id: 'valid', args: submissionExamples.unclassified,
  }, async () => { calls++; throw new Error('invalid tool response'); }), /invalid tool response/);
  assert.equal(calls, 1);
  assert.equal(await gate({ name: 'tavily_search', args: {} }, async () => 'search result'), 'search result');
});

test('quoted metrics and an empty classified gap reason normalize before real LangChain parsing, without weakening evidence checks', async () => {
  const { gate, events } = fixture();
  const { evidence, input } = capturedFixture();
  const args = {
    ...input, livePrice: '500', pe: '20', sectorPe: 'null', marketCapCrore: '10000',
    debtToEquity: '0.5', earningsGrowthPercent: '+12', dataGapReason: '   ',
  };
  let submissions = 0;
  const tool = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Strict normalized submission', schema: submissionSchema,
    func: async normalized => {
      assert.equal(normalized.livePrice, 500);
      assert.equal(normalized.pe, 20);
      assert.equal(normalized.sectorPe, null);
      assert.equal(normalized.marketCapCrore, 10000);
      assert.equal(normalized.debtToEquity, 0.5);
      assert.equal(normalized.earningsGrowthPercent, 12);
      assert.equal(normalized.dataGapReason, null);
      assert.deepEqual(normalized.evidenceIds, input.evidenceIds);
      validateAssessment(resolveSubmission(normalized, evidence), candidate(), evidence.reads);
      submissions++;
      return JSON.stringify({ accepted: true });
    },
  });
  const call = { name: tool.name, id: 'normalized', args };
  const result = await gate(call, async normalized => tool.invoke({
    ...call, args: normalized!, type: 'tool_call',
  }));
  assert.ok(result instanceof ToolMessage);
  assert.equal(JSON.parse(String(result.content)).accepted, true);
  assert.equal(submissions, 1);
  assert.equal(events.filter(event => event.event === 'assessment_argument_normalized').length, 7);
  assert.ok(!JSON.stringify(events).includes('10000'));
  assert.equal(args.pe, '20');
  assert.equal(args.dataGapReason, '   ');
});

test('normalization accepts explicit numeric formats and missing tokens without guessing ambiguous values', () => {
  for (const [value, expected] of [[' 0 ', 0], ['-20.5', -20.5], ['+.5', 0.5]] as const) {
    const { args } = normalizeSubmissionArguments({ ...submissionExamples.unclassified, pe: value }, submissionSchema);
    assert.equal(submissionSchema.parse(args).pe, expected);
  }
  for (const value of ['', '  ', 'null', 'NULL', 'N/A', 'na', 'unknown', 'unverified', 'not available']) {
    const { args, conversions } = normalizeSubmissionArguments({ ...submissionExamples.unclassified, pe: value }, submissionSchema);
    assert.equal(submissionSchema.parse(args).pe, null);
    assert.equal(conversions.length, 1);
  }
  for (const [value, expected] of [['20x', 20], ['1,000', 1000]] as const) {
    const { args } = normalizeSubmissionArguments({ ...submissionExamples.unclassified, pe: value }, submissionSchema);
    assert.equal(submissionSchema.parse(args).pe, expected);
  }
  for (const value of ['₹20', '12%', '1 crore', '1,2', '1e3', '0x10', 'Infinity', 'NaN',
    '9007199254740993', '0.' + '0'.repeat(400) + '1', 'none', {}, true, ['20']]) {
    const { args, conversions } = normalizeSubmissionArguments({ ...submissionExamples.unclassified, pe: value }, submissionSchema);
    assert.equal(submissionSchema.safeParse(args).success, false);
    assert.equal(conversions.length, 0);
  }
  for (const value of ['', ' '.repeat(25), 'null', 'Too short']) {
    const { args, conversions } = normalizeSubmissionArguments({ ...submissionExamples.unclassified, dataGapReason: value }, submissionSchema);
    assert.equal(submissionSchema.safeParse(args).success, false);
    assert.equal(conversions.length, 0);
  }
  for (const value of ['', '   ', ' null ', 'NULL']) {
    const { args, conversions } = normalizeSubmissionArguments({ ...submissionExamples.classified, dataGapReason: value }, submissionSchema);
    assert.equal(submissionSchema.parse(args).dataGapReason, null);
    assert.equal(conversions.length, 1);
  }
  const { args } = normalizeSubmissionArguments({ ...submissionExamples.unclassified, dataGapReason: null }, submissionSchema);
  const unsure = resolveSubmission(submissionSchema.parse(args), new LiveEvidence());
  assert.doesNotThrow(() => validateAssessment(unsure, candidate(), []));
  assert.ok(unsure.dataGapReason);
});

test('numeric mismatches and timestamp issues are reported together without rejecting the first submission', async () => {
  const { gate, failures, events } = fixture();
  const { evidence, input } = capturedFixture();
  let submissions = 0;
  const tool = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Best-effort evidence fixture', schema: submissionSchema,
    func: async normalized => {
      submissions++;
      const assessment = resolveSubmission(normalized, evidence);
      const warnings = validateAssessment(assessment, candidate(), evidence.reads);
      assert.equal(assessment.profitProbability, 'medium');
      assert.ok(warnings.some(warning => warning.field === 'pe' && warning.code === 'numeric_evidence_mismatch'));
      assert.ok(warnings.some(warning => warning.field === 'marketCapCrore' && warning.code === 'numeric_evidence_mismatch'));
      assert.ok(warnings.some(warning => warning.code === 'quote_timestamp_not_in_excerpt'));
      return JSON.stringify({ accepted: true, warnings });
    },
  });
  const call = { name: tool.name, id: 'one', args: {
    ...input, pe: '9999', marketCapCrore: '132928258048', quoteTimestampText: '28 Oct 2026 10:00 IST',
  } };
  const result = await gate(call, normalized => tool.invoke({ ...call, args: normalized!, type: 'tool_call' }));
  assert.ok(result instanceof ToolMessage);
  assert.equal(JSON.parse(String(result.content)).accepted, true);
  assert.equal(submissions, 1);
  assert.equal(failures.length, 0);
  assert.equal(events.filter(event => event.event === 'assessment_rejected').length, 0);
});

test('only a transient network failure retries the same prepared submission, once', async () => {
  const { gate, events } = fixture();
  const inputs: unknown[] = [];
  const result = await gate({ name: 'submit_stock_assessment', id: 'network', args: submissionExamples.unclassified },
    async input => {
      inputs.push(input);
      if (inputs.length === 1) throw new TypeError('fetch failed');
      return JSON.stringify({ accepted: true });
    });
  assert.ok(result instanceof ToolMessage);
  assert.equal(JSON.parse(String(result.content)).accepted, true);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0], inputs[1]);
  assert.equal(events.filter(event => event.event === 'research_network_retry').length, 1);
});

test('flat numbers resolve to exact captured sources without model-supplied URLs or excerpts', () => {
  const { evidence, input } = capturedFixture();
  const assessment = resolveSubmission(input, evidence);
  assert.ok(assessment.pe?.source);
  assert.equal(assessment.pe!.value, 20);
  assert.equal(assessment.pe.source.url, evidence.reads[0]!.url);
  assert.equal(assessment.pe.source.excerpt, evidence.reads[0]!.output);
  assert.equal(assessment.marketEvidence!.url, evidence.reads[1]!.url);
  assert.doesNotThrow(() => validateAssessment(assessment, candidate(), evidence.reads));
});

test('unknown, foreign and contradictory citations produce warnings without fabricating source records', () => {
  const { evidence, input } = capturedFixture();
  const otherStock = capturedFixture();
  for (const id of ['made-up', otherStock.evidence.reads[0]!.evidenceId!]) {
    const result = resolveSubmission({
      ...input, evidenceIds: { ...input.evidenceIds, pe: id },
    }, evidence);
    assert.equal(result.pe!.source, null);
    assert.ok(result.warnings?.some(warning => warning.field === 'pe' && warning.code === 'unresolved_citation'));
  }
  const uncited = resolveSubmission({
    ...input, evidenceIds: { ...input.evidenceIds, pe: null },
  }, evidence);
  assert.equal(uncited.pe!.source, null);
  assert.doesNotThrow(() => validateAssessment(uncited, candidate(), evidence.reads));
  const unused = resolveSubmission({ ...input, marketCapCrore: null }, evidence);
  assert.equal(unused.marketCapCrore, null);
  assert.ok(unused.warnings?.some(warning => warning.field === 'marketCapCrore' && warning.code === 'unused_citation'));
  validateAssessment(unused, candidate(), evidence.reads);
  assert.equal(unused.profitProbability, 'medium');
  const additional = resolveSubmission({ ...input, additionalEvidenceIds: ['made-up'] }, evidence);
  assert.deepEqual(additional.sources, []);
  assert.ok(additional.warnings?.some(warning => warning.code === 'unresolved_citation'));
  const empty = resolveSubmission(input, new LiveEvidence());
  validateAssessment(empty, candidate(), []);
  assert.equal(empty.profitProbability, null);
  assert.equal(empty.livePrice!.source, null);
});

test('earnings growth without an optional citation no longer rejects a classified assessment', () => {
  const { evidence, input } = capturedFixture();
  const assessment = resolveSubmission({
    ...input, sectorPe: 18, evidenceIds: {
      ...input.evidenceIds, pe: null, sectorPe: null, debtToEquity: null, earningsGrowthPercent: null,
    },
  }, evidence);
  assert.equal(assessment.earningsGrowthPercent!.value, 12);
  assert.equal(assessment.earningsGrowthPercent!.source, null);
  assert.equal(assessment.pe!.value, 20);
  assert.equal(assessment.sectorPe!.value, 18);
  assert.equal(assessment.sectorPe!.source, null);
  assert.equal(assessment.debtToEquity!.value, 0.5);
  assert.equal(assessment.risks.filter(risk => risk.includes('model-reported without a captured citation')).length, 4);
  validateAssessment(assessment, candidate(), evidence.reads);
  for (const field of ['livePrice', 'marketCapCrore'] as const) {
    const uncited = resolveSubmission({
      ...input, evidenceIds: { ...input.evidenceIds, [field]: null },
    }, evidence);
    validateAssessment(uncited, candidate(), evidence.reads);
    assert.equal(uncited[field]!.source, null);
    assert.equal(uncited.profitProbability, 'medium');
  }
  assert.ok(validateAssessment({ ...assessment, corporateActionEvidence: null }, candidate(), evidence.reads)
    .some(warning => warning.field === 'corporateActionEvidence'));
});

test('resolution retains numeric, freshness, timestamp and source-diversity checks as nonblocking warnings', () => {
  const { evidence, input } = capturedFixture();
  const fabricated = resolveSubmission({ ...input, pe: 9999 }, evidence);
  assert.ok(validateAssessment(fabricated, candidate(), evidence.reads).some(warning => warning.code === 'numeric_evidence_mismatch'));
  const valid = resolveSubmission(input, evidence);
  assert.ok(validateAssessment(valid, candidate(), evidence.reads, Date.now() + 2 * 3_600_000).some(warning => warning.code === 'stale_evidence'));
  const wrongTimestamp = resolveSubmission({ ...input, quoteTimestampText: '28 Oct 2026 10:00 IST' }, evidence);
  assert.ok(validateAssessment(wrongTimestamp, candidate(), evidence.reads).some(warning => warning.code === 'quote_timestamp_not_in_excerpt'));
  const singleDomain = resolveSubmission({
    ...input, evidenceIds: { ...input.evidenceIds, marketEvidence: input.evidenceIds.livePrice },
  }, evidence);
  assert.ok(validateAssessment(singleDomain, candidate(), evidence.reads).some(warning => warning.code === 'limited_source_diversity'));
  for (const read of evidence.reads) {
    read.kind = 'tavily';
    read.newsDays = 1;
    read.publishedAt = new Date().toISOString();
  }
  assert.doesNotThrow(() => validateAssessment(resolveSubmission(input, evidence), candidate(), evidence.reads));
  evidence.reads[0]!.publishedAt = '2020-01-01T00:00:00Z';
  assert.ok(validateAssessment(resolveSubmission(input, evidence), candidate(), evidence.reads)
    .some(warning => warning.code === 'publication_date_unverified'));
});

test('research results expose evidence IDs through real tool callbacks and isolate parallel calls', async () => {
  const evidence = new LiveEvidence();
  const tool = new DynamicStructuredTool({
    name: 'tavily_search', description: 'Fixture search',
    schema: z.object({ query: z.string() }),
    func: async ({ query }) => JSON.stringify({
      results: [{ url: `https://${query}.org`, content: `Captured content for ${query}, PE is 20.` }],
    }),
  });
  const messages = await Promise.all(['one', 'two'].map(async name => {
    const result = await tool.invoke({
      type: 'tool_call', id: name, name: tool.name, args: { query: name },
    }, { callbacks: [evidence] });
    assert.ok(result instanceof ToolMessage);
    return evidence.annotate(result);
  }));
  for (const [index, message] of messages.entries()) {
    const results = JSON.parse(String(message.content)).results;
    assert.equal(results.length, 1);
    assert.equal(results[0].url, `https://${index === 0 ? 'one' : 'two'}.org`);
    assert.equal(evidence.resolve(results[0].evidenceId).excerpt, results[0].content);
  }
  assert.equal(new Set(evidence.catalog().map(item => item.evidenceId)).size, 2);
  const unrelated = new ToolMessage({ tool_call_id: 'uncaptured', content: 'not evidence' });
  assert.equal(evidence.annotate(unrelated), unrelated);
});
