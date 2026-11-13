import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStockReport } from '../src/reports.js';
import { candidate, research, reportReference } from './helpers.js';

test('renderStockReport renders insight badge and insight section when candidate is insight backed', () => {
  const stockWithInsight = {
    candidate: {
      ...candidate(),
      insightFortified: 4,
      insightText: 'Securing multi-year government or defense contracts creates sustained momentum in engineering stocks.',
    },
    research: research(),
    riskScore: 20,
    recoveryScore: 80,
    rank: 1,
    report: reportReference(),
  };

  const html = renderStockReport(
    stockWithInsight,
    'run-1',
    [{ date: '2026-10-26', close: 500, high: 520 }],
    1,
    '2026-10-26T12:00:00.000Z',
    '2026-11-02T12:00:00.000Z',
  );

  assert.match(html, /Insight Backed \(Fortified: 4x\)/);
  assert.match(html, /<h2>Market Insight &amp; Historical Pattern<\/h2>/);
  assert.match(html, /Fortified 4x:/);
  assert.match(html, /Securing multi-year government or defense contracts/);
});

test('renderStockReport omits insight badge and section when candidate has no insight', () => {
  const standardStock = {
    candidate: candidate(),
    research: research(),
    riskScore: 20,
    recoveryScore: 80,
    rank: 1,
    report: reportReference(),
  };

  const html = renderStockReport(
    standardStock,
    'run-1',
    [{ date: '2026-10-26', close: 500, high: 520 }],
    1,
    '2026-10-26T12:00:00.000Z',
    '2026-11-02T12:00:00.000Z',
  );

  assert.doesNotMatch(html, /Insight Backed/);
  assert.doesNotMatch(html, /Market Insight &amp; Historical Pattern/);
});

