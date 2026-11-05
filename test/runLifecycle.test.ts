import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentBootstrap, reportBootstrapFailure, type AgentBootstrapDependencies } from '../src/bootstrap.js';
import { RunFinalizationError, runWithFinalizer } from '../src/services/runLifecycle.js';
import { buildVmPauseUrl, pauseVm, vmPauseTimeoutMs, VmPauseTimeoutError } from '../src/services/vmPauseService.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

function bootstrapDependencies(
  overrides: Partial<AgentBootstrapDependencies> = {},
): AgentBootstrapDependencies {
  return {
    cleanup: async () => undefined,
    validatePauseConfiguration: async () => undefined,
    loadAndRunAgent: async () => undefined,
    pause: async () => undefined,
    ...overrides,
  };
}

describe('canonical agent lifecycle', () => {
  it('runs full Neon cleanup first and pauses last after success', async () => {
    const events: string[] = [];
    await runAgentBootstrap(bootstrapDependencies({
      cleanup: async () => { events.push('cleanup'); },
      validatePauseConfiguration: async () => { events.push('validate-pause'); },
      loadAndRunAgent: async () => { events.push('agent'); },
      pause: async () => { events.push('pause'); },
    }));

    assert.deepEqual(events, ['cleanup', 'validate-pause', 'agent', 'pause']);
  });

  for (const failedPhase of ['cleanup', 'validate-pause', 'agent'] as const) {
    it(`still pauses exactly once when ${failedPhase} fails`, async () => {
      const events: string[] = [];
      const failure = new Error(`${failedPhase} failed`);
      const dependencies = bootstrapDependencies({
        cleanup: async () => {
          events.push('cleanup');
          if (failedPhase === 'cleanup') throw failure;
        },
        validatePauseConfiguration: async () => {
          events.push('validate-pause');
          if (failedPhase === 'validate-pause') throw failure;
        },
        loadAndRunAgent: async () => {
          events.push('agent');
          if (failedPhase === 'agent') throw failure;
        },
        pause: async () => { events.push('pause'); },
      });

      await assert.rejects(runAgentBootstrap(dependencies), (err: unknown) => err === failure);
      assert.equal(events.filter(event => event === 'pause').length, 1);
      assert.equal(events.at(-1), 'pause');
    });
  }

  it('keeps the original agent error when the pause request also fails', async () => {
    const runError = new Error('agent failed');
    const pauseError = new Error('pause failed');
    const suppressed: unknown[] = [];

    await assert.rejects(runWithFinalizer({
      run: async () => { throw runError; },
      finalize: async () => { throw pauseError; },
      onSuppressedFinalizeError: error => suppressed.push(error),
    }), (err: unknown) => err === runError);
    assert.deepEqual(suppressed, [pauseError]);
  });

  it('keeps the original error even when failure diagnostics also throw', async () => {
    const runError = new Error('agent failed');
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(runWithFinalizer({
        run: async () => { throw runError; },
        finalize: async () => { throw new Error('pause failed'); },
        onSuppressedFinalizeError: () => { throw new Error('logger failed'); },
      }), (err: unknown) => err === runError);
    } finally {
      console.error = originalError;
    }
  });

  it('surfaces a pause failure after an otherwise successful run', async () => {
    const pauseError = new Error('pause failed');
    let runs = 0;
    let finalizations = 0;
    await assert.rejects(runWithFinalizer({
      run: async () => { runs++; return 'complete'; },
      finalize: async () => { finalizations++; throw pauseError; },
    }), (err: unknown) => err instanceof RunFinalizationError && err.runSucceeded && err.cause === pauseError);
    assert.equal(runs, 1, 'A finalization failure must not repeat completed work');
    assert.equal(finalizations, 1);
  });

  it('uses a distinct CLI failure status for pause finalization without relabeling successful work as a failed market run', () => {
    const originalExitCode = process.exitCode;
    const originalError = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      reportBootstrapFailure(new RunFinalizationError(new VmPauseTimeoutError(10_000)));
      assert.equal(process.exitCode, 2);
      assert.match(String(logs[0]![0]), /invocation completed, but VM pause finalization failed/);
      assert.ok(logs[0]![1] instanceof VmPauseTimeoutError);
      assert.doesNotMatch(logs.map(args => String(args[0])).join(' '), /Run failed with error/);
      logs.length = 0;
      reportBootstrapFailure(new Error('Actual market run failed'));
      assert.equal(process.exitCode, 1);
      assert.match(String(logs[0]![0]), /Run failed with error/);
    } finally {
      process.exitCode = originalExitCode;
      console.error = originalError;
    }
  });
});

