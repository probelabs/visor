import { OpaHttpEvaluator } from '../../../src/enterprise/policy/opa-http-evaluator';

describe('OpaHttpEvaluator', () => {
  it('normalizes base URL by stripping trailing slashes', () => {
    const evaluator = new OpaHttpEvaluator('http://opa:8181/', 5000);
    expect((evaluator as any).baseUrl).toBe('http://opa:8181');
  });

  it('constructs correct URL for evaluation', async () => {
    const originalFetch = global.fetch;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { allowed: true } }),
    });

    const evaluator = new OpaHttpEvaluator('http://opa:8181', 5000);
    await evaluator.evaluate({ test: true }, 'visor/check/execute');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://opa:8181/v1/data/visor/check/execute',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { test: true } }),
      })
    );

    global.fetch = originalFetch;
  });

  it('returns result from OPA response', async () => {
    const originalFetch = global.fetch;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { allowed: false, reason: 'denied' } }),
    });

    const evaluator = new OpaHttpEvaluator('http://opa:8181', 5000);
    const result = await evaluator.evaluate({}, 'visor/check/execute');

    expect(result).toEqual({ allowed: false, reason: 'denied' });

    global.fetch = originalFetch;
  });

  it('throws on non-ok response', async () => {
    const originalFetch = global.fetch;

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const evaluator = new OpaHttpEvaluator('http://opa:8181', 5000);
    await expect(evaluator.evaluate({}, 'test')).rejects.toThrow('OPA HTTP 500');

    global.fetch = originalFetch;
  });

  it('shutdown is a no-op', async () => {
    const evaluator = new OpaHttpEvaluator('http://opa:8181', 5000);
    await expect(evaluator.shutdown()).resolves.toBeUndefined();
  });
});
