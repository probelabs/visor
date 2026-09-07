import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
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
  const fixture = path.join(__dirname, '../fixtures/graph-v2/nested-spec-expansion.yaml');
  return yaml.load(fs.readFileSync(fixture, 'utf8')) as VisorConfig;
}

/**
 * Derive the project/component/spec graph from the existing Graph-v2 fixture
 * so the depth-three checks still use the production claim-plan compiler.
 * The original fixture remains the two-level regression below.
 */
function depthThreeConfig(): VisorConfig {
  const config = JSON.parse(JSON.stringify(fixtureConfig())) as any;
  config.claim_types['project.catalog@1'] = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: {
        projects: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
  };
  config.claim_types['project.item@1'] = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
      },
    },
  };
  config.claim_types['component.authored@1'] = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'stage'],
      properties: {
        id: { type: 'string', minLength: 1 },
        stage: { type: 'string', minLength: 1 },
      },
    },
  };
  config.claim_types['spec-work.review@1'] = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'stage'],
      properties: {
        id: { type: 'string', minLength: 1 },
        stage: { type: 'string', minLength: 1 },
      },
    },
  };

  config.subgraphs = {
    project: {
      input: { name: 'project', claim: 'project.item@1' },
      checks: {
        'materialize-components': {
          type: 'noop',
          consumes: [{ claim: 'project.item@1', as: 'project' }],
          emits: [{ claim: 'component.catalog@1', from: 'output' }],
          expand: {
            claim: 'component.catalog@1',
            template: 'onboard-component',
            items_pointer: '/components',
            key_pointer: '/id',
            item_claim: 'component.item@1',
          },
        },
      },
    },
    'onboard-component': {
      input: { name: 'component', claim: 'component.item@1' },
      checks: {
        'author-component': {
          type: 'noop',
          consumes: [{ claim: 'component.item@1', as: 'component' }],
          emits: [{ claim: 'component.authored@1', from: 'output' }],
        },
        'enumerate-spec-work': {
          type: 'noop',
          consumes: [{ claim: 'component.authored@1', as: 'authored' }],
          emits: [{ claim: 'spec-work.catalog@1', from: 'output' }],
          expand: {
            claim: 'spec-work.catalog@1',
            template: 'review-spec',
            items_pointer: '/specs',
            key_pointer: '/id',
            item_claim: 'spec-work.item@1',
          },
        },
        'component-fan-in': {
          type: 'noop',
          depends_on: 'enumerate-spec-work',
          wait_for_expansion: {
            owner: 'enumerate-spec-work',
            terminal_node: 'spec-review',
          },
        },
      },
    },
    'review-spec': {
      input: { name: 'spec', claim: 'spec-work.item@1' },
      checks: {
        'spec-review': {
          type: 'noop',
          consumes: [{ claim: 'spec-work.item@1', as: 'spec' }],
          emits: [{ claim: 'spec-work.review@1', from: 'output' }],
        },
      },
    },
  };
  config.checks = {
    'discover-projects': {
      type: 'noop',
      emits: [{ claim: 'project.catalog@1', from: 'output' }],
      expand: {
        claim: 'project.catalog@1',
        template: 'project',
        items_pointer: '/projects',
        key_pointer: '/id',
        item_claim: 'project.item@1',
      },
    },
  };
  return config as VisorConfig;
}