describe('VM pause callback', () => {
  it('joins the fixed route and URL-encodes MACHINE_NO', () => {
    const url = buildVmPauseUrl({
      PAUSE_BASE_URL: 'https://controller.example.test/api/?discarded=yes#fragment',
      MACHINE_NO: 'vm 7/blue',
    });

    assert.equal(url.origin, 'https://controller.example.test');
    assert.equal(url.pathname, '/api/pause/vm');
    assert.equal(url.searchParams.get('machine'), 'vm 7/blue');
    assert.deepEqual([...url.searchParams.keys()], ['machine']);
    assert.equal(url.hash, '');
  });

  it('supports the conventional MACHINE_NO casing as an alias', () => {
    const url = buildVmPauseUrl({
      PAUSE_BASE_URL: 'http://controller.example.test/',
      MACHINE_NO: '12',
    });
    assert.equal(url.toString(), 'http://controller.example.test/pause/vm?machine=12');
  });

  it('uses a non-empty MACHINE_NO alias when machine_NO is present but blank', () => {
    const url = buildVmPauseUrl({
      PAUSE_BASE_URL: 'http://controller.example.test',
      machine_NO: '   ',
      MACHINE_NO: '19',
    });
    assert.equal(url.searchParams.get('machine'), '19');
  });

  it('sends one GET and requires a successful HTTP response', async () => {
    const calls: { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] }[] = [];
    const fetchMock = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls.push({ input, init });
      return new Response(null, { status: 204 });
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      await pauseVm({
        env: { PAUSE_BASE_URL: 'https://controller.example.test', MACHINE_NO: '42' },
        fetch: fetchMock as typeof fetch,
      });
    } finally {
      console.log = originalLog;
    }

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(String(call!.input), 'https://controller.example.test/pause/vm?machine=42');
    assert.equal(call!.init?.method, 'GET');
  });

  it('rejects non-2xx responses', async () => {
    await assert.rejects(pauseVm({
      env: { PAUSE_BASE_URL: 'https://controller.example.test', MACHINE_NO: '42' },
      fetch: (async () => new Response('busy', { status: 503 })) as typeof fetch,
    }), /VM pause request returned HTTP 503/);
  });

  it('aborts a pause request that exceeds its bounded timeout', async () => {
    let callCount = 0;
    const fetchMock = (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => new Promise<Response>((_resolve, reject) => {
      callCount++;
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    });

    await assert.rejects(pauseVm({
      env: { PAUSE_BASE_URL: 'https://controller.example.test', MACHINE_NO: '42' },
      fetch: fetchMock as typeof fetch,
      timeoutMs: 5,
    }), (error: unknown) => error instanceof VmPauseTimeoutError && error.timeoutMs === 5 &&
      /remote pause outcome is unknown/.test(error.message));
    assert.equal(callCount, 1);
  });

  it('accepts 2xx headers without reading a body that stalls during VM shutdown', async () => {
    let calls = 0;
    let bodyReads = 0;
    let signal: AbortSignal | undefined;
    await pauseVm({
      env: { PAUSE_BASE_URL: 'https://controller.example.test', MACHINE_NO: '42' },
      timeoutMs: 20,
      fetch: async (_input, init) => {
        calls++;
        signal = init!.signal!;
        const response = new Response(new ReadableStream({
          start(controller) {
            signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
          },
        }), { status: 202 });
        const read = response.arrayBuffer.bind(response);
        response.arrayBuffer = () => { bodyReads++; return read(); };
        return response;
      },
    });
    assert.equal(calls, 1);
    assert.equal(bodyReads, 0, 'Response body completion is not the pause acknowledgement contract');
    assert.equal(signal!.aborted, true, 'Unused response transport is released after acknowledgement');
  });

  it('works with real HTTP response headers when the controller never finishes its body', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.flushHeaders();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      await pauseVm({
        env: { PAUSE_BASE_URL: `http://127.0.0.1:${address.port}`, MACHINE_NO: 'fixture' },
        timeoutMs: 1000,
      });
      assert.equal(calls, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('validates the configurable deadline before making requests and never retries unknown remote outcomes', async () => {
    assert.equal(vmPauseTimeoutMs({}), 10_000);
    assert.equal(vmPauseTimeoutMs({ VM_PAUSE_TIMEOUT_MS: '30000' }), 30_000);
    assert.equal(vmPauseTimeoutMs({ VM_PAUSE_TIMEOUT_MS: '30000' }, 5000), 5000);
    for (const value of ['0', '-1', '', 'NaN', '1.5', '2147483648']) {
      await assert.rejects(pauseVm({
        env: { PAUSE_BASE_URL: 'https://controller.example.test', MACHINE_NO: '42', VM_PAUSE_TIMEOUT_MS: value },
        fetch: async () => { assert.fail('Invalid deadline must not send a pause request'); },
      }), /VM pause timeout must be a positive integer/);
    }
    let calls = 0;
    await assert.rejects(pauseVm({
      env: { PAUSE_BASE_URL: 'https://controller.example.test', MACHINE_NO: '42' },
      fetch: async () => { calls++; throw new TypeError('fetch failed'); },
    }), /fetch failed/);
    assert.equal(calls, 1, 'A request may already have paused the VM; it must not be replayed automatically');
  });
});
