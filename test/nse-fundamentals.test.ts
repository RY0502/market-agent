import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { NseFundamentalsStore, parsePe, parsePr, peUrl, prUrl } from '../src/nse-fundamentals.js';
import { initializeStorage, prune } from '../src/storage.js';
import { activeSubmissionSchema, activeSubmissionExamples, prepareSubmission, applyNseFundamentals, validateAssessment, createAssessmentGate } from '../src/research.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { z } from 'zod';
import { ResearchDiagnostics, researchLimitsSchema } from '../src/research-control.js';
import { isPausedMetricSearch } from '../src/research-policy.js';
import { candidate, equity, prFixture, research } from './helpers.js';
import { withResearchCache } from '../src/research-cache.js';
import { renderStockReport, reportReasoning } from '../src/reports.js';

const peCsv = 'SYMBOL,SYMBOL P/E,ADJUSTED P/E\nEXAMPLE,25.5,26.8\nOLDNAME,18,19\nLOSS,NA,Infinity';

test('NSE URL/date conventions, distinct P/E figures, missing ratios and strict PR date/unit validation', () => {
  assert.equal(peUrl('2026-10-28'), 'https://nsearchives.nseindia.com/content/equities/peDetail/PE_281026.csv');
  assert.equal(prUrl('2026-10-28'), 'https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PR281026.zip');
  const pe = parsePe(peCsv, '2026-10-28');
  assert.equal(pe.get('EXAMPLE')!.pe, 25.5);
  assert.equal(pe.get('EXAMPLE')!.adjustedPe, 26.8);
  assert.equal(pe.get('LOSS')!.pe, null);
  assert.equal(pe.get('LOSS')!.adjustedPe, null);
  assert.throws(() => parsePe(peCsv.replace('25.5', 'oops'), '2026-10-28'), /Invalid NSE financial number/);
  assert.throws(() => parsePe(peCsv + '\nEXAMPLE,20,20', '2026-10-28'), /duplicate/);
  assert.throws(() => parsePe('', '2026-10-28'), /Empty NSE/);
  assert.throws(() => parsePe('SYMBOL,SYMBOL P/E,ADJUSTED P/E,SYMBOL\nEXAMPLE,1,1,OTHER', '2026-10-28'), /headers/);
  assert.throws(() => parsePe(peCsv.replace('25.5', `0.${'0'.repeat(400)}1`), '2026-10-28'), /safe range/);
  const pr = parsePr(prFixture('2026-10-28', 'EXAMPLE', '12345678900',
    'EQ,EXAMPLE,2026-10-30,,,2026-10-29,BONUS 1:1'), '2026-10-28');
  assert.equal(pr.caps.get('EXAMPLE')!.value, 1234.56789);
  assert.equal(pr.actions[0]!.exDate, '2026-10-29');
  assert.equal(pr.actions[0]!.purpose, 'BONUS 1:1');
  assert.throws(() => parsePr(prFixture('2026-10-27'), '2026-10-28'), /missing its dated/);
  const emptyActions = unzipSync(prFixture('2026-10-28'));
  emptyActions['bc28102026.csv'] = new Uint8Array();
  assert.throws(() => parsePr(zipSync(emptyActions), '2026-10-28'), /Empty NSE/);
});

