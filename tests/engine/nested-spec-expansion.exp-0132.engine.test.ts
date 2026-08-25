import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ExecutionContext,
} from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

const prInfo = {
  number: 132,
  title: 'Two-level scoped keyed expansion',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function fixtureConfig(): VisorConfig {
  const fixture = path.join(
    __dirname,
    '../fixtures/graph-v2/nested-spec-expansion.yaml'
  );
  return yaml.load(fs.readFileSync(fixture, 'utf8')) as VisorConfig;
}

describe('EXP-0132 two-level scoped keyed expansion', () => {
  const registry = CheckProviderRegistry.getInstance();
  const originalNoop = registry.getProviderOrThrow('noop');
  let engine: StateMachineExecutionEngine;
  let bEnumerationGate: ReturnType<typeof deferred>;
  let spec2ReviewGate: ReturnType<typeof deferred>;
  let spec1Review2Gate: ReturnType<typeof deferred>;
  let bEnumerationStarted: ReturnType<typeof deferred>;
  let spec2ReviewStarted: ReturnType<typeof deferred>;
  let spec1Review2Started: ReturnType<typeof deferred>;
  let bEnumerationCompleted: boolean;
  let activeProviders: number;
  let peakProviders: number;
  let calls: Array<{
    checkId: string;
    component?: string;
    spec?: string;
    aliases: string[];
    scope: unknown;
    scheduled: boolean;
    historySize: number;
  }>;

  class ControlledNoopProvider extends CheckProvider {
    getName() { return 'noop'; }
    getDescription() { return 'EXP-0132 deterministic fake'; }
    async validateConfig() { return true; }
    async isAvailable() { return true; }
    getRequirements() { return []; }
    getSupportedConfigKeys() { return ['type']; }

    async execute(
      _pr: PRInfo,
      config: CheckProviderConfig,
      _dependencies?: Map<string, ReviewSummary>,
      context?: ExecutionContext
    ): Promise<ReviewSummary> {
      const checkId = String(config.checkName);
      const claims = context?.claims || {};
      const aliases = Object.keys(claims).sort();
      const claim = Object.values(claims)[0];
      const payload = claim?.payload as { id?: string } | undefined;
      const scope = context?.scope as readonly Array<{ key?: string }> | undefined;
      const component = scope?.[0]?.key;
      const spec = scope?.[1]?.key || (scope?.length === 2 ? payload?.id : undefined);
      const journal = (engine as any)._lastContext.journal;
      calls.push({
        checkId,
        ...(component ? { component } : {}),
        ...(spec ? { spec } : {}),
        aliases,
        scope,
        scheduled: journal.readRuntimeEvents().some(
          (event: any) =>
            event.type === 'CheckScheduled' &&
            event.nodeGenerationId === context?.nodeGenerationId
        ),
        historySize: (config.__outputHistory as Map<string, unknown[]> | undefined)?.size ?? -1,
      });

      activeProviders++;
      peakProviders = Math.max(peakProviders, activeProviders);
      try {
        if (checkId === 'discover-components') {
          return {
            issues: [],
            output: {
              components: [
                { id: 'A', path: 'packages/a', revision: 1 },
                { id: 'B', path: 'packages/b', revision: 1 },
              ],
            },
          };
        }
        if (checkId === 'enumerate-spec-work') {
          if (component === 'B') {
            bEnumerationStarted.resolve();
            await bEnumerationGate.promise;
            bEnumerationCompleted = true;
          }
          return {
            issues: [],
            output: {
              specs: component === 'A'
                ? [
                    { id: 'spec-1', revision: 1, source: 'A/one' },
                    { id: 'spec-2', revision: 1, source: 'A/two' },
                  ]
                : [{ id: 'spec-1', revision: 1, source: 'B/one' }],
            },
          };
        }
        if (checkId === 'spec-review-1' && spec === 'spec-2') {
          spec2ReviewStarted.resolve();
          await spec2ReviewGate.promise;
        }
        if (checkId === 'spec-review-2' && component === 'A' && spec === 'spec-1') {
          spec1Review2Started.resolve();
          await spec1Review2Gate.promise;
        }
        return { issues: [], output: { id: spec, stage: checkId } };
      } finally {
        activeProviders--;
      }
    }
  }

  beforeEach(() => {
    engine = new StateMachineExecutionEngine();
    bEnumerationGate = deferred();
    spec2ReviewGate = deferred();
    spec1Review2Gate = deferred();
    bEnumerationStarted = deferred();
    spec2ReviewStarted = deferred();
    spec1Review2Started = deferred();
    bEnumerationCompleted = false;
    activeProviders = 0;
    peakProviders = 0;
    calls = [];
    registry.unregister('noop');
    registry.register(new ControlledNoopProvider());
  });

  afterEach(() => {
    registry.unregister('noop');
    registry.register(originalNoop);
  });

  it('pipelines exact component/spec scopes through one global bounded ready queue', async () => {
    const config = fixtureConfig();
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-components'],
      undefined,
      config,
      'table',
      false,
      3
    );

    await bEnumerationStarted.promise;
    await spec2ReviewStarted.promise;
    await spec1Review2Started.promise;
    expect(bEnumerationCompleted).toBe(false);
    expect(activeProviders).toBe(3);

    spec2ReviewGate.resolve();
    bEnumerationGate.resolve();
    spec1Review2Gate.resolve();
    await run;

    const journal = (engine as any)._lastContext.journal;
    const events = journal.readRuntimeEvents() as readonly any[];
    const projection = journal.getInstanceProjection();
    const nestedSpec1 = Object.values(projection.instancesById).filter(
      (instance: any) => instance.scope.length === 2 && instance.itemKey === 'spec-1'
    ) as any[];
    expect(nestedSpec1).toHaveLength(2);
    expect(nestedSpec1[0].subgraphInstanceId).not.toBe(nestedSpec1[1].subgraphInstanceId);
    expect(nestedSpec1.map(instance => instance.scope[0].key).sort()).toEqual(['A', 'B']);
    expect(peakProviders).toBe(3);
    expect(calls.every(call => call.scheduled)).toBe(true);

    const specCalls = calls.filter(call => call.scope && (call.scope as any[]).length === 2);
    expect(specCalls.length).toBeGreaterThan(0);
    expect(specCalls.every(call => call.aliases.length === 1)).toBe(true);
    expect(specCalls.every(call => call.historySize === 0)).toBe(true);
    expect(specCalls.every(call => (call.scope as any[])[0].key === call.component)).toBe(true);
    expect(specCalls.every(call => (call.scope as any[])[1].key === call.spec)).toBe(true);

    for (const expanded of events.filter(
      event => event.type === 'SubgraphExpanded' && event.scope.length === 2
    )) {
      const catalogIndex = events.findIndex(
        event => event.type === 'ClaimPublished' && event.claimId === expanded.catalogClaimId
      );
      const activationIndex = events.findIndex(
        event =>
          event.type === 'NodeGenerationActivated' &&
          event.subgraphInstanceId === expanded.subgraphInstanceId
      );
      expect(catalogIndex).toBeGreaterThanOrEqual(0);
      expect(activationIndex).toBeGreaterThan(catalogIndex);
    }
    expect(journal.replayInstanceProjection()).toEqual(projection);
  });
});
