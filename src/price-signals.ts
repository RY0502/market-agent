import type { Equity } from './bhav.js';

export interface PriceSpike {
  fromDate: string;
  date: string;
  changePercent: number;
  observationsSince: number;
  volumeRatioToPrior: number | null;
  moveSincePercent: number;
  spikeGainRetainedPercent: number;
  subsequentVolumeRatioToPrior: number | null;
}

export interface PriceSignals {
  startDate: string;
  endDate: string;
  observations: number;
  missingStockObservations: number;
  missingArchiveDates: string[];
  closeChangePercent: number;
  positiveIntervals: number;
  largestRiseShareOfPositiveMovesPercent: number | null;
  maximumDrawdownPercent: number;
  pullbackFromPeakPercent: number;
  firstSpike: PriceSpike | null;
  latestSpike: PriceSpike | null;
}

/** Unadjusted observations, not confirmed consecutive trading sessions or causal signals. */
export function calculatePriceSignals(
  rows: Equity[], expectedObservations = rows.length, missingArchiveDates: string[] = [],
): PriceSignals {
  const samples = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  if (samples.length < 2 || !Number.isSafeInteger(expectedObservations) || expectedObservations < samples.length ||
    new Set(samples.map(row => row.date)).size !== samples.length ||
    samples.some(row => row.isin !== samples[0]!.isin || !Number.isFinite(row.close) || row.close <= 0 ||
      !Number.isFinite(row.volume) || row.volume < 0)) throw new Error('Invalid price-signal observations');
  const first = samples[0]!;
  const last = samples.at(-1)!;
  let peak = first.close;
  let maximumDrawdownPercent = 0;
  const rises: number[] = [];
  const spikes: PriceSpike[] = [];
  for (let index = 1; index < samples.length; index++) {
    const row = samples[index]!;
    const previous = samples[index - 1]!;
    const rise = row.close - previous.close;
    if (rise > 0) rises.push(rise);
    peak = Math.max(peak, row.close);
    maximumDrawdownPercent = Math.max(maximumDrawdownPercent, (peak - row.close) / peak * 100);
    if (rise / previous.close < 0.05) continue;
    const prior = samples.slice(0, index);
    const priorVolume = prior.reduce((sum, item) => sum + item.volume, 0) / prior.length;
    const subsequent = samples.slice(index + 1);
    spikes.push({
      fromDate: previous.date, date: row.date, changePercent: rise / previous.close * 100,
      observationsSince: samples.length - index - 1,
      volumeRatioToPrior: priorVolume > 0 ? row.volume / priorVolume : null,
      moveSincePercent: (last.close - row.close) / row.close * 100,
      spikeGainRetainedPercent: (last.close - previous.close) / rise * 100,
      subsequentVolumeRatioToPrior: subsequent.length && priorVolume > 0
        ? subsequent.reduce((sum, item) => sum + item.volume, 0) / subsequent.length / priorVolume : null,
    });
  }
  const totalRise = rises.reduce((sum, rise) => sum + rise, 0);
  return {
    startDate: first.date, endDate: last.date, observations: samples.length,
    missingStockObservations: expectedObservations - samples.length,
    missingArchiveDates: [...new Set(missingArchiveDates)].filter(date => date >= first.date && date <= last.date).sort(),
    closeChangePercent: (last.close - first.close) / first.close * 100,
    positiveIntervals: rises.length,
    largestRiseShareOfPositiveMovesPercent: totalRise > 0 ? Math.max(...rises) / totalRise * 100 : null,
    maximumDrawdownPercent,
    pullbackFromPeakPercent: (peak - last.close) / peak * 100,
    firstSpike: spikes[0] ?? null, latestSpike: spikes.at(-1) ?? null,
  };
}
