import { FairConcurrencyLimiter } from '../../src/utils/fair-concurrency-limiter';

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('FairConcurrencyLimiter', () => {
  let limiter: FairConcurrencyLimiter;

  beforeEach(() => {
    limiter = new FairConcurrencyLimiter(3);
  });

  afterEach(() => {
    limiter.cleanup();
  });

  it('allows immediate acquisition when slots available', async () => {
    expect(await limiter.acquire('session-a')).toBe(true);
    expect(limiter.getStats().globalActive).toBe(1);
  });

  it('blocks when all slots are full', async () => {
    await limiter.acquire('a');
    await limiter.acquire('a');
    await limiter.acquire('a');
    expect(limiter.getStats().globalActive).toBe(3);

    let resolved = false;
    const p = limiter.acquire('b', false, 5000).then(() => {
      resolved = true;
    });

    // Give it a tick — should NOT resolve
    await new Promise(r => setTimeout(r, 50));
    expect(resolved).toBe(false);
    expect(limiter.getStats().queueSize).toBe(1);

    // Release one — should resolve
    limiter.release('a');
    await p;
    expect(resolved).toBe(true);
  });

  it('round-robins across sessions fairly', async () => {
    // Fill all 3 slots with session A
    await limiter.acquire('a');
    await limiter.acquire('a');
    await limiter.acquire('a');

    // Queue: 2 from A, 2 from B — interleaved
    const order: string[] = [];
    const pA1 = limiter.acquire('a', false, 5000).then(() => order.push('a'));
    const pB1 = limiter.acquire('b', false, 5000).then(() => order.push('b'));
    const pA2 = limiter.acquire('a', false, 5000).then(() => order.push('a'));
    const pB2 = limiter.acquire('b', false, 5000).then(() => order.push('b'));

    await new Promise(r => setTimeout(r, 50));
    expect(limiter.getStats().queueSize).toBe(4);

    // Release all 3 slots — should grant round-robin: a, b, a (3 slots)
    limiter.release('a');
    limiter.release('a');
    limiter.release('a');

    // Wait for all grants to settle
    await Promise.all(
      [pA1, pB1, pA2, pB2].map(p => Promise.race([p, new Promise(r => setTimeout(r, 200))]))
    );

    // First 3 granted should alternate: a, b, a (round-robin)
    // The 4th (b) waits since all 3 slots are re-filled
    expect(order.length).toBeGreaterThanOrEqual(3);
    // Check fairness: both sessions should get at least 1 slot in the first 3 grants
    const aCount = order.slice(0, 3).filter(s => s === 'a').length;
    const bCount = order.slice(0, 3).filter(s => s === 'b').length;
    expect(aCount).toBeGreaterThanOrEqual(1);
    expect(bCount).toBeGreaterThanOrEqual(1);
  });

  it('tryAcquire returns false when full', () => {
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(false);
  });

  it('release decrements counters', async () => {
    await limiter.acquire('a');
    await limiter.acquire('b');
    expect(limiter.getStats().globalActive).toBe(2);

    limiter.release('a');
    expect(limiter.getStats().globalActive).toBe(1);

    limiter.release('b');
    expect(limiter.getStats().globalActive).toBe(0);
  });

  it('getStats shows per-session breakdown', async () => {
    await limiter.acquire('user-1');
    await limiter.acquire('user-1');
    await limiter.acquire('user-2');

    const stats = limiter.getStats();
    expect(stats.globalActive).toBe(3);
    expect(stats.perSession['user-1'].active).toBe(2);
    expect(stats.perSession['user-2'].active).toBe(1);
  });

  it('queue timeout rejects', async () => {
    await limiter.acquire('a');
    await limiter.acquire('a');
    await limiter.acquire('a');

    await expect(limiter.acquire('b', false, 100)).rejects.toThrow(/Queue timeout/);
  });

  it('queueTimeout=0 waits indefinitely until slot is released', async () => {
    // Fill all 3 slots
    await limiter.acquire('a');
    await limiter.acquire('a');
    await limiter.acquire('a');

    let resolved = false;
    // queueTimeout=0 means no timeout — should wait indefinitely
    const p = limiter.acquire('b', false, 0).then(() => {
      resolved = true;
    });

    // Wait longer than the default 120s would allow (use 200ms as proxy)
    await new Promise(r => setTimeout(r, 200));
    expect(resolved).toBe(false);
    expect(limiter.getStats().queueSize).toBe(1);

    // Release a slot — queued request should resolve
    limiter.release('a');
    await p;
    expect(resolved).toBe(true);
  });

  it('singleton via getInstance', () => {
    const a = FairConcurrencyLimiter.getInstance(5);
    const b = FairConcurrencyLimiter.getInstance(5);
    expect(a).toBe(b);
    a.cleanup(); // remove singleton
  });

  it('getInstance updates maxConcurrent on change', () => {
    const a = FairConcurrencyLimiter.getInstance(5);
    expect(a.getStats().maxConcurrent).toBe(5);

    const b = FairConcurrencyLimiter.getInstance(10);
    expect(b).toBe(a);
    expect(b.getStats().maxConcurrent).toBe(10);
    a.cleanup();
  });
});
