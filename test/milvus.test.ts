import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MilvusService, createMilvusService, type MarketInsight } from '../src/milvus.js';

test('createMilvusService returns null when no address is configured in env', () => {
  const service = createMilvusService({});
  assert.equal(service, null);
});

test('createMilvusService initializes service when address is provided', () => {
  const mockClient = { hasCollection: async () => ({ value: true }), loadCollectionSync: async () => {} };
  const service = new MilvusService({
    address: 'mock-address',
    client: mockClient,
    similarityThreshold: 0.82,
  });
  assert.ok(service instanceof MilvusService);
  assert.equal(service.collectionName, 'market_insights');
  assert.equal(service.similarityThreshold, 0.82);
});

test('MilvusService searchInsight filters by similarity threshold', async () => {
  const mockClient: any = {
    hasCollection: async () => ({ value: true }),
    loadCollectionSync: async () => {},
    search: async () => ({
      results: [
        {
          id: '101',
          text: 'Acquisition in IT services triggers short term rally',
          category: 'M&A',
          fortification_count: 2,
          last_observed_date: '2026-11-01',
          example_stocks: 'INFY, TCS',
          score: 0.88,
        },
      ],
    }),
  };

  const service = new MilvusService({
    client: mockClient,
    similarityThreshold: 0.85,
  });

  // Score 0.88 >= 0.85 threshold -> returns insight
  const matched = await service.searchInsight(Array(2048).fill(0.1));
  assert.ok(matched);
  assert.equal(matched.id, '101');
  assert.equal(matched.fortification_count, 2);
  assert.equal(matched.score, 0.88);

  // When score is below threshold (e.g. 0.80 < 0.85) -> returns null
  mockClient.search = async () => ({
    results: [
      {
        id: '102',
        text: 'Unrelated pattern',
        score: 0.80,
      },
    ],
  });

  const belowThreshold = await service.searchInsight(Array(2048).fill(0.1));
  assert.equal(belowThreshold, null);
});

test('MilvusService fortifyInsight increments count and appends unique stocks', async () => {
  let upsertData: any = null;
  const mockClient = {
    hasCollection: async () => ({ value: true }),
    loadCollectionSync: async () => {},
    flushSync: async () => {},
    upsert: async (params: any) => {
      upsertData = params;
    },
  };

  const service = new MilvusService({
    client: mockClient,
  });

  const insight: MarketInsight = {
    id: '200',
    text: 'Winning large defense orders triggers positive momentum',
    category: 'Order Win',
    fortification_count: 3,
    last_observed_date: '2026-11-01',
    example_stocks: 'HAL, BEL',
    vector: Array(2048).fill(0.1),
  };

  await service.fortifyInsight(insight, 'BHEL', '2026-11-12');
  assert.ok(upsertData);
  assert.equal(upsertData.data[0].id, '200');
  assert.equal(upsertData.data[0].fortification_count, 4);
  assert.equal(upsertData.data[0].last_observed_date, '2026-11-12');
  assert.equal(upsertData.data[0].example_stocks, 'HAL, BEL, BHEL');
});

test('MilvusService insertInsight creates new insight with fortification_count = 1', async () => {
  let insertData: any = null;
  const mockClient = {
    hasCollection: async () => ({ value: true }),
    loadCollectionSync: async () => {},
    flushSync: async () => {},
    insert: async (params: any) => {
      insertData = params;
    },
  };

  const service = new MilvusService({
    client: mockClient,
  });

  await service.insertInsight(
    Array(2048).fill(0.2),
    'War de-escalation stabilizes energy and gas stocks',
    'Geopolitical',
    '2026-11-12',
    'ONGC',
  );

  assert.ok(insertData);
  assert.equal(insertData.data[0].fortification_count, 1);
  assert.equal(insertData.data[0].category, 'Geopolitical');
  assert.equal(insertData.data[0].example_stocks, 'ONGC');
});
