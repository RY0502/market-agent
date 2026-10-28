import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPublisher, publicationFile, publicationRow } from '../src/publish.js';
import { initializeStorage } from '../src/storage.js';
import { candidate, research } from './helpers.js';

const stock = () => ({ candidate: candidate(), research: research(), riskScore: 20, recoveryScore: 80, rank: 1 });
const displayKeys = ['change', 'change_percent', 'name', 'price', 'profit_probability', 'updated_at'];

test('publication payload contains only display columns, never reasons or metadata', () => {
  const row = publicationRow(stock(), '2026-10-27T12:00:00Z');
  assert.deepEqual(Object.keys(row).sort(), displayKeys);
  assert.equal(row.profit_probability, 'high');
});

for (const [gainers, losers] of [[99, 99], [100, 99], [99, 100], [101, 126]]) {
  test(`direct publication prunes each table independently (${gainers}/${losers})`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nse-direct-'));
    try {
      await initializeStorage(root);
      const counts: Record<string, number> = { top_gainers: gainers!, top_losers: losers! };
      const deleted: string[] = [];
      const inserted: string[] = [];
      const request: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const table = url.pathname.split('/').at(-1)!;
        const method = init?.method ?? 'GET';
        assert.ok(table in counts, 'No custom RPC or intermediate tables');
        if (method === 'HEAD') return new Response(null, { headers: { 'content-range': `*/${counts[table]}` } });
        if (method === 'GET') {
          assert.equal(url.searchParams.get('order'), 'updated_at.asc.nullsfirst,id.asc');
          assert.equal(url.searchParams.get('limit'), '25');
          return Response.json(Array.from({ length: 25 }, (_, i) => ({ id: i + 1 })));
        }
        if (method === 'DELETE') {
          assert.equal(url.searchParams.get('id'), `in.(${Array.from({ length: 25 }, (_, i) => i + 1).join(',')})`);
          deleted.push(table);
          counts[table]! -= 25;
          return new Response(null, { status: 204 });
        }
        assert.equal(method, 'POST');
        const rows = JSON.parse(String(init?.body)) as Record<string, unknown>[];
        for (const row of rows) assert.deepEqual(Object.keys(row).sort(), displayKeys);
        counts[table]! += rows.length;
        inserted.push(table);
        return new Response(null, { status: 201 });
      };
      const publish = createPublisher('https://example.supabase.co', 'test-key', root, request);
      await publish({ gainers: Array.from({ length: 25 }, stock), losers: Array.from({ length: 25 }, stock) }, 'run');
      assert.deepEqual(deleted, Object.entries({ top_gainers: gainers!, top_losers: losers! })
        .filter(([, count]) => count >= 100).map(([table]) => table));
      assert.deepEqual(inserted, ['top_gainers', 'top_losers']);
      assert.equal(counts.top_gainers, gainers! - (gainers! >= 100 ? 25 : 0) + 25);
      assert.equal(counts.top_losers, losers! - (losers! >= 100 ? 25 : 0) + 25);
      const progress = JSON.parse(await readFile(publicationFile(root, 'run'), 'utf8'));
      assert.equal(progress.tables.top_losers.phase, 'inserted');
      await assert.rejects(publish({ gainers: [], losers: [] }, 'run'), /already exists/);
    } finally { await rm(root, { recursive: true }); }
  });
}

test('uncertain second-table insert retains disk progress, never retries, and does not undo the first insert', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-uncertain-'));
  try {
    await initializeStorage(root);
    const posts: string[] = [];
    const request: typeof fetch = async (input, init) => {
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-range': '*/0' } });
      const table = new URL(String(input)).pathname.split('/').at(-1)!;
      posts.push(table);
      return table === 'top_gainers' ? new Response(null, { status: 201 })
        : Response.json({ message: 'Connection lost' }, { status: 503 });
    };
    const publish = createPublisher('https://example.supabase.co', 'test-key', root, request);
    await assert.rejects(publish({ gainers: [stock()], losers: [stock()] }, 'uncertain'), /uncertain outcome/);
    const progress = JSON.parse(await readFile(publicationFile(root, 'uncertain'), 'utf8'));
    assert.equal(progress.tables.top_gainers.phase, 'inserted');
    assert.equal(progress.tables.top_losers.phase, 'insert_started');
    assert.deepEqual(posts, ['top_gainers', 'top_losers']);
    await assert.rejects(publish({ gainers: [stock()], losers: [stock()] }, 'uncertain'), /already exists/);
    assert.equal(posts.length, 2);
  } finally { await rm(root, { recursive: true }); }
});

test('empty groups are not inserted and count failures never trigger deletion or insertion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-empty-'));
  try {
    await initializeStorage(root);
    let calls = 0;
    const request: typeof fetch = async (_input, init) => {
      calls++;
      assert.equal(init?.method, 'HEAD');
      return new Response(null, { headers: { 'content-range': '*/0' } });
    };
    await createPublisher('https://example.supabase.co', 'test-key', root, request)({ gainers: [], losers: [] }, 'empty');
    assert.equal(calls, 2);
    const fail: typeof fetch = async () => Response.json({ message: 'Permission denied' }, { status: 403 });
    await assert.rejects(createPublisher('https://example.supabase.co', 'test-key', root, fail)(
      { gainers: [], losers: [] }, 'failed',
    ), /count failed/);
  } finally { await rm(root, { recursive: true }); }
});