// The continuation child is deliberately an inline fixture so this test
// exercises a new Node process without adding a second harness or a runtime
// dependency. It uses the same compiled StateMachineExecutionEngine and only
// replaces the deterministic noop provider.
const depthThreeChildSource = String.raw`
const fs = require('fs');
const path = require('path');
const { StateMachineExecutionEngine } = require(path.join(process.cwd(), 'src/state-machine-execution-engine'));
const { CheckProviderRegistry } = require(path.join(process.cwd(), 'src/providers/check-provider-registry'));
const { CheckProvider } = require(path.join(process.cwd(), 'src/providers/check-provider.interface'));

const mode = process.env.DEPTH3_MODE;
const directory = process.env.DEPTH3_DIRECTORY;
const configPath = process.env.DEPTH3_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const prInfo = { number: 132, title: 'depth three continuation', author: 'test', base: 'main', head: 'candidate', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' };
const calls = [];

class DepthThreeChildProvider extends CheckProvider {
  getName() { return 'noop'; }
  getDescription() { return 'EXP-0132 continuation child'; }
  async validateConfig() { return true; }
  async isAvailable() { return true; }
  getRequirements() { return []; }
  getSupportedConfigKeys() { return ['type']; }
  async execute(_pr, providerConfig, _dependencies, context) {
    const checkId = String(providerConfig.checkName);
    const scope = context && context.scope || [];
    calls.push({ checkId, scope });
    const component = scope[1] && scope[1].key;
    const spec = scope[2] && scope[2].key;
    if (checkId === 'discover-projects') {
      return { issues: [], output: { projects: [{ id: 'P' }] } };
    }
    if (checkId === 'materialize-components') {
      return { issues: [], output: { components: [
        { id: 'A', path: 'packages/a', revision: 1 },
        { id: 'B', path: 'packages/b', revision: 1 },
      ] } };
    }
    if (checkId === 'enumerate-spec-work') {
      return { issues: [], output: { specs: [{ id: 'spec-' + component, revision: 1, source: component + '/one' }] } };
    }
    return { issues: [], output: { id: component || spec, stage: checkId } };
  }
}

async function main() {
  const registry = CheckProviderRegistry.getInstance();
  const previous = registry.getProvider('noop');
  if (previous) registry.unregister('noop');
  registry.register(new DepthThreeChildProvider());
  try {
    const engine = new StateMachineExecutionEngine(process.cwd());
    if (mode === 'pause') {
      const gate = generation =>
        generation.scope.length === 3 && generation.scope[1].key === 'A'
          ? 'defer'
          : 'dispatch';
      await engine.executeGroupedChecks(prInfo, ['discover-projects'], undefined, config, undefined, false, 4, false, undefined, gate);
      const context = engine._lastContext;
      const checkpoint = JSON.parse(JSON.stringify(context.journal.exportGraphCheckpoint(context.sessionId)));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'paused.json'), JSON.stringify({ pid: process.pid, checkpoint, calls, projection: context.journal.getInstanceProjection(), events: context.journal.readRuntimeEvents() }));
    } else if (mode === 'resume') {
      const paused = JSON.parse(fs.readFileSync(path.join(directory, 'paused.json'), 'utf8'));
      const resumed = await engine.resumeGraphCheckpoint({ checkpoint: paused.checkpoint, config, prInfo, maxParallelism: 4 });
      fs.writeFileSync(path.join(directory, 'resumed.json'), JSON.stringify({ pid: process.pid, checkpoint: resumed.checkpoint, calls, projection: engine.getInstanceProjection(), events: engine._lastContext.journal.readRuntimeEvents() }));
    } else {
      throw new Error('unknown depth-three child mode');
    }
  } finally {
    registry.unregister('noop');
    if (previous) registry.register(previous);
  }
}
main().catch(error => { process.stderr.write(String(error && error.stack || error) + '\\n'); process.exitCode = 1; });
`;

function runDepthThreeChild(mode: 'pause' | 'resume', directory: string, configPath: string): void {
  execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', depthThreeChildSource],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: '1',
        DEPTH3_MODE: mode,
        DEPTH3_DIRECTORY: directory,
        DEPTH3_CONFIG: configPath,
      },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: 'pipe',
    }
  );
}

