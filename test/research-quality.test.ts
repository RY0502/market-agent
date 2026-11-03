import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessEvidenceGaps, distinctBusinessReads, researchQuality } from '../src/research-quality.js';
import { decisionBrief, renderStockReport } from '../src/reports.js';
import { candidate, research } from './helpers.js';
import type { LiveRead, RankedStock } from '../src/research.js';
import { validateAssessment } from '../src/research.js';
import { calculatePriceSignals } from '../src/price-signals.js';
import { equity } from './helpers.js';

const now = Date.parse('2026-11-03T09:00:00Z');
const news = (overrides: Partial<LiveRead> = {}): LiveRead => ({
  evidenceId: 'news1', url: 'https://news.example/announcement', kind: 'tavily',
  output: 'The company announced a new manufacturing project, with execution costs and risks still to be assessed.',
  observedAt: new Date(now).toISOString(), publishedAt: '2026-11-02T00:00:00Z', newsDays: 7, ...overrides,
});
const stock = (): RankedStock => ({ candidate: candidate(), research: research(), rank: 1, riskScore: 20, recoveryScore: 80 });

test('duplicate URLs, search engines and identical syndicated contents do not inflate coverage', () => {
  const reads = [news(), news({ url: 'https://news.example/announcement?utm_source=exa', kind: 'exa' }),
    news({ url: 'https://syndicate.example/reprint', kind: 'exa' })];
  assert.equal(distinctBusinessReads(reads).length, 1);
  const result = research();
  result.reads = reads;
  assert.match(businessEvidenceGaps(result, now).join(' '), /one source domain/);
  result.reads.push(news({
    url: 'https://filings.example/disclosure', kind: 'exa',
    output: 'A separate company filing describes expansion funding and identifies the approval steps that remain outstanding.',
  }));
  assert.deepEqual(businessEvidenceGaps(result, now), []);
});

test('retrieval date does not establish recent news; cached, future and stale observations are dated background', () => {
  for (const overrides of [
    { publishedAt: undefined }, { publishedAt: '2025-11-01T00:00:00Z' },
    { publishedAt: '2026-11-04T00:00:00Z' }, { cachedAt: '2026-11-01T00:00:00Z' },
    { observedAt: '2026-10-25T00:00:00Z' },
    { observedAt: '2026-11-03T07:00:00Z' },
  ]) {
    const result = research();
    result.reads = [news(overrides)];
    assert.match(businessEvidenceGaps(result, now).join(' '), /No captured.*verified publication date/);
  }
});

test('model execution/decision failures are not treated as missing information for another search', () => {
  const result = research();
  result.failure = { name: 'Error', message: 'Provider unavailable' };
  assert.deepEqual(businessEvidenceGaps(result, now), []);
  delete result.failure;
  result.assessment.warnings = [{ field: 'profitProbability', code: 'invalid_submission_field', message: 'Decision unusable.' }];
  assert.deepEqual(businessEvidenceGaps(result, now), []);
});

test('Exa citations without publication dates retain explicit recency warnings', () => {
  const item = stock();
  const read = news({ kind: 'exa', publishedAt: undefined });
  item.research.reads = [read];
  item.research.assessment.marketEvidence = { url: read.url, excerpt: read.output };
  const warnings = validateAssessment(item.research.assessment, item.candidate, item.research.reads, now);
  assert.ok(warnings.some(warning => warning.field === 'marketEvidence' && warning.code === 'publication_date_unverified'));
});

test('confidence depends on cited and recent support, not outlook/category or number of engines', () => {
  const item = stock();
  item.research.reads = [news(), news({
    url: 'https://filings.example/disclosure', kind: 'exa',
    output: 'A separate company filing describes expansion funding and identifies the approval steps that remain outstanding.',
  })];
  item.research.assessment.sources = item.research.reads.map(read => ({ url: read.url, excerpt: read.output }));
  const metricSource = item.research.assessment.pe!.source!;
  item.research.reads.push({ url: metricSource.url, output: metricSource.excerpt, kind: 'nse', observedAt: new Date(now).toISOString() });
  assert.equal(researchQuality(item, now).confidence, 'Stronger');
  item.research.assessment.profitProbability = 'low';
  assert.equal(researchQuality(item, now).confidence, 'Stronger');
  item.research.assessment.sources = [];
  item.research.assessment.marketEvidence = null;
  assert.equal(researchQuality(item, now).confidence, 'Insufficient');
  item.research.assessment.profitProbability = 'high';
  assert.equal(researchQuality(item, now).confidence, 'Insufficient');
});

test('plain-language brief uses measured movement, distinct risk/confidence and avoids technical failure diagnostics', () => {
  const item = stock();
  item.candidate.priceSignals = calculatePriceSignals([
    equity({ date: '2026-10-20', close: 400, volume: 100 }),
    equity({ date: '2026-10-23', close: 440, volume: 300 }),
    equity({ date: '2026-10-26', close: 420, volume: 80 }),
  ], 3, ['2026-10-22']);
  const brief = decisionBrief(item, now);
  assert.match(brief.whatHappened, /5%/);
  assert.match(brief.whyItMatters, /2026-10-20 and 2026-10-23/);
  assert.match(brief.whyItMatters, /3 times the preceding average/);
  assert.match(brief.whyItMatters, /0.8 times that same pre-rise average/);
  assert.match(brief.quality.gaps.join(' '), /missing archives/);
  item.research.failure = { name: 'Error', message: 'Private provider diagnostic' };
  item.research.assessment.classificationReason = 'Unsure: research did not complete successfully; internal diagnostic.';
  item.research.assessment.profitProbability = null;
  const html = renderStockReport(item, 'test', [], 5, new Date(now).toISOString(), '2026-11-08T09:00:00Z');
  assert.match(html, /Decision brief/);
  assert.match(html, /Evidence confidence/);
  assert.match(html, /execution failure, not evidence against the company/);
  assert.match(html, /Rank by past price movement, not safety/);
  assert.doesNotMatch(html, /Private provider diagnostic|internal diagnostic/);
});