test('NSE history joins daily symbols through bhavcopy ISIN, deduplicates events and reuses disk files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-fundamentals-'));
  try {
    await initializeStorage(root);
    const calls: string[] = [];
    const request: typeof fetch = async input => {
      const url = String(input); calls.push(url);
      if (url.endsWith('.csv')) return new Response(peCsv);
      const date = url.includes('271026') ? '2026-10-27' : '2026-10-28';
      const symbol = date === '2026-10-27' ? 'OLDNAME' : 'EXAMPLE';
      return new Response(Buffer.from(prFixture(date, symbol, '100000000000',
        `EQ,${symbol},2026-10-30,,,2026-10-29,BONUS 1:1`)));
    };
    const previous = equity({ date: '2026-10-27', symbol: 'OLDNAME' });
    const current = equity({ date: '2026-10-28' });
    const history = { current: [current], days: [[previous], [current]], baseline: previous.date, dates: [previous.date, current.date] };
    const c = candidate({ asOfDate: current.date, baselineDate: previous.date });
    const store = new NseFundamentalsStore(root, request);
    const context = (await store.contexts(history, [c])).get(c.isin)!;
    assert.deepEqual(context.history.map(point => [point.symbol, point.pe]), [['OLDNAME',18],['EXAMPLE',25.5]]);
    assert.equal(context.pe!.value, 25.5);
    assert.equal(context.marketCapCrore!.value, 10000);
    assert.deepEqual(context.historical, { pe: null, adjustedPe: null, marketCapCrore: null },
      'Current valid values take priority over historical observations');
    assert.equal(context.corporateActions.length, 1);
    assert.equal(context.corporateActions[0]!.reportedOn, current.date);
    assert.deepEqual(store.downloads, { pe: 2, pr: 2 });
    const cached = new NseFundamentalsStore(root, async () => { throw new Error('No network on cache hit'); });
    assert.deepEqual((await cached.contexts(history, [c])).get(c.isin), context);
    assert.deepEqual(cached.downloads, { pe: 0, pr: 0 });
    assert.equal(calls.length, 4);
    assert.equal((await readdir(path.join(root, 'nse'))).length, 4);
    await prune(root, '2027-01-01');
    assert.deepEqual(await readdir(path.join(root, 'nse')), []);
  } finally { await rm(root, { recursive: true }); }
});

