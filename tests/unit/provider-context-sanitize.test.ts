import { MemoryCheckProvider } from '../../src/providers/memory-check-provider';
import { type PRInfo } from '../../src/pr-analyzer';
import { type ReviewSummary } from '../../src/reviewer';

describe('provider context sanitization', () => {
  const prInfo: PRInfo = {
    number: 1,
    title: 't',
    body: '',
    author: 'a',
    base: 'main',
    head: 'feat',
    files: [],
    isIssue: false,
    eventType: 'manual',
  } as any;

  it('memory provider buildTemplateContext tolerates non-string dependency keys', async () => {
    const provider = new MemoryCheckProvider();
    const dep = new Map<any, ReviewSummary>();
    dep.set(undefined as any, { issues: [] });
    dep.set(42 as any, { issues: [] });
    dep.set(Symbol('x') as any, { issues: [] });
    // Also include valid -raw entry
    dep.set('extract-facts-raw', { issues: [], output: [1, 2, 3] } as any);

    const res = await provider.execute(
      prInfo,
      { type: 'memory', operation: 'get', key: 'k' } as any,
      dep
    );

    expect(res).toBeTruthy();
    expect(res.issues).toBeDefined();
  });
});
