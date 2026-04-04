import { DebounceManager } from '../../src/state-machine/dispatch/debounce-manager';

describe('DebounceManager', () => {
  let dm: DebounceManager;

  beforeEach(() => {
    // Use VISOR_DEBOUNCE_OVERRIDE=0 for instant debounce in tests
    process.env.VISOR_DEBOUNCE_OVERRIDE = '0';
    dm = new DebounceManager();
  });

  afterEach(() => {
    dm.clear();
    delete process.env.VISOR_DEBOUNCE_OVERRIDE;
  });

  it('executes a single invocation and returns the result', async () => {
    const result = await dm.enqueue('test-key', 1000, async () => {
      return { success: true, count: 42 };
    });

    expect(result.outcome).toBe('executed');
    expect(result).toHaveProperty('result');
    if (result.outcome === 'executed') {
      expect(result.result).toEqual({ success: true, count: 42 });
    }
  });

  it('debounces earlier invocations, only the last one executes', async () => {
    const calls: number[] = [];

    // Fire 3 invocations rapidly — only the last should execute
    const p1 = dm.enqueue('key', 100, async () => {
      calls.push(1);
      return 'result-1';
    });
    const p2 = dm.enqueue('key', 100, async () => {
      calls.push(2);
      return 'result-2';
    });
    const p3 = dm.enqueue('key', 100, async () => {
      calls.push(3);
      return 'result-3';
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1.outcome).toBe('debounced');
    expect(r2.outcome).toBe('debounced');
    expect(r3.outcome).toBe('executed');
    if (r3.outcome === 'executed') {
      expect(r3.result).toBe('result-3');
    }
    // Only the last fn should have been called
    expect(calls).toEqual([3]);
  });

  it('preserves the actual result from the executed function', async () => {
    const result = await dm.enqueue('key', 1000, async () => {
      return {
        text: 'CVE Processor finished. Processed: 37, Created: 2, Updated: 5',
        success: true,
        processed: 37,
      };
    });

    expect(result.outcome).toBe('executed');
    if (result.outcome === 'executed') {
      const r = result.result as any;
      expect(r.text).toContain('CVE Processor finished');
      expect(r.processed).toBe(37);
    }
  });

  it('handles independent keys separately', async () => {
    const p1 = dm.enqueue('key-a', 1000, async () => 'a');
    const p2 = dm.enqueue('key-b', 1000, async () => 'b');

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.outcome).toBe('executed');
    expect(r2.outcome).toBe('executed');
    if (r1.outcome === 'executed') expect(r1.result).toBe('a');
    if (r2.outcome === 'executed') expect(r2.result).toBe('b');
  });

  it('rejects if the function throws', async () => {
    await expect(
      dm.enqueue('key', 1000, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('cancel resolves all waiters as debounced', async () => {
    // Use real timer (small) to test cancel before execution
    delete process.env.VISOR_DEBOUNCE_OVERRIDE;

    const p1 = dm.enqueue('key', 5000, async () => 'should-not-run');
    const p2 = dm.enqueue('key', 5000, async () => 'should-not-run-either');

    // Cancel before debounce fires
    const cancelled = dm.cancel('key');
    expect(cancelled).toBe(true);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.outcome).toBe('debounced');
    expect(r2.outcome).toBe('debounced');
    expect(dm.size).toBe(0);
  });

  it('clear cancels all pending keys', async () => {
    delete process.env.VISOR_DEBOUNCE_OVERRIDE;

    const p1 = dm.enqueue('a', 5000, async () => 'x');
    const p2 = dm.enqueue('b', 5000, async () => 'y');

    expect(dm.size).toBe(2);
    dm.clear();
    expect(dm.size).toBe(0);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.outcome).toBe('debounced');
    expect(r2.outcome).toBe('debounced');
  });

  it('respects VISOR_DEBOUNCE_OVERRIDE env var', async () => {
    process.env.VISOR_DEBOUNCE_OVERRIDE = '0';

    const start = Date.now();
    const result = await dm.enqueue('key', 60000, async () => 'fast');
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe('executed');
    // With override=0, should resolve nearly instantly (not 60 seconds)
    expect(elapsed).toBeLessThan(1000);
  });

  it('tracks size correctly across enqueue/execute cycles', async () => {
    expect(dm.size).toBe(0);

    const p1 = dm.enqueue('a', 1000, async () => 1);
    expect(dm.size).toBe(1);

    const p2 = dm.enqueue('b', 1000, async () => 2);
    expect(dm.size).toBe(2);

    await Promise.all([p1, p2]);
    expect(dm.size).toBe(0);
  });
});

describe('DebounceManager execution guard', () => {
  let dm: DebounceManager;

  beforeEach(() => {
    process.env.VISOR_DEBOUNCE_OVERRIDE = '0';
    dm = new DebounceManager();
  });

  afterEach(() => {
    dm.clear();
    delete process.env.VISOR_DEBOUNCE_OVERRIDE;
  });

  it('skips invocations while function is executing', async () => {
    const calls: number[] = [];
    let resolveExecution: () => void;
    const executionPromise = new Promise<void>(r => {
      resolveExecution = r;
    });

    // First invocation: starts executing but takes a while
    const p1 = dm.enqueue('key', 1000, async () => {
      calls.push(1);
      await executionPromise;
      return 'result-1';
    });

    // Wait for the debounce to fire and execution to start
    await new Promise(r => setTimeout(r, 10));

    // Second invocation while first is executing — should be skipped
    const p2 = dm.enqueue('key', 1000, async () => {
      calls.push(2);
      return 'result-2';
    });

    // p2 should resolve immediately as debounced
    const r2 = await p2;
    expect(r2.outcome).toBe('debounced');

    // Let the first execution finish
    resolveExecution!();
    const r1 = await p1;
    expect(r1.outcome).toBe('executed');
    if (r1.outcome === 'executed') {
      expect(r1.result).toBe('result-1');
    }

    // Only the first function was called
    expect(calls).toEqual([1]);
  });

  it('allows new invocations after execution finishes', async () => {
    const calls: number[] = [];

    const r1 = await dm.enqueue('key', 1000, async () => {
      calls.push(1);
      return 'first';
    });
    expect(r1.outcome).toBe('executed');
    expect(dm.isExecuting('key')).toBe(false);

    // After execution finishes, a new invocation should work
    const r2 = await dm.enqueue('key', 1000, async () => {
      calls.push(2);
      return 'second';
    });
    expect(r2.outcome).toBe('executed');
    expect(calls).toEqual([1, 2]);
  });
});

describe('DebounceManager with real timers', () => {
  let dm: DebounceManager;

  beforeEach(() => {
    delete process.env.VISOR_DEBOUNCE_OVERRIDE;
    dm = new DebounceManager();
  });

  afterEach(() => {
    dm.clear();
  });

  it('coalesces rapid invocations within the debounce window', async () => {
    const executionOrder: string[] = [];

    // Fire first invocation with 200ms debounce
    const p1 = dm.enqueue('key', 200, async () => {
      executionOrder.push('fn1');
      return 'r1';
    });

    // Wait 50ms, fire second (resets the timer)
    await new Promise(r => setTimeout(r, 50));
    const p2 = dm.enqueue('key', 200, async () => {
      executionOrder.push('fn2');
      return 'r2';
    });

    // Wait 50ms, fire third (resets the timer again)
    await new Promise(r => setTimeout(r, 50));
    const p3 = dm.enqueue('key', 200, async () => {
      executionOrder.push('fn3');
      return 'r3';
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1.outcome).toBe('debounced');
    expect(r2.outcome).toBe('debounced');
    expect(r3.outcome).toBe('executed');
    if (r3.outcome === 'executed') {
      expect(r3.result).toBe('r3');
    }
    expect(executionOrder).toEqual(['fn3']);
  }, 10000);
});