test('missing current NSE metrics use independent latest valid historical dates across renamed symbols and cache hits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-historical-context-'));
  try {
    await initializeStorage(root);
    const observations = [
      { date: '2026-10-23', symbol: 'OLDNAME', pe: '10', adjusted: '11', cap: '5000000000' },
      { date: '2026-10-26', symbol: 'OLDNAME', pe: '18', adjusted: '19', cap: '10000000000' },
      { date: '2026-10-27', symbol: 'EXAMPLE', pe: '0', adjusted: '24', cap: '20000000000' },
      { date: '2026-10-28', symbol: 'EXAMPLE', pe: 'NA', adjusted: 'NA', cap: '0' },
    ];
    const files = new Map<string, Uint8Array | string>();
    for (const point of observations) {
      files.set(peUrl(point.date), `SYMBOL,SYMBOL P/E,ADJUSTED P/E\n${point.symbol},${point.pe},${point.adjusted}`);
      files.set(prUrl(point.date), prFixture(point.date, point.symbol, point.cap));
    }
    let downloads = 0;
    const store = new NseFundamentalsStore(root, async input => {
      downloads++;
      const file = files.get(String(input));
      assert.ok(file, `Unexpected request ${String(input)}`);
      return new Response(typeof file === 'string' ? file : Buffer.from(file));
    });
    const days = observations.map(point => [equity({ date: point.date, symbol: point.symbol })]);
    const history = { current: days.at(-1)!, days, baseline: observations[0]!.date };
    const c = candidate({ asOfDate: '2026-10-28', baselineDate: history.baseline });
    c.nse = (await store.contexts(history, [c])).get(c.isin)!;
    assert.equal(downloads, 8);
    assert.equal(c.nse.pe, null, 'Current-date slots remain unknown, not backdated');
    assert.equal(c.nse.adjustedPe, null);
    assert.equal(c.nse.marketCapCrore, null);
    assert.equal(c.nse.historical.pe!.value, 18);
    assert.equal(c.nse.historical.pe!.asOf, '2026-10-26');
    assert.equal(c.nse.historical.pe!.source.url, peUrl('2026-10-26'));
    assert.equal(c.nse.historical.adjustedPe!.value, 24);
    assert.equal(c.nse.historical.adjustedPe!.asOf, '2026-10-27');
    assert.equal(c.nse.historical.marketCapCrore!.value, 2000);
    assert.equal(c.nse.historical.marketCapCrore!.asOf, '2026-10-27');
    assert.equal(c.nse.historical.marketCapCrore!.source.url, prUrl('2026-10-27'));
    const cachedStore = new NseFundamentalsStore(root, async () => { throw new Error('No network on cache hit'); });
    assert.deepEqual((await cachedStore.contexts(history, [c])).get(c.isin), c.nse);
    const cachedResult = await withResearchCache(root, 30, 'historical-first', async () => research())(c);
    const result = await withResearchCache(root, 30, 'historical-refresh', async (_candidate, cached) => {
      assert.ok(cached);
      return research();
    })(c);
    assert.equal(result.cache!.hit, true);
    assert.equal(cachedResult.assessment.pe!.value, 18);
    assert.equal(result.assessment.pe!.value, 18);
    assert.equal(result.assessment.marketCapCrore!.value, 2000);
    assert.match(result.assessment.financialPeriod, /P\/E: NSE 2026-10-26 \(historical\)/);
    assert.match(result.assessment.financialPeriod, /Market cap: NSE 2026-10-27 \(historical\)/);
    assert.ok(!result.assessment.warnings?.some(warning =>
      warning.code === 'numeric_evidence_mismatch' && ['pe','marketCapCrore'].includes(warning.field)));
    const ranked = { candidate: c, research: result, rank: 1, riskScore: 20, recoveryScore: 80 };
    const metrics = reportReasoning(ranked).metrics;
    assert.deepEqual(metrics.filter(metric => ['P/E','Market cap (INR crore)'].includes(metric.label))
      .map(metric => [metric.value, metric.asOf, metric.historical]), [[2000,'2026-10-27',true]]);
    const html = renderStockReport(ranked, 'historical-test', [], 1, new Date().toISOString(), '2100-01-01T00:00:00Z');
    assert.doesNotMatch(html, /Historical context: 2026-10-26/);
    assert.doesNotMatch(html, /Adjusted P\/E \(distinct NSE figure\)/);
    assert.doesNotMatch(html, /NSE P\/E history/);
    assert.match(html, /Historical context: 2026-10-27/);
    assert.doesNotMatch(html, /As of: 2026-10-28/);
  } finally { await rm(root, { recursive: true }); }
});

test('missing current NSE report files retain dated historical context without clearing missing-file diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-historical-404-'));
  try {
    await initializeStorage(root);
    const previous = equity({ date: '2026-10-26' });
    const current = equity({ date: '2026-10-27' });
    const c = candidate({ asOfDate: current.date, baselineDate: previous.date });
    const store = new NseFundamentalsStore(root, async input => {
      const url = String(input);
      if (url.includes('271026')) return new Response('', { status: 404 });
      return url.endsWith('.csv') ? new Response('SYMBOL,SYMBOL P/E,ADJUSTED P/E\nEXAMPLE,18,19')
        : new Response(Buffer.from(prFixture(previous.date, 'EXAMPLE', '10000000000')));
    });
    const context = (await store.contexts({
      current: [current], days: [[previous],[current]], baseline: previous.date,
    }, [c])).get(c.isin)!;
    assert.equal(context.pe, null);
    assert.equal(context.marketCapCrore, null);
    assert.equal(context.historical.pe!.asOf, previous.date);
    assert.equal(context.historical.marketCapCrore!.asOf, previous.date);
    assert.deepEqual(context.missingFiles, [{ date: current.date, type: 'pe' },{ date: current.date, type: 'pr' }]);
  } finally { await rm(root, { recursive: true }); }
});

