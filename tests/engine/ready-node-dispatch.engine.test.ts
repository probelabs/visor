import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProvider } from '../../src/providers/check-provider.interface';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { projectWorkflowToGraph } from '../../src/state-machine/workflow-projection';
import type { CheckProviderConfig, ExecutionContext } from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import type { WorkflowDefinition } from '../../src/types/workflow';

class ReadyTestProvider extends CheckProvider {
  readonly events: string[] = [];
  readonly durations: Record<string, number> = {};
  readonly failures = new Set<string>();
  active = 0;
  peak = 0;

  getName(): string {
    return 'ready-test-provider';
  }

  getDescription(): string {
    return 'Deterministic in-process provider for ready dispatch tests.';
  }

  async validateConfig(): Promise<boolean> {
    return true;
  }

  async execute(
    _prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencies?: Map<string, ReviewSummary>,
    _context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const checkId = String(config.checkName);
    this.events.push(`start:${checkId}`);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise(resolve => setTimeout(resolve, this.durations[checkId] || 0));
    this.active--;
    this.events.push(`finish:${checkId}`);
    if (this.failures.has(checkId)) throw new Error(`deterministic failure: ${checkId}`);
    return { issues: [], output: { checkId } };
  }
}

const provider = new ReadyTestProvider();
const registry = CheckProviderRegistry.getInstance();
registry.register(provider);

const prInfo = {
  number: 1,
  title: 'ready dispatch test',
  author: 'test',
  base: 'main',
  head: 'test',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function baseConfig(checks: Record<string, any>, ready = true): VisorConfig {
  return {
    version: '1.0',
    checks,
    output: { format: 'json' },
    workspace: { enabled: false },
    ...(ready
      ? {
          ['x-visor']: { dispatch: 'ready', unsupported: 'error' },
          ['x-governance']: { owner: 'experiment' },
        }
      : {}),
  } as any;
}

async function run(
  config: VisorConfig,
  checks: string[],
  maxParallelism = 2,
  failFast = false
) {
  const engine = new StateMachineExecutionEngine();
  return engine.executeGroupedChecks(
    prInfo,
    checks,
    undefined,
    config,
    'json',
    false,
    maxParallelism,
    failFast
  );
}

beforeEach(() => {
  provider.events.length = 0;
  provider.active = 0;
  provider.peak = 0;
  for (const key of Object.keys(provider.durations)) delete provider.durations[key];
  provider.failures.clear();
});

afterAll(() => {
  registry.unregister(provider.getName());
});

describe('experimental ready-node dispatch', () => {
  it('admits descendants early, waits at joins, and respects maxParallelism', async () => {
    provider.durations.root = 10;
    provider.durations.slow = 70;
    provider.durations.fastChild = 10;
    provider.durations.slowChild = 10;
    const config = baseConfig({
      root: { type: provider.getName() },
      slow: { type: provider.getName() },
      fastChild: { type: provider.getName(), depends_on: ['root'] },
      slowChild: { type: provider.getName(), depends_on: ['slow'] },
      join: {
        type: provider.getName(),
        depends_on: ['fastChild', 'slowChild'],
      },
    });

    await run(config, ['root', 'slow', 'fastChild', 'slowChild', 'join']);

    const fastStart = provider.events.indexOf('start:fastChild');
    const slowFinish = provider.events.indexOf('finish:slow');
    expect(fastStart).toBeGreaterThan(-1);
    expect(fastStart).toBeLessThan(slowFinish);
    expect(provider.events.indexOf('start:join')).toBeGreaterThan(
      Math.max(provider.events.indexOf('finish:fastChild'), provider.events.indexOf('finish:slowChild'))
    );
    expect(provider.peak).toBeLessThanOrEqual(2);
  });

  it('preserves the old level barrier when opt-in is absent', async () => {
    provider.durations.root = 10;
    provider.durations.slow = 50;
    provider.durations.fastChild = 1;
    const config = baseConfig(
      {
        root: { type: provider.getName() },
        slow: { type: provider.getName() },
        fastChild: { type: provider.getName(), depends_on: ['root'] },
      },
      false
    );

    await run(config, ['root', 'slow', 'fastChild']);

    expect(provider.events.indexOf('start:fastChild')).toBeGreaterThan(
      provider.events.indexOf('finish:slow')
    );
  });

  it('fails closed for OR and routing constructs before executing checks', async () => {
    const cases = [
      {
        checks: {
          root: { type: provider.getName() },
          child: { type: provider.getName(), depends_on: ['root|other'] },
          other: { type: provider.getName() },
        },
        expected: 'OR dependency',
      },
      {
        checks: {
          root: { type: provider.getName(), on_success: { run: ['other'] } },
          other: { type: provider.getName() },
        },
        expected: 'on_success.run',
      },
    ];

    for (const testCase of cases) {
      provider.events.length = 0;
      await expect(run(baseConfig(testCase.checks), Object.keys(testCase.checks))).rejects.toThrow(
        new RegExp(`Ready dispatch unsupported.*${testCase.expected}`)
      );
      expect(provider.events).toEqual([]);
    }
  });

  it('fails closed when a raw dependency is absent from the queued graph', async () => {
    const config = {
      ...baseConfig({
        otherRoot: { type: provider.getName(), tags: ['keep'] },
        child: { type: provider.getName(), tags: ['keep'], depends_on: ['filteredRoot'] },
        filteredRoot: { type: provider.getName(), tags: ['drop'] },
      }),
      tag_filter: { include: ['keep'] },
    } as VisorConfig;

    await expect(run(config, ['otherRoot', 'child', 'filteredRoot'])).rejects.toThrow(
      /outside the queued graph/
    );
    expect(provider.events).toEqual([]);
  });

  it('fails closed for human-input nodes before launching any check', async () => {
    const config = baseConfig({
      root: { type: provider.getName() },
      ask: { type: 'human-input' },
    });

    await expect(run(config, ['root', 'ask'])).rejects.toThrow(/human-input\/pause-capable/);
    expect(provider.events).toEqual([]);
  });

  it('stops admissions on fail-fast while allowing running work to settle', async () => {
    provider.durations.bad = 10;
    provider.durations.slow = 60;
    provider.failures.add('bad');
    const config = baseConfig({
      bad: { type: provider.getName() },
      slow: { type: provider.getName() },
      never: { type: provider.getName() },
      dependent: { type: provider.getName(), depends_on: ['bad'] },
    });

    await run(config, ['bad', 'slow', 'never', 'dependent'], 2, true);

    expect(provider.events).toContain('start:bad');
    expect(provider.events).toContain('start:slow');
    expect(provider.events).toContain('finish:slow');
    expect(provider.events).not.toContain('start:never');
    expect(provider.events).not.toContain('start:dependent');
  });

  it('propagates x-visor into a projected child workflow config', () => {
    const workflow = {
      id: 'child',
      name: 'Child',
      ['x-visor']: { dispatch: 'ready', unsupported: 'error' },
      steps: { one: { type: provider.getName() } },
    } as WorkflowDefinition;

    const { config } = projectWorkflowToGraph(workflow, {}, 'parent');
    expect((config as any)['x-visor']).toEqual({ dispatch: 'ready', unsupported: 'error' });
  });
});
