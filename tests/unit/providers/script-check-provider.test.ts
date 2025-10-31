import { ScriptCheckProvider } from '../../../src/providers/script-check-provider';
import { MemoryStore } from '../../../src/memory-store';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { ReviewSummary } from '../../../src/reviewer';

describe('ScriptCheckProvider', () => {
  let provider: ScriptCheckProvider;
  let pr: PRInfo;

  beforeEach(() => {
    provider = new ScriptCheckProvider();
    MemoryStore.resetInstance();
    pr = {
      number: 1,
      title: 'Add script provider',
      body: 'Test PR',
      author: 'tester',
      base: 'main',
      head: 'feature/script',
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    };
  });

  it('exposes correct metadata', () => {
    expect(provider.getName()).toBe('script');
    expect(typeof provider.getDescription()).toBe('string');
  });

  it('validates configuration', async () => {
    expect(await provider.validateConfig({ type: 'script', content: 'return 1;' })).toBe(true);
    expect(await provider.validateConfig({ type: 'script' })).toBe(false);
  });

  it('executes simple script and returns result', async () => {
    const res = (await provider.execute(pr, {
      type: 'script',
      content: 'return 42;',
    })) as ReviewSummary & {
      output?: unknown;
    };
    expect(res.output).toBe(42);
    expect(res.issues).toEqual([]);
  });

  it('can access dependency outputs and memory', async () => {
    const deps = new Map<string, ReviewSummary>();
    deps.set('dep', { issues: [], output: { num: 3 } } as any);
    const result = (await provider.execute(
      pr,
      {
        type: 'script',
        content: `
          memory.set('count', 10);
          return { v: outputs.dep.num, n: memory.increment('count', outputs.dep.num), stored: memory.get('count') };
        `,
      },
      deps
    )) as ReviewSummary & { output?: { v: number; n: number; stored: number } };

    expect(result.output?.v).toBe(3);
    expect(result.output?.n).toBe(13);
    expect(result.output?.stored).toBe(13);
    const store = MemoryStore.getInstance();
    expect(store.get('count')).toBe(13);
  });

  it('exposes outputs keys in context', async () => {
    const deps = new Map<string, ReviewSummary>();
    deps.set('alpha', { issues: [], output: { hello: 'world' } } as any);
    const res = (await provider.execute(
      pr,
      { type: 'script', content: 'return { ok: !!outputs, keys: Object.keys(outputs) };' },
      deps
    )) as ReviewSummary & { output?: any };
    expect(res.output?.ok).toBe(true);
    // 'history' key also present; ensure our dependency key is included
    expect(res.output?.keys).toContain('alpha');
  });

  it('exposes dependency object shape', async () => {
    const deps = new Map<string, ReviewSummary>();
    deps.set('dep', { issues: [], output: { num: 7 } } as any);
    const res = (await provider.execute(
      pr,
      { type: 'script', content: 'return { dep: outputs.dep, type: typeof outputs.dep };' },
      deps
    )) as ReviewSummary & { output?: any };
    expect(res.output?.type).toBe('object');
    expect(res.output?.dep && res.output.dep.num).toBe(7);
  });
});
