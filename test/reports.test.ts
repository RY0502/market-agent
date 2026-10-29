import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReporter, reportLocation, verifyReportHosting,
} from '../src/report-storage.js';
import { renderStockReport, reportReasoning } from '../src/reports.js';
import { candidate, research } from './helpers.js';
import type { RankedStock } from '../src/research.js';
import { unsureResearch } from '../src/research.js';

const config = {
  CLOUDFLARE_REPORT_UPLOAD_TOKEN: 'test-token-'.repeat(4),
  CLOUDFLARE_REPORT_URL: 'https://reports.example.org',
};
const runId = '12345678-1234-1234-1234-123456789abc';
const stock = (): RankedStock => ({ candidate: candidate(), research: research(), rank: 1, riskScore: 20, recoveryScore: 80 });
const render = (item: RankedStock, prices = [{ date: '2026-10-26', close: 500 }], count = 5) =>
  renderStockReport(item, runId, prices, count, '2026-10-28T12:00:00Z', '2026-11-02T12:00:00Z');

test('reports retain business reasoning and cache provenance, not technical diagnostics or invalid metrics', () => {
  const item = stock();
  item.research.cache = { hit: true, backgroundResearchedAt: '2026-10-20T12:00:00Z' };
  item.research.assessment.warnings = [
    { field: 'marketCapCrore', code: 'numeric_evidence_mismatch', message: 'Market cap did not match the cited text.' },
    { field: 'evidenceIds.debtToEquity', code: 'invalid_submission_field', message: 'evidenceIds.debtToEquity: unusable model field (too_small); retained usable fields without requesting resubmission.' },
  ];
  item.research.assessment.risks.push(
    ...item.research.assessment.warnings.map(warning => warning.message),
    'Background research from 2026-10-20T12:00:00Z is reused; later news, sector changes and corporate actions may not be reflected.',
    'High capital requirements increase the risk of dilution.',
  );
  item.research.assessment.earningsGrowthPercent!.source = null;
  const clean = reportReasoning(item);
  assert.deepEqual(clean.metrics.map(metric => metric.label), ['P/E']);
  const html = render(item);
  assert.match(html, /High capital requirements increase the risk of dilution/);
  assert.match(html, /Market volatility and earnings disappointment/);
  assert.match(html, /Cached background/);
  assert.match(html, /2026-10-20T12:00:00Z/);
  assert.doesNotMatch(html, /too_small|unusable model|evidenceIds|did not match the cited text|Background research from/);
  assert.equal(item.research.assessment.warnings.length, 2, 'The audit remains intact');
  assert.equal(item.research.assessment.risks.length, 5);
  assert.ok(Buffer.byteLength(html) < 64_000);
});

test('responsive script-free HTML escapes all narrative content, preserves Unsure and handles single/flat series', () => {
  const item = stock();
  item.candidate.name = '<img src=x onerror=alert(1)>';
  item.research.assessment.classificationReason = '<script>alert("unsafe")</script>';
  item.research.assessment.profitProbability = null;
  for (const points of [
    [{ date: '2026-10-26', close: 500 }],
    [{ date: '2026-10-23', close: 500 }, { date: '2026-10-26', close: 500 }],
  ]) {
    const html = render(item, points);
    assert.match(html, /name="viewport"/);
    assert.match(html, /viewBox="0 0 400 235"/);
    assert.match(html, />Unsure</);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script|<img|NaN|Infinity|<link /);
    assert.match(html, /earlier observations were unavailable/);
  }
  assert.match(render(item, [], 2), /No daily closing-price observations/);
  assert.throws(() => render(item, [{ date: '2026-10-26', close: NaN }]), /Invalid report price/);
  assert.throws(() => render(item, [{ date: '2026-10-27', close: 500 }]), /chart dates/);
  assert.throws(() => render(item, [], 6), /chart length/);
});

test('report keys distinguish run, group and encoded NSE symbols and reject unsafe identities/origins', () => {
  const location = reportLocation(config, runId, 'gainers', 'M&M');
  assert.equal(location.key, `stock-reports/${runId}/gainers/M&M.html`);
  assert.equal(location.url, `https://reports.example.org/stock-reports/${runId}/gainers/M%26M.html`);
  assert.notEqual(location.url, reportLocation(config, runId, 'losers', 'M&M').url);
  for (const symbol of ['../stock', '..', 'stock\n', '/absolute']) {
    assert.throws(() => reportLocation(config, runId, 'gainers', symbol), /Unsafe/);
  }
  for (const url of ['http://reports.example.org', 'https://reports.example.org/path', 'https://user:pass@reports.example.org']) {
    assert.throws(() => reportLocation({ ...config, CLOUDFLARE_REPORT_URL: url }, runId, 'gainers', 'M&M'), /HTTPS origin/);
  }
});

test('failed cached refreshes retain cache status without publishing raw provider errors or placeholder context', () => {
  const item = stock();
  item.research = unsureResearch(item.candidate, new Error('Internal provider response must remain in the audit'));
  item.research.cache = { hit: true, backgroundResearchedAt: '2026-10-20T12:00:00Z' };
  const html = render(item);
  assert.match(html, /Cached background found; research refresh unavailable/);
  assert.match(html, /No investment outlook was produced/);
  assert.match(html, />Unsure</);
  assert.doesNotMatch(html, /Internal provider response|could not be independently verified|unusable|evidenceIds/);
});

test('Worker verification and upload validate responses and propagate failures without fake URLs', async () => {
  let requests = 0;
  const denied: typeof fetch = async () => {
    requests++;
    return new Response('Denied', { status: 403 });
  };
  await assert.rejects(verifyReportHosting(config, denied), /HTTP 403/);
  await assert.rejects(createReporter(config, denied)(stock(), runId, [], 5), /HTTP 403/);
  assert.equal(requests, 2);
  await assert.rejects(verifyReportHosting(config, async () => Response.json({ retentionDays: 30 })));
  await assert.rejects(createReporter(config, async () => Response.json({ path: 'wrong', expiresAt: 'wrong' }))(stock(), runId, [], 5));
});
