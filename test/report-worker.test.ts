import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReportRequest, type ReportEnvironment, type ReportNamespace } from '../cloudflare/worker.js';
import { createReporter, reportLocation, verifyReportHosting } from '../src/report-storage.js';
import { REPORT_LIFETIME_MS, reportHeaders } from '../src/report-policy.js';
import { candidate, research } from './helpers.js';
import type { RankedStock } from '../src/research.js';

const runId = '12345678-1234-1234-1234-123456789abc';
const config = {
  CLOUDFLARE_REPORT_URL: 'https://reports.example.org',
  CLOUDFLARE_REPORT_UPLOAD_TOKEN: 'test-secret-'.repeat(4),
};
const createdAt = Date.parse('2026-10-28T12:00:00Z');

function harness() {
  let time = createdAt;
  const stored = new Map<string, { value: string; metadata: { expiresAt: number }; expiration: number }>();
  const cached = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  let reads = 0;
  let writes = 0;
  const namespace: ReportNamespace = {
    async getWithMetadata<T>(key: string) {
      reads++;
      const file = stored.get(key);
      return { value: file?.value ?? null, metadata: (file?.metadata ?? null) as T | null };
    },
    async put(key, value, options) {
      writes++;
      stored.set(key, { value, ...options });
    },
  };
  const env: ReportEnvironment = { REPORTS: namespace, REPORT_UPLOAD_TOKEN: config.CLOUDFLARE_REPORT_UPLOAD_TOKEN };
  const cache: Pick<Cache, 'match' | 'put' | 'delete'> = {
    async match(key) { return cached.get(new Request(key).url)?.clone(); },
    async put(key, response) { cached.set(new Request(key).url, response.clone()); },
    async delete(key) { return cached.delete(new Request(key).url); },
  };
  const request: typeof fetch = async (input, init) => handleReportRequest(
    new Request(input, init), env, cache, { waitUntil: promise => pending.push(promise) }, () => time,
  );
  return {
    request, stored, cached, env, pending,
    setTime: (value: number) => { time = value; },
    counts: () => ({ reads, writes }),
  };
}
const stock = (): RankedStock => ({
  candidate: { ...candidate(), symbol: 'M&M' }, research: research(), rank: 1, riskScore: 20, recoveryScore: 80,
});
const payload = () => ({
  path: reportLocation(config, runId, 'gainers', 'M&M').key,
  html: '<!doctype html><title>Stock report</title>',
  createdAt: new Date(createdAt).toISOString(),
  expiresAt: new Date(createdAt + REPORT_LIFETIME_MS).toISOString(),
});
const upload = (h: ReturnType<typeof harness>, body: unknown, token = config.CLOUDFLARE_REPORT_UPLOAD_TOKEN) =>
  h.request(`${config.CLOUDFLARE_REPORT_URL}/stock-report-upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('reporter uploads actual HTML into KV with five-day automatic expiry and serves stable encoded URLs', async () => {
  const h = harness();
  await verifyReportHosting(config, h.request);
  const reporter = createReporter(config, h.request, () => createdAt);
  const reference = await reporter(stock(), runId, [{ date: '2026-10-26', close: 500 }], 5);
  const location = reportLocation(config, runId, 'gainers', 'M&M');
  assert.equal(reference.url, location.url);
  assert.equal(reference.expiresAt, '2026-11-02T12:00:00.000Z');
  const file = h.stored.get(location.key)!;
  assert.equal(file.expiration, (createdAt + REPORT_LIFETIME_MS) / 1000);
  assert.equal(file.metadata.expiresAt, createdAt + REPORT_LIFETIME_MS);
  assert.match(file.value, /Daily closing prices/);
  assert.doesNotMatch(file.value, /test-secret|R2 lifecycle|Convex/);
  const response = await h.request(`${reference.url}?tracking=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300, s-maxage=300, must-revalidate');
  assert.match(response.headers.get('Content-Security-Policy')!, /default-src 'none'/);
  assert.equal(await response.text(), file.value);
  await Promise.all(h.pending);
  const reads = h.counts().reads;
  const head = await h.request(reference.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(h.counts().reads, reads, 'HEAD uses the same canonical edge cache entry');
  assert.equal(h.cached.size, 1);
});

test('expired edge and KV copies are inaccessible exactly at five days, including HEAD', async () => {
  const h = harness();
  const report = payload();
  assert.equal((await upload(h, report)).status, 200);
  const url = reportLocation(config, runId, 'gainers', 'M&M').url;
  assert.equal((await h.request(url)).status, 200);
  await Promise.all(h.pending);
  h.setTime(createdAt + REPORT_LIFETIME_MS - 1000);
  const nearExpiry = await h.request(url);
  assert.equal(nearExpiry.status, 200);
  assert.match(nearExpiry.headers.get('Cache-Control')!, /max-age=1,/);
  h.setTime(createdAt + REPORT_LIFETIME_MS);
  const expiredEdge = await h.request(url);
  assert.equal(expiredEdge.status, 410);
  assert.equal(expiredEdge.headers.get('Cache-Control'), 'no-store');
  await Promise.all(h.pending);
  assert.equal(h.cached.size, 0);
  assert.equal((await h.request(url, { method: 'HEAD' })).status, 410, 'KV propagation cannot revive expired content');
  assert.equal(h.stored.size, 1, 'No application cleanup job is needed; KV owns physical expiration');
  h.stored.clear();
  assert.equal((await h.request(url)).status, 404);
  assert.equal(reportHeaders(createdAt + 500, createdAt).get('Cache-Control'), 'no-store');
});

test('uploads require authentication, safe paths, valid HTML size and exactly five-day retention', async () => {
  const h = harness();
  assert.equal((await upload(h, payload(), 'wrong-token')).status, 401);
  assert.equal((await h.request(`${config.CLOUDFLARE_REPORT_URL}/stock-report-health`)).status, 401);
  for (const body of [
    { ...payload(), path: 'other-project/anything.html' },
    { ...payload(), path: payload().path.replace('M&M', '..') },
    { ...payload(), expiresAt: new Date(createdAt + 86_400_000).toISOString() },
    { ...payload(), createdAt: '2026-10-27T12:00:00Z', expiresAt: '2026-11-01T12:00:00Z' },
    { ...payload(), html: 'a'.repeat(64_001) },
    { ...payload(), html: '' },
  ]) assert.equal((await upload(h, body)).status, 400);
  assert.equal((await upload(h, { ...payload(), html: 'a'.repeat(400_001) })).status, 413);
  assert.equal(h.counts().writes, 0);
  assert.equal((await upload(h, { ...payload(), html: 'a'.repeat(64_000) })).status, 200);
  assert.equal((await h.request(`${config.CLOUDFLARE_REPORT_URL}/stock-reports/%zz`)).status, 400);
  assert.equal((await h.request(`${config.CLOUDFLARE_REPORT_URL}/anything`)).status, 404);
  assert.equal((await h.request(`${config.CLOUDFLARE_REPORT_URL}/${payload().path}`, { method: 'DELETE' })).status, 405);
});

test('KV errors propagate to the uploader and do not produce report references', async () => {
  const h = harness();
  h.env.REPORTS.put = async () => { throw new Error('KV write unavailable'); };
  await assert.rejects(createReporter(config, h.request, () => createdAt)(stock(), runId, [], 5), /KV write unavailable/);
  assert.equal(h.stored.size, 0);
});
