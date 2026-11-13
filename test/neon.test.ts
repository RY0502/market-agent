import test from "node:test";
import assert from "node:assert/strict";
import { createRetryingFetch } from "../src/neon.js";

test("createRetryingFetch retries transient fetch failed errors and succeeds", async () => {
  let callCount = 0;
  const mockFetch = (async () => {
    callCount++;
    if (callCount < 3) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const configuredFetch = createRetryingFetch(mockFetch, 3, 10);
  const response = await configuredFetch("https://neon.tech/sql", {});
  assert.equal(callCount, 3);
  assert.equal(response.status, 200);
});

test("createRetryingFetch fails after max retries exhausted", async () => {
  let callCount = 0;
  const mockFetch = (async () => {
    callCount++;
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  const configuredFetch = createRetryingFetch(mockFetch, 3, 10);
  await assert.rejects(
    async () => {
      await configuredFetch("https://neon.tech/sql", {});
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /fetch failed/);
      return true;
    }
  );
  assert.equal(callCount, 3);
});
