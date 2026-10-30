import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricOccursInText, normalizeMetricText } from '../src/financial-metrics.js';
import { normalizeSubmissionArguments } from '../src/schema-diagnostics.js';
import { submissionExamples, submissionSchema } from '../src/research.js';

test('explicit currency, amount units, ratio suffixes and percent signs normalize without guessed units', () => {
  for (const [field, text, expected] of [
    ['livePrice', 'Rs. 532.25', 532.25],
    ['livePrice', 'INR 1,532.25', 1532.25],
    ['pe', '28.21x', 28.21],
    ['sectorPe', '18 x', 18],
    ['debtToEquity', '0.48x', 0.48],
    ['earningsGrowthPercent', '-12.5%', -12.5],
    ['marketCapCrore', '1,000 crore', 1000],
    ['marketCapCrore', '1,32,928.50 crore', 132928.5],
    ['marketCapCrore', 'INR 100000000000', 10000],
    ['marketCapCrore', '2 billion', 200],
    ['marketCapCrore', '1 T', 100000],
    ['marketCapCrore', '5 million', 0.5],
    ['marketCapCrore', '50 lakh', 0.5],
    ['marketCapCrore', 'INR 42 cr', 42],
    ['marketCapCrore', '132928258048', 132928258048],
  ] as const) {
    assert.equal(normalizeMetricText(field, text), expected, `${field}: ${text}`);
    const { args, conversions } = normalizeSubmissionArguments({
      ...submissionExamples.unclassified, [field]: text,
    }, submissionSchema);
    assert.equal(submissionSchema.parse(args)[field], expected);
    assert.equal(conversions.length, 1);
  }
});

test('ambiguous units, invalid grouping, impossible values and unsupported formats are not coerced', () => {
  for (const [field, text] of [
    ['pe', 'about 20'], ['pe', 'INR 20'], ['pe', '12%'], ['livePrice', '20x'],
    ['marketCapCrore', '20 USD'], ['marketCapCrore', '1,2 crore'],
    ['marketCapCrore', '1e3'], ['marketCapCrore', 'Infinity'],
    ['marketCapCrore', '9007199254740993'],
    ['marketCapCrore', '0.' + '0'.repeat(400) + '1'],
  ]) assert.equal(normalizeMetricText(field!, text!), undefined, text);
});

test('numeric corroboration recognizes explicit crore conversions but does not guess the units of bare amounts', () => {
  assert.equal(metricOccursInText('marketCapCrore', 200, 'Market cap INR 2 billion.'), true);
  assert.equal(metricOccursInText('marketCapCrore', 2036, 'Market capitalization 20.36 B INR.'), true);
  assert.equal(metricOccursInText('marketCapCrore', 100000, 'Market capitalization 1 T INR.'), true);
  assert.equal(metricOccursInText('marketCapCrore', 200, 'Market cap Rs 2,000,000,000.'), true);
  assert.equal(metricOccursInText('marketCapCrore', 200, 'Market cap 200 crore.'), true);
  assert.equal(metricOccursInText('marketCapCrore', 200, 'Market cap 2000000000.'), false);
  assert.equal(metricOccursInText('marketCapCrore', 132928258048, 'Market cap 13,292.82 crore.'), false);
  assert.equal(metricOccursInText('earningsGrowthPercent', 12.5, 'Earnings growth 12.5%.'), true);
  assert.equal(metricOccursInText('pe', 28.21, 'P/E is 28.21x.'), true);
});
