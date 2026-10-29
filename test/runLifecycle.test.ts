import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentBootstrap, type AgentBootstrapDependencies } from '../src/bootstrap.js';
import { runWithFinalizer } from '../src/services/runLifecycle.js';
import { buildVmPauseUrl, pauseVm } from '../src/services/vmPauseService.js';

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
    await assert.rejects(runWithFinalizer({
      run: async () => 'complete',
      finalize: async () => { throw pauseError; },
    }), (err: unknown) => err === pauseError);
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
    }), /request aborted/);
    assert.equal(callCount, 1);
  });
});
