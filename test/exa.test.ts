import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExaSearch, loadExaConfig } from '../src/exa.js';
import { candidate } from './helpers.js';
import type { LiveRead } from '../src/research.js';

const now = () => Date.parse('2026-11-03T09:00:00Z');
const content = 'EXAMPLE announced a new manufacturing contract and described execution risks in its company disclosure.';
const result = (overrides = {}) => ({
  url: 'https://company.example/investors/announcement', text: content,
  publishedDate: '2026-11-02T10:00:00Z', title: 'Company news', ...overrides,
});
const config = () => loadExaConfig({ EXA_API_KEYS: 'test-key-a,test-key-b,test-key-c' });

test('Exa is optional, validates settings and accepts deduplicated list/single/numbered keys', () => {
  assert.equal(loadExaConfig({}).enabled, false);
  assert.equal(loadExaConfig({ EXA_ENABLED: 'false', EXA_API_KEY: 'test-key' }).enabled, false);
  assert.throws(() => loadExaConfig({ EXA_ENABLED: 'true' }), /requires an Exa API key/);
  assert.throws(() => loadExaConfig({ EXA_ENABLED: 'yes' }));
  assert.throws(() => loadExaConfig({ EXA_MAX_KEY_ATTEMPTS: '0' }));
  assert.throws(() => loadExaConfig({ EXA_TIMEOUT_MS: '0' }));
  assert.deepEqual(loadExaConfig({
    EXA_API_KEYS: 'a,b\na', EXA_API_KEY: 'c', EXA_API_KEY_2: 'e', EXA_API_KEY_1: 'd',
  }).keys, ['a', 'b', 'c', 'd', 'e']);
});

test('concurrent stocks share round-robin key rotation and use one bounded public-data query each', async () => {
  const keys: string[] = [];
  const search = createExaSearch(config(), async (url, init) => {
    assert.equal(url, 'https://api.exa.ai/search');
    keys.push(new Headers(init?.headers).get('x-api-key')!);
    const body = JSON.parse(String(init?.body));
    assert.match(body.query, /EXAMPLE/);
    assert.equal(body.numResults, 3);
    assert.deepEqual(body.contents.text, { maxCharacters: 6000 });
    assert.equal(body.startPublishedDate, '2026-10-27T09:00:00.000Z');
    assert.equal(body.endPublishedDate, '2026-11-03T09:00:00.000Z');
    await Promise.resolve();
    return Response.json({ results: [result()] });
  }, now);
  const results = await Promise.all(Array.from({ length: 5 }, () => search(candidate(), [])));
  assert.deepEqual(keys, ['test-key-a', 'test-key-b', 'test-key-c', 'test-key-a', 'test-key-b']);
  assert.equal(new Set(results.map(reads => reads[0]!.evidenceId)).size, 5);
  assert.equal(results[0]![0]!.kind, 'exa');
  assert.equal(results[0]![0]!.publishedAt, '2026-11-02T10:00:00.000Z');
  assert.equal(results[0]![0]!.observedAt, new Date(now()).toISOString());
  assert.equal(results[0]![0]!.output, content);
});

test('authentication, exhausted-credit and rate-limit errors rotate without exposing keys or provider bodies', async () => {
  for (const status of [401, 402, 403, 429, 503]) {
    const calls: string[] = [];
    const search = createExaSearch(config(), async (_url, init) => {
      calls.push(new Headers(init?.headers).get('x-api-key')!);
      return calls.length === 1 ? new Response('sensitive provider error', { status }) : Response.json({ results: [result()] });
    }, now);
    assert.equal((await search(candidate(), [])).length, 1);
    assert.deepEqual(calls, ['test-key-a', 'test-key-b']);
  }
  let calls = 0;
  const exhausted = createExaSearch(config(), async () => {
    calls++;
    return new Response('test-key-a must never appear in diagnostics', { status: 429 });
  }, now);
  await assert.rejects(exhausted(candidate(), []), /^Error: Exa search HTTP 429$/);
  await assert.rejects(exhausted(candidate(), []), /No Exa keys are currently available/);
  assert.equal(calls, 3, 'Cooling keys must not be retried by another stock');
});

test('per-search attempt and wall-clock budgets bound retries; bad requests and malformed JSON do not rotate', async () => {
  let calls = 0;
  const bounded = createExaSearch({ ...config(), EXA_MAX_KEY_ATTEMPTS: 2 }, async () => {
    calls++; throw new TypeError('fetch failed; network diagnostic containing test-key-a');
  }, now);
  await assert.rejects(bounded(candidate(), []), /^Error: Exa network request failed or exceeded its time budget$/);
  assert.equal(calls, 2);
  calls = 0;
  let time = now();
  const deadline = createExaSearch({ ...config(), EXA_TIMEOUT_MS: 1000 }, async () => {
    calls++; time += 1001; return new Response('', { status: 503 });
  }, () => time);
  await assert.rejects(deadline(candidate(), []), /HTTP 503/);
  assert.equal(calls, 1);
  for (const response of [new Response('', { status: 400 }), new Response('test-key-a not JSON')]) {
    calls = 0;
    const search = createExaSearch(config(), async () => { calls++; return response; }, now);
    await assert.rejects(search(candidate(), []), /Exa search HTTP 400|invalid search evidence/);
    assert.equal(calls, 1);
  }
});

test('results require usable company-matched content, keep publication unknowns and reject unsafe/duplicate URLs and reprints', async () => {
  const existing: LiveRead[] = [{
    url: 'https://company.example/investors/announcement?utm_source=tavily',
    output: content, observedAt: new Date(now()).toISOString(), kind: 'tavily',
  }];
  const search = createExaSearch(config(), async () => Response.json({
    results: [
      result(),
      result({ url: 'https://syndicated.example/reprint' }),
      result({ url: 'https://other.example/unrelated', text: 'ANOTHERCO announced a different corporate development unrelated to the requested business.' }),
    ],
  }), now);
  assert.deepEqual(await search(candidate(), existing), []);
  const unsafe = createExaSearch(config(), async () => Response.json({
    results: [result({ url: 'javascript:alert(1)' }), result({ url: 'https://user:pass@example.org/article' }),
      result({ url: 'https://good.example/article', publishedDate: 'unknown' })],
  }), now);
  const reads = await unsafe(candidate(), []);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.publishedAt, undefined);
  assert.equal(reads[0]!.url, 'https://good.example/article');
});

test('key cooldown expires and a disabled configuration never sends a request', async () => {
  let time = now();
  let calls = 0;
  const search = createExaSearch(loadExaConfig({ EXA_API_KEY: 'test-key' }), async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429 }) : Response.json({ results: [] });
  }, () => time);
  await assert.rejects(search(candidate(), []), /HTTP 429/);
  time += 60_001;
  assert.deepEqual(await search(candidate(), []), []);
  assert.equal(calls, 2);
  await assert.rejects(createExaSearch(loadExaConfig({}), async () => {
    assert.fail('Disabled Exa must not make requests');
  })(candidate(), []), /not configured/);
});
