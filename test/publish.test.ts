import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPublisher, publicationFile, publicationRow } from '../src/publish.js';
import { initializeStorage } from '../src/storage.js';
import { candidate, research, reportReference } from './helpers.js';

const stock = () => ({ candidate: candidate(), research: research(), riskScore: 20, recoveryScore: 80, rank: 1, report: reportReference() });
const displayKeys = ['change', 'change_percent', 'name', 'price', 'profit_probability', 'report_url', 'updated_at'];

test('missing, expired or non-HTTPS report references prevent all Supabase operations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'report-publish-'));
  try {
    await initializeStorage(root);
    let calls = 0;
    const publish = createPublisher('https://example.supabase.co', 'test-key', root, async () => {
      calls++;
      throw new Error('No Supabase request is permitted');
    });
    for (const [index, report] of [
      undefined, { ...reportReference(), expiresAt: '2000-01-01T00:00:00.000Z' },
      { ...reportReference(), url: 'http://reports.example.org/stock.html' },
    ].entries()) {
      await assert.rejects(publish({ gainers: [{ ...stock(), report }], losers: [] }, `invalid-${index}`));
    }
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true }); }
});

test('publication payload contains only display columns, never reasons or metadata', () => {
  const row = publicationRow(stock(), '2026-10-27T12:00:00Z');
  assert.deepEqual(Object.keys(row).sort(), displayKeys);
  assert.equal(row.profit_probability, 'high');
});

for (const [gainers, losers] of [[99, 99], [100, 99], [99, 100], [101, 126]]) {
  test(`direct publication prunes gainers and leaves paused losers untouched (${gainers}/${losers})`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nse-direct-'));
    try {
      await initializeStorage(root);
      const counts: Record<string, number> = { top_gainers: gainers!, top_losers: losers! };
      const deleted: string[] = [];
      const inserted: string[] = [];
      const request: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const table = url.pathname.split('/').at(-1)!;
        assert.equal(table, 'top_gainers', 'Paused losers must not be queried, cleaned or inserted');
        const method = init?.method ?? 'GET';
        assert.ok(table in counts, 'No custom RPC or intermediate tables');
        if (method === 'GET' && url.searchParams.get('limit') === '1') {
          assert.equal(url.searchParams.get('select'), 'id');
          assert.equal(new Headers(init?.headers).get('prefer'), 'count=exact');
          return Response.json([{ id: 1 }], { headers: { 'content-range': `0-0/${counts[table]}` } });
        }
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
      assert.deepEqual(deleted, Object.entries({ top_gainers: gainers! })
        .filter(([, count]) => count >= 100).map(([table]) => table));
      assert.deepEqual(inserted, ['top_gainers']);
      assert.equal(counts.top_gainers, gainers! - (gainers! >= 100 ? 25 : 0) + 25);
      assert.equal(counts.top_losers, losers!);
      const progress = JSON.parse(await readFile(publicationFile(root, 'run'), 'utf8'));
      assert.equal(progress.tables.top_losers.phase, 'paused');
      await assert.rejects(publish({ gainers: [], losers: [] }, 'run'), /already exists/);
    } finally { await rm(root, { recursive: true }); }
  });
}

test('uncertain gainer insert retains disk progress, never retries and never touches losers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-uncertain-'));
  try {
    await initializeStorage(root);
    const posts: string[] = [];
    const request: typeof fetch = async (input, init) => {
      if (init?.method === 'GET') {
        assert.equal(new URL(String(input)).searchParams.get('limit'), '1');
        return Response.json([], { headers: { 'content-range': '*/0' } });
      }
      const table = new URL(String(input)).pathname.split('/').at(-1)!;
      posts.push(table);
      return Response.json({ message: 'Connection lost' }, { status: 503 });
    };
    const publish = createPublisher('https://example.supabase.co', 'test-key', root, request);
    await assert.rejects(publish({ gainers: [stock()], losers: [stock()] }, 'uncertain'), /uncertain outcome.*HTTP 503; Connection lost/);
    const progress = JSON.parse(await readFile(publicationFile(root, 'uncertain'), 'utf8'));
    assert.equal(progress.tables.top_gainers.phase, 'insert_started');
    assert.equal(progress.tables.top_losers.phase, 'paused');
    assert.deepEqual(posts, ['top_gainers']);
    await assert.rejects(publish({ gainers: [stock()], losers: [stock()] }, 'uncertain'), /already exists/);
    assert.equal(posts.length, 1);
  } finally { await rm(root, { recursive: true }); }
});

test('empty groups are not inserted and count failures never trigger deletion or insertion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nse-empty-'));
  try {
    await initializeStorage(root);
    let calls = 0;
    const request: typeof fetch = async (_input, init) => {
      calls++;
      assert.equal(init?.method, 'GET');
      return Response.json([], { headers: { 'content-range': '*/0' } });
    };
    await createPublisher('https://example.supabase.co', 'test-key', root, request)({ gainers: [], losers: [] }, 'empty');
    assert.equal(calls, 1);
    const fail: typeof fetch = async () => Response.json({ message: 'Permission denied' }, { status: 403 });
    await assert.rejects(createPublisher('https://example.supabase.co', 'test-key', root, fail)(
      { gainers: [], losers: [] }, 'failed',
    ), /count failed for top_gainers: HTTP 403; Permission denied/);
  } finally { await rm(root, { recursive: true }); }
});

for (const [name, response, expected] of [
  ['invalid API key', () => Response.json({
    message: 'Invalid API key', hint: 'Double check your service_role API key.',
  }, { status: 401, statusText: 'Unauthorized' }), /HTTP 401 Unauthorized; Invalid API key.*service_role.*SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/],
  ['bodyless failure', () => new Response(null, { status: 401 }), /HTTP 401; Empty error response/],
  ['missing count', () => Response.json([]), /Missing or invalid exact row count/],
  ['malformed count', () => Response.json([], { headers: { 'content-range': '*/invalid' } }), /Missing or invalid exact row count/],
  ['negative count', () => Response.json([], { headers: { 'content-range': '*/-1' } }), /Missing or invalid exact row count/],
  ['unsafe count', () => Response.json([], { headers: { 'content-range': '*/9007199254740992' } }), /Missing or invalid exact row count/],
] as const) {
  test(`count ${name} is explicit, bounded and never permits writes or an automatic replay`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nse-count-error-'));
    try {
      await initializeStorage(root);
      let calls = 0;
      const request: typeof fetch = async (input, init) => {
        calls++;
        const url = new URL(String(input));
        assert.equal(init?.method, 'GET');
        assert.equal(url.pathname, '/rest/v1/top_gainers');
        assert.equal(url.searchParams.get('select'), 'id');
        assert.equal(url.searchParams.get('limit'), '1');
        assert.equal(new Headers(init?.headers).get('prefer'), 'count=exact');
        return response();
      };
      const publish = createPublisher('https://example.supabase.co', 'test-key', root, request);
      await assert.rejects(publish({ gainers: [stock()], losers: [] }, 'count-error'), expected);
      assert.equal(calls, 1);
      const progress = JSON.parse(await readFile(publicationFile(root, 'count-error'), 'utf8'));
      assert.equal(progress.tables.top_gainers.phase, 'pending');
      await assert.rejects(publish({ gainers: [stock()], losers: [] }, 'count-error'), /already exists/);
      assert.equal(calls, 1);
    } finally { await rm(root, { recursive: true }); }
  });
}
