import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuoteTimestamp } from '../src/quote-time.js';
import { validateAssessment } from '../src/research.js';
import { candidate, research } from './helpers.js';

test('quote timestamps normalize ISO offsets, IST, named months and Indian numeric dates', () => {
  for (const text of [
    '2026-10-28T15:30:00+05:30', '2026-10-28T10:00:00Z',
    '28 Oct 2026 15:30 IST', '28 Oct 2026, 3:30 PM IST',
    '28/10/2026 15:30:00 +0530', '28-10-2026 15:30 IST',
  ]) assert.equal(normalizeQuoteTimestamp(text), '2026-10-28T10:00:00.000Z');
  assert.equal(normalizeQuoteTimestamp('28 Oct 2026 12:00 AM IST'), '2026-10-27T18:30:00.000Z');
  assert.equal(normalizeQuoteTimestamp('2026-10-28T05:00:00-05:00'), '2026-10-28T10:00:00.000Z');
});

test('ambiguous, incomplete and impossible source timestamps are rejected', () => {
  for (const text of [
    'today 15:30 IST', '28 Oct 2026', '28 Oct 2026 15:30',
    '2026-02-30T15:30:00Z', '2026-10-28T25:30:00Z', '2026-10-28T10:00:00+15:00',
    '28 Oct 2026 15:30 PM IST', '28 Xxx 2026 15:30 IST',
  ]) assert.throws(() => normalizeQuoteTimestamp(text));
});

test('verbatim non-ISO quote text validates against its normalized instant without changing the excerpt', () => {
  const result = research();
  const original = result.assessment.quoteAsOf!;
  const displayed = '28 Oct 2026, 3:30 PM IST';
  const normalized = '2026-10-28T10:00:00Z';
  result.assessment.quoteAsOf = normalized;
  result.assessment.quoteTimestampText = displayed;
  for (const read of result.reads) {
    read.output = read.output.replaceAll(original, displayed);
    read.observedAt = normalized;
  }
  const sources = [
    ...result.assessment.sources, result.assessment.livePrice!.source, result.assessment.pe!.source,
    result.assessment.marketCapCrore!.source, result.assessment.debtToEquity!.source,
    result.assessment.earningsGrowthPercent!.source, result.assessment.corporateActionEvidence!,
    result.assessment.marketEvidence!,
  ];
  for (const source of new Set(sources.filter(source => source !== null))) {
    source.excerpt = source.excerpt.replaceAll(original, displayed);
  }
  const now = Date.parse(normalized);
  assert.doesNotThrow(() => validateAssessment(result.assessment, candidate(), result.reads, now));
  result.assessment.quoteAsOf = '2026-10-28T09:00:00Z';
  assert.ok(validateAssessment(result.assessment, candidate(), result.reads, now)
    .some(warning => warning.code === 'quote_timestamp_mismatch'));
  result.assessment.quoteTimestampText = '28 Oct 2026 14:30 IST';
  assert.ok(validateAssessment(result.assessment, candidate(), result.reads, now)
    .some(warning => warning.code === 'quote_timestamp_not_in_excerpt'));
  result.assessment.quoteTimestampText = displayed;
  result.assessment.quoteAsOf = normalized;
  assert.ok(validateAssessment(result.assessment, candidate(), result.reads, now + 97 * 3_600_000)
    .some(warning => warning.code === 'quote_freshness'));
  assert.equal(result.assessment.profitProbability, 'high');
});