test('historical NSE fallback excludes future/out-of-window values and does not invent entirely missing metrics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-bounded-history-'));
  try {
    await initializeStorage(root);
    const days = ['2026-10-23','2026-10-26','2026-10-27','2026-10-28'].map(date => [equity({ date })]);
    const store = new NseFundamentalsStore(root, async input => {
      const url = String(input);
      const old = url.includes('231026');
      const future = url.includes('281026');
      const date = old ? '2026-10-23' : future ? '2026-10-28' : url.includes('261026') ? '2026-10-26' : '2026-10-27';
      if (url.endsWith('.csv')) return new Response(
        `SYMBOL,SYMBOL P/E,ADJUSTED P/E\nEXAMPLE,${old || future ? '25,26' : 'NA,NA'}`);
      return new Response(Buffer.from(prFixture(date, 'EXAMPLE', old || future ? '10000000000' : '0')));
    });
    const c = candidate({ asOfDate: '2026-10-27', baselineDate: '2026-10-26' });
    const context = (await store.contexts({
      current: days[2]!, days, baseline: c.baselineDate,
    }, [c])).get(c.isin)!;
    assert.deepEqual(context.historical, { pe: null, adjustedPe: null, marketCapCrore: null });
    const result = research();
    applyNseFundamentals(result.assessment, result.reads, context);
    assert.equal(result.assessment.pe, null);
    assert.equal(result.assessment.marketCapCrore, null);
  } finally { await rm(root, { recursive: true }); }
});

test('missing daily reports never borrow another date or invoke fallback searches; access errors and caps remain explicit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-missing-fundamentals-'));
  try {
    await initializeStorage(root);
    const current = equity();
    const history = { current: [current], days: [[current]], baseline: '2026-10-25' };
    const missing = new NseFundamentalsStore(root, async () => new Response('', { status: 404 }));
    const context = (await missing.contexts(history, [candidate()])).get(current.isin)!;
    assert.equal(context.pe, null);
    assert.equal(context.marketCapCrore, null);
    assert.equal(context.corporateActions.length, 0, 'No notices is not corporate-action clearance');
    assert.deepEqual(context.missingFiles.map(file => file.type), ['pe','pr']);
    const denied = new NseFundamentalsStore(root, async () => new Response('', { status: 403 }));
    await assert.rejects(denied.contexts(history, [candidate()]), /HTTP 403/);
    denied.downloads.pe = 31;
    await assert.rejects(denied.contexts(history, [candidate()]), /31 NSE pe/);
    await writeFile(path.join(root, 'nse', `${current.date}.pe.csv`), peCsv);
    await writeFile(path.join(root, 'nse', `${current.date}.pr.zip`), prFixture(current.date));
    const cached = (await denied.contexts(history, [candidate()])).get(current.isin)!;
    assert.equal(cached.pe!.value, 25.5, 'Existing files remain readable at the download cap');
  } finally { await rm(root, { recursive: true }); }
});

test('undefined P/E diagnostics occur once per date/field on fresh downloads and disk reads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-pe-diagnostics-'));
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  try {
    await initializeStorage(root);
    const current = equity();
    const history = { current: [current], days: [[current]], baseline: current.date };
    const expected = JSON.stringify({
      event: 'nse_pe_undefined', date: current.date, symbol: 'EXAMPLE', field: 'ADJUSTED P/E',
    });
    const store = new NseFundamentalsStore(root, async input => String(input).endsWith('.csv')
      ? new Response('SYMBOL,SYMBOL P/E,ADJUSTED P/E\nEXAMPLE,25.5,Infinity')
      : new Response(Buffer.from(prFixture(current.date))));
    const fresh = (await store.contexts(history, [candidate()])).get(current.isin)!;
    assert.deepEqual(warnings, [expected]);
    assert.equal(fresh.pe!.value, 25.5);
    assert.equal(fresh.adjustedPe, null);
    assert.deepEqual(store.downloads, { pe: 1, pr: 1 });
    warnings.length = 0;
    const cached = new NseFundamentalsStore(root, async () => { throw new Error('No network on cache hit'); });
    assert.deepEqual((await cached.contexts(history, [candidate()])).get(current.isin), fresh);
    assert.deepEqual(warnings, [expected], 'Cached data still emits genuine unavailable-value diagnostics');
    assert.deepEqual(cached.downloads, { pe: 0, pr: 0 });
  } finally { await rm(root, { recursive: true }); }
});

