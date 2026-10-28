import { zipSync, strToU8 } from 'fflate';
import type { Candidate, Equity } from '../src/bhav.js';
import type { Assessment, ResearchResult } from '../src/research.js';

export function equity(overrides: Partial<Equity> = {}): Equity {
  return {
    symbol: 'EXAMPLE', isin: 'INE000A01001', name: 'Example Limited', date: '2026-10-26',
    close: 500, high: 520, low: 480, volume: 100_000, turnover: 50_000_000, ...overrides,
  };
}

export function csv(date: string, rows = [equity({ date })]): string {
  return 'TradDt,FinInstrmTp,ISIN,TckrSymb,SctySrs,FinInstrmNm,ClsPric,HghPric,LwPric,TtlTradgVol,TtlTrfVal\n' +
    rows.map(row => [date, 'STK', row.isin, row.symbol, 'EQ', row.name, row.close,
      row.high, row.low, row.volume, row.turnover].join(',')).join('\n');
}

export function zipResponse(text: string): Response {
  return new Response(Buffer.from(zipSync({ 'bhav.csv': strToU8(text) })), { status: 200 });
}

export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    symbol: 'EXAMPLE', isin: 'INE000A01001', name: 'Example Limited',
    group: 'gainers', threshold: 100, minPrice: 200, maxPrice: 2000, price: 500, change: 120, changePercent: 30,
    asOfDate: '2026-10-26', baselineDate: '2026-09-25',
    averageVolume: 100_000, averageTurnover: 50_000_000,
    volumeRatio: 1.5, volatility: 0.2, observations: 21, ...overrides,
  };
}

export function research(symbol = 'EXAMPLE', overrides: Partial<Assessment> = {}): ResearchResult {
  const now = new Date().toISOString();
  const url = 'https://www.nseindia.com/example';
  const otherUrl = 'https://www.example.org/financials';
  const excerpt = `Price 500 as of ${now} PE 20 cap 10000 debt 0.5 growth 12; no corporate actions; current sector conditions.`;
  const source = { url, excerpt };
  return {
    assessment: {
      symbol, profitProbability: 'high', classificationReason: 'Corroborated fundamentals and current catalysts support upside over the next trading week.',
      dataGapReason: null, outlookHorizon: 'next_trading_week', fundamentalRisk: 20, recoveryScore: 80,
      livePrice: { value: 500, source }, quoteAsOf: now,
      pe: { value: 20, source }, sectorPe: null,
      marketCapCrore: { value: 10000, source }, debtToEquity: { value: 0.5, source },
      earningsGrowthPercent: { value: 12, source }, financialPeriod: 'Q2 FY2026-27',
      corporateActionsClear: true, corporateActionEvidence: source,
      reasons: ['Positive profitability and reasonable valuation relative to peers.'],
      risks: ['Market volatility and earnings disappointment remain possible.'],
      recoveryCatalysts: ['Earnings improvement could support a recovery.'],
      marketContext: 'Current sector conditions are stable with ongoing market volatility.',
      marketEvidence: { url: otherUrl, excerpt },
      sources: [source, { url: otherUrl, excerpt }],
      ...overrides,
    },
    reads: [{ url, output: excerpt, observedAt: now }, { url: otherUrl, output: excerpt, observedAt: now }],
    researchedAt: now,
  };
}
