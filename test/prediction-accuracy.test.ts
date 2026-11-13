import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSymbolFromReportUrl,
  getLatestTradingBhav,
  evaluatePreviousRun,
} from '../src/prediction-accuracy.js';
import { BhavStore, MissingBhavcopy, type Equity } from '../src/bhav.js';
import { MarketInsight, MilvusService } from '../src/milvus.js';

test('extractSymbolFromReportUrl correctly extracts symbol from report_url', () => {
  assert.equal(
    extractSymbolFromReportUrl('https://reports.example.com/stock-reports/run-1/gainers/TCS.html'),
    'TCS',
  );
  assert.equal(
    extractSymbolFromReportUrl('https://reports.example.com/gainers/M%26M.html'),
    'M&M',
  );
  assert.equal(
    extractSymbolFromReportUrl('https://reports.example.com/stock-reports/run-2/gainers/RELIANCE.html?token=123#ref'),
    'RELIANCE',
  );
  assert.equal(extractSymbolFromReportUrl(null), null);
  assert.equal(extractSymbolFromReportUrl(''), null);
  assert.equal(extractSymbolFromReportUrl('invalid-url-without-html'), null);
});

test('getLatestTradingBhav looks back over holidays/weekends until a trading day is found', async () => {
  const store = new BhavStore('./mock');
  const mockEquities: Equity[] = [{
    symbol: 'TCS', isin: 'INE467B01029', name: 'Tata Consultancy Services',
    date: '2026-11-06', close: 4000, high: 4050, low: 3950, volume: 1000, turnover: 4000000,
  }];

  store.load = async (date: string) => {
    if (date === '2026-11-08' || date === '2026-11-07') {
      throw new MissingBhavcopy(`No NSE bhavcopy for ${date}`);
    }
    if (date === '2026-11-06') {
      return mockEquities;
    }
    throw new MissingBhavcopy(`No NSE bhavcopy for ${date}`);
  };

  const result = await getLatestTradingBhav(store, '2026-11-08');
  assert.equal(result.date, '2026-11-06');
  assert.deepEqual(result.equities, mockEquities);
});

test('evaluatePreviousRun evaluates accuracy, handles high/low criteria, skips unsure, and updates Milvus', async () => {
  const previousRunTimestamp = '2026-11-10T12:00:00.000Z';
  const currentRunDate = '2026-11-11';

  // Mock Supabase rows for previous run
  const pastGainers = [
    {
      name: 'Alpha Ltd',
      price: 100, // prev close
      profit_probability: 'high',
      report_url: 'https://reports.example.com/gainers/ALPHA.html',
      updated_at: previousRunTimestamp,
    },
    {
      name: 'Beta Ltd',
      price: 200, // prev close
      profit_probability: 'medium',
      report_url: 'https://reports.example.com/gainers/BETA.html',
      updated_at: previousRunTimestamp,
    },
    {
      name: 'Gamma Ltd',
      price: 300, // prev close
      profit_probability: 'low',
      report_url: 'https://reports.example.com/gainers/GAMMA.html',
      updated_at: previousRunTimestamp,
    },
    {
      name: 'Delta Ltd',
      price: 400, // prev close
      profit_probability: 'unsure', // Should be skipped
      report_url: 'https://reports.example.com/gainers/DELTA.html',
      updated_at: previousRunTimestamp,
    },
  ];

  // Current day equities:
  // ALPHA: high 103 (3% gain >= 2% threshold) -> correct for 'high'
  // BETA: high 201 (0.5% gain < 2% threshold) -> incorrect for 'medium'
  // GAMMA: high 290 (<= 300 prev close) -> correct for 'low'
  const currentEquities: Equity[] = [
    { symbol: 'ALPHA', isin: 'INE001A01001', name: 'Alpha Ltd', date: currentRunDate, close: 102, high: 103, low: 99, volume: 100, turnover: 10000 },
    { symbol: 'BETA', isin: 'INE002B01001', name: 'Beta Ltd', date: currentRunDate, close: 198, high: 201, low: 195, volume: 100, turnover: 20000 },
    { symbol: 'GAMMA', isin: 'INE003C01001', name: 'Gamma Ltd', date: currentRunDate, close: 285, high: 290, low: 280, volume: 100, turnover: 30000 },
  ];

  const fortifiedList: any[] = [];
  const insertedList: any[] = [];

  const mockMilvus: any = {
    searchInsight: async (vec: number[], topK: number, threshold: number) => {
      // Return a match for ALPHA to test fortification
      return {
        id: 42,
        text: 'Winning large defense orders triggers positive momentum',
        category: 'Order Win',
        fortification_count: 2,
        last_observed_date: '2026-11-05',
        example_stocks: 'PREV',
        score: 0.90,
      } as MarketInsight;
    },
    fortifyInsight: async (insight: MarketInsight, symbol: string, date: string, refinedText: string) => {
      fortifiedList.push({ id: insight.id, symbol, date, refinedText });
    },
    insertInsight: async (vector: number[], text: string, category: string, date: string, symbol: string) => {
      insertedList.push({ text, category, date, symbol });
    },
  };

  const mockEmbeddings = {
    embedQuery: async (_text: string) => Array(2048).fill(0.1),
  };

  const mockExa = async (_query: string) => [
    { title: 'Alpha bags major contract', url: 'https://news.example/alpha', text: 'Alpha Ltd secured a multi-year deal worth 500 Cr.' },
  ];

  const mockLlm = async (_input: { prompt: string }) => JSON.stringify({
    observation: 'Securing multi-year government or defense contracts creates sustained momentum',
    category: 'Order Win',
  });

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    // Querying latest date
    if (url.searchParams.get('select') === 'updated_at') {
      return Response.json([{ updated_at: previousRunTimestamp }]);
    }
    // Querying rows for that date
    if (url.pathname.includes('top_gainers')) {
      return Response.json(pastGainers);
    }
    if (url.pathname.includes('top_losers')) {
      return Response.json([]);
    }
    return Response.json([]);
  };

  const summary = await evaluatePreviousRun({
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'test-key',
    bhavStore: new BhavStore('./mock'),
    currentDate: currentRunDate,
    currentEquities,
    currentRunStartedAt: '2026-11-11T10:00:00.000Z',
    thresholdPct: 2.0,
    similarityThreshold: 0.82,
    milvusService: mockMilvus,
    embeddings: mockEmbeddings,
    exaSearch: mockExa,
    textLlm: mockLlm,
    request: mockFetch,
  });

  // DELTA was skipped (unsure), ALPHA, BETA, GAMMA evaluated:
  assert.equal(summary.evaluatedCount, 3);
  // ALPHA (3% >= 2%) -> correct
  // BETA (0.5% < 2%) -> incorrect
  // GAMMA (high 290 <= 300) -> correct
  assert.equal(summary.correctCount, 2);

  const alphaResult = summary.results.find(r => r.symbol === 'ALPHA')!;
  assert.equal(alphaResult.isCorrect, true);
  assert.equal(alphaResult.gainPct, 3);

  const betaResult = summary.results.find(r => r.symbol === 'BETA')!;
  assert.equal(betaResult.isCorrect, false);
  assert.equal(betaResult.gainPct, 0.5);

  const gammaResult = summary.results.find(r => r.symbol === 'GAMMA')!;
  assert.equal(gammaResult.isCorrect, true);

  // Milvus was called and fortified
  assert.ok(fortifiedList.length >= 1);
  assert.equal(fortifiedList[0].id, 42);
});