test('invalid NSE downloads are rejected before disk caching', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-invalid-download-'));
  try {
    await initializeStorage(root);
    const current = equity();
    const store = new NseFundamentalsStore(root, async () =>
      new Response('SYMBOL,SYMBOL P/E,ADJUSTED P/E\nEXAMPLE,not-a-ratio,20'));
    await assert.rejects(store.contexts({
      current: [current], days: [[current]], baseline: current.date,
    }, [candidate()]), /Invalid NSE financial number/);
    assert.deepEqual(await readdir(path.join(root, 'nse')), []);
    assert.deepEqual(store.downloads, { pe: 0, pr: 0 });
  } finally { await rm(root, { recursive: true }); }
});

test('model schema omits paused/NSE-owned fields, fills the fixed horizon locally and blocks metric searches', () => {
  for (const field of ['livePrice','quoteAsOf','quoteTimestampText','pe','sectorPe','marketCapCrore','debtToEquity',
    'earningsGrowthPercent','financialPeriod','corporateActionsClear','outlookHorizon']) {
    assert.ok(!(field in activeSubmissionSchema.shape));
  }
  assert.deepEqual(Object.keys(activeSubmissionSchema.shape.evidenceIds.shape), ['marketEvidence']);
  const prepared = prepareSubmission(activeSubmissionExamples.classified, 'EXAMPLE', activeSubmissionSchema);
  assert.deepEqual(prepared.warnings, []);
  assert.equal(prepared.input.outlookHorizon, 'next_trading_week');
  assert.equal(prepared.input.pe, null);
  for (const query of ['EXAMPLE P/E', 'EXAMPLE PE', 'EXAMPLE market cap', 'EXAMPLE debt to equity',
    'EXAMPLE earnings growth', 'EXAMPLE corporate actions', 'EXAMPLE latest share price', 'EXAMPLE quote timestamp']) {
    assert.equal(isPausedMetricSearch(query), true, query);
  }
  assert.equal(isPausedMetricSearch('EXAMPLE latest material company news announcements'), false);
});

test('model-facing tool schema inlines evidence IDs without provider-incompatible JSON references', () => {
  const tool = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Active NSE assessment schema',
    schema: activeSubmissionSchema, func: async () => 'accepted',
  });
  const parameters = convertToOpenAITool(tool).function.parameters;
  assert.ok(parameters);
  assert.doesNotMatch(JSON.stringify(parameters), /"\$ref"/);
  const shape = z.object({
    properties: z.object({ additionalEvidenceIds: z.object({ items: z.unknown() }) }),
  }).parse(parameters);
  assert.deepEqual(shape.properties.additionalEvidenceIds.items, {
    type: 'string', minLength: 1,
    description: 'Exact evidenceId returned by a research tool in this stock evaluation',
  });
  const input = activeSubmissionExamples.classified;
  assert.ok(activeSubmissionSchema.safeParse({ ...input, evidenceIds: {} }).success);
  assert.ok(activeSubmissionSchema.safeParse({ ...input, evidenceIds: { marketEvidence: null } }).success);
  assert.ok(!activeSubmissionSchema.safeParse({ ...input, evidenceIds: { marketEvidence: '' } }).success);
  assert.ok(!activeSubmissionSchema.safeParse({ ...input, additionalEvidenceIds: [''] }).success);
});

