import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePriceSignals } from '../src/price-signals.js';
import { screen } from '../src/bhav.js';
import { equity } from './helpers.js';
import { NSE_RESEARCH_POLICY } from '../src/research-policy.js';

const approximately = (actual: number | null | undefined, expected: number) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

test('signals compute spike timing, preceding volume, retention, concentration and chronological drawdown', () => {
  const rows = [100, 106, 108, 102, 108, 112].map((close, i) => equity({
    close, date: `2026-10-${String(20 + i).padStart(2, '0')}`,
    volume: [100, 300, 150, 80, 200, 100][i]!,
  }));
  const signals = calculatePriceSignals([...rows].reverse(), 7, ['2026-10-19', '2026-10-22', '2026-10-22', '2026-10-28']);
  assert.equal(signals.observations, 6);
  assert.equal(signals.missingStockObservations, 1);
  assert.deepEqual(signals.missingArchiveDates, ['2026-10-22']);
  assert.equal(signals.firstSpike?.date, '2026-10-21');
  assert.equal(signals.firstSpike?.fromDate, '2026-10-20');
  assert.equal(signals.firstSpike?.observationsSince, 4);
  approximately(signals.firstSpike?.volumeRatioToPrior, 3);
  approximately(signals.firstSpike?.subsequentVolumeRatioToPrior, 1.325);
  assert.equal(signals.latestSpike?.date, '2026-10-24');
  assert.equal(signals.latestSpike?.observationsSince, 1);
  approximately(signals.latestSpike?.volumeRatioToPrior, 200 / 157.5);
  approximately(signals.latestSpike?.spikeGainRetainedPercent, 1000 / 6);
  approximately(signals.latestSpike?.moveSincePercent, 400 / 108);
  approximately(signals.closeChangePercent, 12);
  approximately(signals.maximumDrawdownPercent, 600 / 108);
  assert.equal(signals.pullbackFromPeakPercent, 0);
  assert.equal(signals.positiveIntervals, 4);
  approximately(signals.largestRiseShareOfPositiveMovesPercent, 100 / 3);
});

test('flat/declining history and a latest-observation spike preserve unknowns instead of fabricated confirmation', () => {
  const rows = [100, 95, 90].map((close, i) => equity({ close, date: `2026-10-${20 + i}`, volume: 0 }));
  const signals = calculatePriceSignals(rows);
  assert.equal(signals.firstSpike, null);
  assert.equal(signals.latestSpike, null);
  assert.equal(signals.largestRiseShareOfPositiveMovesPercent, null);
  assert.equal(signals.maximumDrawdownPercent, 10);
  assert.equal(signals.pullbackFromPeakPercent, 10);
  const spike = calculatePriceSignals([rows[0]!, { ...rows[2]!, close: 105 }]).latestSpike!;
  assert.equal(spike.changePercent, 5);
  assert.equal(spike.volumeRatioToPrior, null);
  assert.equal(spike.subsequentVolumeRatioToPrior, null);
  assert.equal(spike.observationsSince, 0);
  assert.equal(spike.spikeGainRetainedPercent, 100);
});

test('screen supplies fresh signals before research and preserves endpoint high-to-high screening', () => {
  const base = equity({ date: '2026-10-20', close: 400, high: 420 });
  const current = equity({ date: '2026-10-26', close: 440, high: 470 });
  const result = screen({
    current: [current], days: [[base], [], [current]], baseline: base.date,
    missingDates: ['2026-10-22'],
  })[0]!;
  assert.equal(result.change, 50);
  assert.equal(result.priceSignals?.closeChangePercent, 10);
  assert.equal(result.priceSignals?.missingStockObservations, 1);
  assert.deepEqual(result.priceSignals?.missingArchiveDates, ['2026-10-22']);
  assert.equal(result.priceSignals?.firstSpike?.fromDate, base.date);
  assert.equal(result.priceSignals?.firstSpike?.date, current.date);
  assert.match(NSE_RESEARCH_POLICY, /candidate\.priceSignals/);
  assert.match(NSE_RESEARCH_POLICY, /not causal proof or forecasts/);
});

test('invalid, duplicate or mixed-identity signal observations fail explicitly', () => {
  const rows = [equity({ date: '2026-10-20' }), equity()];
  for (const invalid of [
    [], [rows[0]!], [rows[0]!, rows[0]!],
    [rows[0]!, { ...rows[1]!, isin: 'INE000B01001' }],
    [rows[0]!, { ...rows[1]!, close: NaN }],
    [rows[0]!, { ...rows[1]!, close: 0 }],
    [rows[0]!, { ...rows[1]!, volume: -1 }],
  ]) assert.throws(() => calculatePriceSignals(invalid), /Invalid price-signal/);
  assert.throws(() => calculatePriceSignals(rows, 1), /Invalid price-signal/);
});
