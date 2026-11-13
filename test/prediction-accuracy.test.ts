import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'pred-acc-'));
  try {
    const previousRunTimestamp = '2026-10-10T12:00:00.000Z';
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
      bhavStore: new BhavStore(root),
      dataDir: root,
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluatePreviousRun performs 30-day positional retrospective evaluation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pred-pos-'));
  try {
    const previousRunTimestamp = '2026-11-14T12:00:00.000Z';
    const positionalRunTimestamp = '2026-10-15T12:00:00.000Z'; // 30 days prior
    const currentRunDate = '2026-11-15';

    const shortTermGainers = [
      {
        name: 'Alpha Ltd',
        price: 100,
        profit_probability: 'high',
        report_url: 'https://reports.example.com/gainers/ALPHA.html',
        updated_at: previousRunTimestamp,
      },
    ];

    const positionalGainers = [
      {
        name: 'Krishna Defence Ltd',
        price: 500, // prev close 30 days ago
        profit_probability: 'high',
        report_url: 'https://reports.example.com/gainers/KRISHNA.html',
        updated_at: positionalRunTimestamp,
      },
      {
        name: 'Omni Speculative Ltd',
        price: 200, // prev close 30 days ago
        profit_probability: 'high',
        report_url: 'https://reports.example.com/gainers/OMNI.html',
        updated_at: positionalRunTimestamp,
      },
    ];

    // Current equities:
    // ALPHA: high 104 (+4% >= 2%) -> short-term correct
    // KRISHNA: high 620 (+120 INR, +24% >= 5% or +100 INR) -> positional correct
    // OMNI: high 180 (-10% < 5% and < 100 INR) -> positional incorrect (operator drop)
    const currentEquities: Equity[] = [
      { symbol: 'ALPHA', isin: 'INE001A01001', name: 'Alpha Ltd', date: currentRunDate, close: 103, high: 104, low: 99, volume: 1000, turnover: 100000 },
      { symbol: 'KRISHNA', isin: 'INE004K01001', name: 'Krishna Defence Ltd', date: currentRunDate, close: 610, high: 620, low: 590, volume: 50000, turnover: 30000000 },
      { symbol: 'OMNI', isin: 'INE005O01001', name: 'Omni Speculative Ltd', date: currentRunDate, close: 175, high: 180, low: 170, volume: 500, turnover: 90000 },
    ];

    const positionalInsights: any[] = [];
    const mockMilvus: any = {
      searchInsight: async () => null,
      fortifyInsight: async () => {},
      insertInsight: async (_vec: number[], text: string, category: string, date: string, symbol: string) => {
        positionalInsights.push({ text, category, date, symbol });
      },
    };

    const mockEmbeddings = {
      embedQuery: async () => Array(2048).fill(0.1),
    };

    const mockExa = async () => [];

    const mockLlm = async (input: { prompt: string }) => {
      if (input.prompt.includes('30-day')) {
        return JSON.stringify({
          observation: 'High institutional liquidity and defense sector tailwinds drive sustained 30-day positional momentum.',
          category: 'Brand & Institutional Liquidity',
        });
      }
      return JSON.stringify({
        observation: 'Order win creates short term momentum for capital goods.',
        category: 'Order Win',
      });
    };

    const mockFetch: typeof fetch = async input => {
      const url = new URL(String(input));
      const select = url.searchParams.get('select');
      if (select === 'updated_at') {
        // If query has gte / lte range looking for 30 days ago:
        const gte = url.searchParams.get('updated_at.gte') || url.searchParams.get('gte');
        if (url.search.includes('gte') || url.search.includes('lte')) {
          return Response.json([{ updated_at: positionalRunTimestamp }]);
        }
        return Response.json([{ updated_at: previousRunTimestamp }]);
      }
      if (url.pathname.includes('top_gainers')) {
        if (url.search.includes(encodeURIComponent(positionalRunTimestamp)) || url.search.includes(positionalRunTimestamp)) {
          return Response.json(positionalGainers);
        }
        return Response.json(shortTermGainers);
      }
      return Response.json([]);
    };

    const summary = await evaluatePreviousRun({
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      bhavStore: new BhavStore(root),
      dataDir: root,
      currentDate: currentRunDate,
      currentEquities,
      currentRunStartedAt: '2026-11-15T10:00:00.000Z',
      thresholdPct: 2.0,
      similarityThreshold: 0.82,
      milvusService: mockMilvus,
      embeddings: mockEmbeddings,
      exaSearch: mockExa,
      textLlm: mockLlm,
      request: mockFetch,
      positionalLookbackDays: 30,
      positionalThresholdPct: 5.0,
      positionalMinRupeesGain: 100,
    });

    // Short term evaluation
    assert.equal(summary.evaluatedCount, 1);
    assert.equal(summary.correctCount, 1);

    // Positional evaluation (~30 days)
    assert.ok(summary.positionalSummary);
    assert.equal(summary.positionalSummary.evaluatedCount, 2);
    assert.equal(summary.positionalSummary.correctCount, 1);

    const krishnaResult = summary.positionalSummary.results.find(r => r.symbol === 'KRISHNA')!;
    assert.equal(krishnaResult.isCorrect, true);
    assert.equal(krishnaResult.horizon, 'positional_30d');
    assert.ok(krishnaResult.gainPct > 20);

    const omniResult = summary.positionalSummary.results.find(r => r.symbol === 'OMNI')!;
    assert.equal(omniResult.isCorrect, false);
    assert.equal(omniResult.horizon, 'positional_30d');
    assert.ok(omniResult.gainPct < 0);

    // Check that Milvus received positional insights
    const krishnaInsight = positionalInsights.find(i => i.symbol === 'KRISHNA');
    assert.ok(krishnaInsight);
    assert.equal(krishnaInsight.category, 'Brand & Institutional Liquidity');

    // Second evaluation within 5 days (< 30 days) should NOT re-evaluate with Exa or insert duplicate insights
    const initialInsightsCount = positionalInsights.length;
    await evaluatePreviousRun({
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      bhavStore: new BhavStore(root),
      dataDir: root,
      currentDate: '2026-11-20',
      currentEquities,
      currentRunStartedAt: '2026-11-20T10:00:00.000Z',
      thresholdPct: 2.0,
      similarityThreshold: 0.82,
      milvusService: mockMilvus,
      embeddings: mockEmbeddings,
      exaSearch: mockExa,
      textLlm: mockLlm,
      request: mockFetch,
      positionalLookbackDays: 30,
      positionalThresholdPct: 5.0,
      positionalMinRupeesGain: 100,
    });

    assert.equal(positionalInsights.length, initialInsightsCount, 'Should not re-evaluate or insert duplicate insight within 30 days');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluatePreviousRun records short-term price movement facts in Milvus directly from data files without Exa', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pred-short-'));
  try {
    const previousRunTimestamp = '2026-11-06T12:00:00.000Z'; // 5 days ago (< 28 days)
    const currentRunDate = '2026-11-11';

    const pastGainers = [
      {
        name: 'Quick Gain Ltd',
        price: 100,
        profit_probability: 'high',
        report_url: 'https://reports.example.com/gainers/QUICK.html',
        updated_at: previousRunTimestamp,
      },
      {
        name: 'Failed Breakout Ltd',
        price: 200,
        profit_probability: 'high',
        report_url: 'https://reports.example.com/gainers/FAIL.html',
        updated_at: previousRunTimestamp,
      },
    ];

    const currentEquities: Equity[] = [
      { symbol: 'QUICK', isin: 'INE001Q01001', name: 'Quick Gain Ltd', date: currentRunDate, close: 104, high: 106, low: 99, volume: 100, turnover: 450_000_000 },
      { symbol: 'FAIL', isin: 'INE002F01001', name: 'Failed Breakout Ltd', date: currentRunDate, close: 194, high: 196, low: 190, volume: 100, turnover: 120_000_000 },
    ];

    let exaCallCount = 0;
    let llmCallCount = 0;
    const insertedMilvus: any[] = [];

    const mockMilvus: any = {
      searchInsight: async () => null,
      insertInsight: async (vector: number[], text: string, category: string, date: string, symbol: string) => {
        insertedMilvus.push({ symbol, text, category, date });
      },
      fortifyInsight: async () => {},
    };

    const mockFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get('select') === 'updated_at') {
        return Response.json([{ updated_at: previousRunTimestamp }]);
      }
      if (url.pathname.includes('top_gainers')) {
        return Response.json(pastGainers);
      }
      return Response.json([]);
    };

    const summary = await evaluatePreviousRun({
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'test-key',
      bhavStore: new BhavStore(root),
      dataDir: root,
      currentDate: currentRunDate,
      currentEquities,
      currentRunStartedAt: '2026-11-11T10:00:00.000Z',
      thresholdPct: 2.0,
      similarityThreshold: 0.82,
      milvusService: mockMilvus,
      embeddings: { embedQuery: async () => Array(2048).fill(0.1) } as any,
      exaSearch: async () => { exaCallCount++; return []; },
      textLlm: async () => { llmCallCount++; return '{}'; },
      request: mockFetch,
      enablePositionalEvaluation: false,
    });

    assert.equal(summary.evaluatedCount, 2);
    assert.equal(summary.correctCount, 1); // QUICK is correct (6% >= 2%), FAIL is incorrect (-2% < 2%)
    assert.equal(exaCallCount, 0, 'Short-term price fact evaluation must not call Exa');
    assert.equal(llmCallCount, 0, 'Short-term price fact evaluation must not call LLM');

    assert.equal(insertedMilvus.length, 2);
    const quickFact = insertedMilvus.find(m => m.symbol === 'QUICK')!;
    assert.ok(quickFact);
    assert.equal(quickFact.category, 'Short-Term Price Movement Fact');
    assert.match(quickFact.text, /Achieved short-term profit accuracy/);
    assert.match(quickFact.text, /INR 45\.00 Cr/); // Turnover from bhavcopy data

    const failFact = insertedMilvus.find(m => m.symbol === 'FAIL')!;
    assert.ok(failFact);
    assert.equal(failFact.category, 'Short-Term Price Movement Fact');
    assert.match(failFact.text, /Missed short-term profit target/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

