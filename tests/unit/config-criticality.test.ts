import { buildEngineContextForRun } from '../../src/state-machine/context/build-engine-context';
import type { VisorConfig } from '../../src/types/config';

describe('Config criticality defaults', () => {
  it('defaults missing check.criticality to policy', () => {
    const cfg: VisorConfig = {
      version: '1',
      output: { format: 'json' },
      checks: {
        a: { type: 'log', message: 'hi' },
        b: { type: 'log', message: 'there', criticality: 'external' },
      },
    } as any;

    const ctx = buildEngineContextForRun(process.cwd(), cfg, {
      eventType: 'manual',
      owner: 'o',
      repo: 'r',
      prNumber: 0,
      branch: 'main',
      baseSha: 'x',
      headSha: 'y',
      commitMessage: '',
    } as any);

    expect(ctx.config.checks!.a!.criticality).toBe('policy');
    expect(ctx.config.checks!.b!.criticality).toBe('external');
  });
});