describe('EXP-0132 nested scoped keyed expansion', () => {
  const registry = CheckProviderRegistry.getInstance();
  const originalNoop = registry.getProviderOrThrow('noop');
  let engine: StateMachineExecutionEngine;
  let bEnumerationGate: ReturnType<typeof deferred>;
  let spec2ReviewGate: ReturnType<typeof deferred>;
  let spec1Review2Gate: ReturnType<typeof deferred>;
  let bEnumerationStarted: ReturnType<typeof deferred>;
  let spec2ReviewStarted: ReturnType<typeof deferred>;
  let spec1Review2Started: ReturnType<typeof deferred>;
  let bComponentAuthorGate: ReturnType<typeof deferred>;
  let bComponentAuthorStarted: ReturnType<typeof deferred>;
  let aSpecReviewStarted: ReturnType<typeof deferred>;
  let bEnumerationCompleted: boolean;
  let bComponentAuthorCompleted: boolean;
  let deepTopology: boolean;
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
    specReviewsBefore?: number;
  }>;

  class ControlledNoopProvider extends CheckProvider {
    getName() {
      return 'noop';
    }
    getDescription() {
      return 'EXP-0132 deterministic fake';
    }
    async validateConfig() {
      return true;
    }
    async isAvailable() {
      return true;
    }
    getRequirements() {
      return [];
    }
    getSupportedConfigKeys() {
      return ['type'];
    }

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
      const component = scope?.[deepTopology ? 1 : 0]?.key;
      const spec = scope?.[deepTopology ? 2 : 1]?.key ||
        (!deepTopology && scope?.length === 2 ? payload?.id : undefined);
      const detail = scope?.[2]?.key;
      const specReviewsBefore = checkId === 'component-fan-in'
        ? calls.filter(call => call.checkId === 'spec-review' && call.component === component).length
        : undefined;
      const journal = (engine as any)._lastContext.journal;
      calls.push({
        checkId,
        ...(component ? { component } : {}),
        ...(spec ? { spec } : {}),
        ...(detail ? { detail } : {}),
        aliases,
        scope,
        scheduled: journal
          .readRuntimeEvents()
          .some(
            (event: any) =>
              event.type === 'CheckScheduled' &&
              event.nodeGenerationId === context?.nodeGenerationId
          ),
        historySize: (config.__outputHistory as Map<string, unknown[]> | undefined)?.size ?? -1,
        ...(specReviewsBefore !== undefined ? { specReviewsBefore } : {}),
      });

      activeProviders++;
      peakProviders = Math.max(peakProviders, activeProviders);
      try {
        if (deepTopology && checkId === 'discover-projects') {
          return {
            issues: [],
            output: { projects: [{ id: 'P' }] },
          };
        }
        if (deepTopology && checkId === 'materialize-components') {
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
        if (!deepTopology && checkId === 'discover-components') {
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
        if (deepTopology && checkId === 'author-component' && component === 'B') {
          bComponentAuthorStarted.resolve();
          await bComponentAuthorGate.promise;
          bComponentAuthorCompleted = true;
        }
        if (deepTopology && checkId === 'enumerate-spec-work') {
          return {
            issues: [],
            output: {
              specs: [{ id: `spec-${component}`, revision: 1, source: `${component}/one` }],
            },
          };
        }
        if (!deepTopology && checkId === 'enumerate-spec-work') {
          if (component === 'B') {
            bEnumerationStarted.resolve();
            await bEnumerationGate.promise;
            bEnumerationCompleted = true;
          }
          return {
            issues: [],
            output: {
              specs:
                component === 'A'
                  ? [
                      { id: 'spec-1', revision: 1, source: 'A/one' },
                      { id: 'spec-2', revision: 1, source: 'A/two' },
                    ]
                  : [{ id: 'spec-1', revision: 1, source: 'B/one' }],
            },
          };
        }
        if (deepTopology && checkId === 'spec-review' && component === 'A') {
          aSpecReviewStarted.resolve();
        }
        if (deepTopology && checkId === 'component-fan-in') {
          return {
            issues: [],
            output: { component, spec_reviews: specReviewsBefore },
          };
        }
        if (!deepTopology && checkId === 'materialize-spec-details') {
          return {
            issues: [],
            output: {
              details: [
                {
                  id: `detail-${component}-${spec}`,
                  revision: 1,
                  source: `${component}/${spec}/detail`,
                },
              ],
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
        return {
          issues: [],
          output: { id: checkId === 'author-component' ? component : spec, stage: checkId },
        };
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
    bComponentAuthorGate = deferred();
    bEnumerationStarted = deferred();
    spec2ReviewStarted = deferred();
    spec1Review2Started = deferred();
    bComponentAuthorStarted = deferred();
    aSpecReviewStarted = deferred();
    bEnumerationCompleted = false;
    bComponentAuthorCompleted = false;
    deepTopology = false;
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

  it('carries project/component/spec scope lineage while A reviews ahead of held B component author', async () => {
    deepTopology = true;
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-projects'],
      undefined,
      depthThreeConfig(),
      'table',
      false,
      4
    );

    await bComponentAuthorStarted.promise;
    await aSpecReviewStarted.promise;

    // B's component author is still held. A has reached the third expansion
    // level without a dispatch gate or scheduler timing assumption.
    expect(bComponentAuthorCompleted).toBe(false);
    const bAuthorCall = calls.find(
      call => call.checkId === 'author-component' && call.component === 'B'
    );
    expect(bAuthorCall).toBeDefined();
    expect((bAuthorCall!.scope as any[]).map(segment => segment.key)).toEqual(['P', 'B']);
    expect(bAuthorCall!.scope).toHaveLength(2);
    const specCall = calls.find(
      call => call.checkId === 'spec-review' && call.component === 'A'
    );
    expect(specCall).toBeDefined();
    expect(specCall!.scope).toHaveLength(3);
    expect((specCall!.scope as any[]).map(segment => segment.kind)).toEqual([
      'keyed',
      'keyed',
      'keyed',
    ]);
    expect((specCall!.scope as any[]).map(segment => segment.expansionOwnerCheck)).toEqual([
      'discover-projects',
      '["project","materialize-components"]',
      '["onboard-component","enumerate-spec-work"]',
    ]);
    expect((specCall!.scope as any[]).map(segment => segment.key)).toEqual([
      'P', 'A', 'spec-A',
    ]);
    expect((depthThreeConfig() as any).subgraphs['onboard-component'].checks['component-fan-in'])
      .toMatchObject({
        depends_on: 'enumerate-spec-work',
        wait_for_expansion: {
          owner: 'enumerate-spec-work',
          terminal_node: 'spec-review',
        },
      });
    expect((depthThreeConfig() as any).subgraphs['onboard-component'].checks['component-fan-in'].consumes)
      .toBeUndefined();

    bComponentAuthorGate.resolve();
    await run;

    const journal = (engine as any)._lastContext.journal;
    const projection = journal.getInstanceProjection();
    const depthThreeInstances = Object.values(projection.instancesById).filter(
      (instance: any) => instance.scope.length === 3
    ) as any[];
    expect(depthThreeInstances.length).toBeGreaterThan(0);
    for (const instance of depthThreeInstances) {
      const immediateParent = projection.instancesById[instance.parentSubgraphInstanceId];
      expect(immediateParent).toBeDefined();
      expect(immediateParent.scope).toEqual(instance.scope.slice(0, 2));
      expect(instance.parentSubgraphInstanceId).toBe(immediateParent.subgraphInstanceId);
      expect(instance.scope[1].subgraphInstanceId).toBe(immediateParent.subgraphInstanceId);
      expect(instance.scope[0].key).toBe('P');
      expect(instance.scope[1].key).toMatch(/^[AB]$/);
      expect(instance.scope[1].expansionOwnerCheck).toBe(
        '["project","materialize-components"]'
      );
      expect(instance.scope[2].subgraphInstanceId).toBe(instance.subgraphInstanceId);
      expect(instance.scope[2].expansionOwnerCheck).toBe(
        '["onboard-component","enumerate-spec-work"]'
      );
    }
    const fanIns = calls.filter(call => call.checkId === 'component-fan-in');
    expect(fanIns).toHaveLength(2);
    expect(fanIns.map(call => call.specReviewsBefore).sort()).toEqual([1, 1]);
    expect(journal.replayInstanceProjection()).toEqual(projection);
  }, 15_000);

  it('exports a ready depth-three frontier and resumes it in a fresh process', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp-0132-depth3-'));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(depthThreeConfig()), 'utf8');
    try {
      runDepthThreeChild('pause', directory, configPath);
      const paused = JSON.parse(
        fs.readFileSync(path.join(directory, 'paused.json'), 'utf8')
      ) as any;
      const readyDepthThree = Object.values(paused.projection.generationsById).filter(
        (generation: any) => generation.status === 'ready' && generation.scope.length === 3
      ) as any[];
      expect(readyDepthThree).toHaveLength(1);
      expect(readyDepthThree[0].scope.map((segment: any) => segment.key)).toEqual([
        'P', 'A', 'spec-A',
      ]);
      expect(paused.calls.filter((call: any) => call.scope.length === 3)
        .every((call: any) => call.scope[1].key === 'B')).toBe(true);
      expect(
        paused.events.some(
          (event: any) => event.type === 'AttemptStarted' && event.scope.length === 3 &&
            event.scope[1].key === 'A'
        )
      ).toBe(false);

      runDepthThreeChild('resume', directory, configPath);
      const resumed = JSON.parse(
        fs.readFileSync(path.join(directory, 'resumed.json'), 'utf8')
      ) as any;
      expect(resumed.pid).not.toBe(paused.pid);
      expect(resumed.checkpoint.sessionId).toBe(paused.checkpoint.sessionId);
      expect(resumed.checkpoint.graphSemanticDigest).toBe(paused.checkpoint.graphSemanticDigest);
      expect(resumed.checkpoint.events.slice(0, paused.checkpoint.events.length)).toEqual(
        paused.checkpoint.events
      );
      expect(resumed.calls.length).toBeGreaterThan(0);
      expect(resumed.calls.filter(call => call.scope.length === 3).every(
        call => call.checkId === 'spec-review'
      )).toBe(true);
      const resumedSpecCalls = resumed.calls.filter((call: any) => call.scope.length === 3);
      expect(resumedSpecCalls.length).toBeGreaterThan(0);
      expect(resumedSpecCalls.every((call: any) => call.scope[1].key === 'A')).toBe(true);
      expect(resumedSpecCalls.every((call: any) =>
        call.scope[0].key && call.scope[1].key && call.scope[2].key
      )).toBe(true);
      expect(resumed.calls.filter((call: any) => call.scope.length === 2)
        .every((call: any) => call.checkId === 'component-fan-in')).toBe(true);
      expect(resumed.calls.some((call: any) => call.scope.length < 2)).toBe(false);

      const priorEvents = paused.checkpoint.events.length;
      const suffix = resumed.checkpoint.events.slice(priorEvents);
      expect(
        suffix.some((event: any) => event.type === 'AttemptStarted' && event.scope.length === 3)
      ).toBe(true);
      expect(
        suffix.filter((event: any) => event.type === 'AttemptStarted' && event.scope.length === 2)
          .every((event: any) => event.checkId === 'component-fan-in')
      ).toBe(true);
      expect(
        suffix.some((event: any) => event.type === 'AttemptStarted' && event.scope.length < 2)
      ).toBe(false);
      expect(resumed.projection.generationsById).toEqual(
        expect.objectContaining(
          Object.fromEntries(
            readyDepthThree.map(generation => [
              generation.nodeGenerationId,
              expect.objectContaining({ status: 'completed' }),
            ])
          )
        )
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