test('the reduced model submission passes the real tool parser after canonical local preparation', async () => {
  const diagnostics = new ResearchDiagnostics({ symbol: 'EXAMPLE', runId: 'nse-policy' },
    researchLimitsSchema.parse({}), activeSubmissionSchema, () => {}, () => {});
  const gate = createAssessmentGate('EXAMPLE', diagnostics, activeSubmissionSchema);
  let submissions = 0;
  const tool = new DynamicStructuredTool({
    name: 'submit_stock_assessment', description: 'Active NSE assessment schema', schema: activeSubmissionSchema,
    func: async input => {
      submissions++;
      assert.ok(!('pe' in input));
      const prepared = prepareSubmission(input, 'EXAMPLE', activeSubmissionSchema);
      assert.equal(prepared.input.outlookHorizon, 'next_trading_week');
      assert.deepEqual(prepared.warnings, []);
      return JSON.stringify({ accepted: true });
    },
  });
  const call = { name: tool.name, id: 'nse-submission', args: activeSubmissionExamples.classified };
  await gate(call, async canonical => tool.invoke(activeSubmissionSchema.strip().parse(canonical)));
  assert.equal(submissions, 1);
});

test('official NSE metrics override model/cache values, retain positive action evidence and drive published research context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-research-'));
  try {
    await initializeStorage(root);
    const c = candidate();
    const current = equity();
    const store = new NseFundamentalsStore(root, async input => String(input).endsWith('.csv')
      ? new Response(peCsv) : new Response(Buffer.from(prFixture(c.asOfDate, c.symbol, '100000000000',
        `EQ,${c.symbol},2026-10-30,,,2026-10-29,BONUS 1:1`))));
    c.nse = (await store.contexts({ current: [current], days: [[current]], baseline: c.baselineDate }, [c])).get(c.isin)!;
    const result = research(c.symbol);
    result.assessment.pe!.value = 9999;
    result.assessment.warnings = [{ field: 'quoteAsOf', code: 'timestamp_unverified', message: 'Old quote warning' }];
    result.assessment.risks.push('Old quote warning');
    applyNseFundamentals(result.assessment, result.reads, c.nse);
    const warnings = validateAssessment(result.assessment, c, result.reads);
    assert.equal(result.assessment.pe!.value, 25.5);
    assert.equal(result.assessment.marketCapCrore!.value, 10000);
    assert.equal(result.assessment.debtToEquity, null);
    assert.equal(result.assessment.earningsGrowthPercent, null);
    assert.equal(result.assessment.quoteAsOf, null);
    assert.equal(result.assessment.corporateActionsClear, false);
    assert.ok(result.assessment.corporateActionEvidence);
    assert.ok(!warnings.some(warning => ['quoteAsOf','livePrice','debtToEquity','earningsGrowthPercent','corporateActionsClear','pe','marketCapCrore'].includes(warning.field)));
    assert.ok(!result.assessment.risks.includes('Old quote warning'));
    const nseOnly = { ...research(c.symbol, { marketEvidence: null, sources: [] }), reads: [] };
    applyNseFundamentals(nseOnly.assessment, nseOnly.reads, c.nse);
    validateAssessment(nseOnly.assessment, c, nseOnly.reads);
    assert.equal(nseOnly.assessment.profitProbability, 'high', 'Captured NSE records count as real research evidence');
    const first = await withResearchCache(root, 30, 'first', async () => result)(c);
    const refreshed = await withResearchCache(root, 30, 'second', async (_candidate, cached) => {
      assert.ok(cached);
      return research(c.symbol);
    })(c);
    assert.equal(refreshed.cache!.hit, true);
    assert.equal(refreshed.assessment.pe!.value, first.assessment.pe!.value);
    const html = renderStockReport({ candidate: c, research: refreshed, rank: 1, riskScore: 20, recoveryScore: 80 },
      'test', [{ date: c.asOfDate, close: c.price }], 1, new Date().toISOString(), '2100-01-01T00:00:00Z');
    assert.doesNotMatch(html, /NSE P\/E history/);
    assert.match(html, /25\.5/);
    assert.match(html, /BONUS 1:1/);
    assert.doesNotMatch(html, /Debt \/ equity|Earnings growth \(%\)/);
  } finally { await rm(root, { recursive: true }); }
});
