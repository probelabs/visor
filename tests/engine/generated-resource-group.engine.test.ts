import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext } from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';

const prInfo = {
  number: 901,
  title: 'Generated resource groups',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

type RunEvent = {
  type: 'start' | 'finish' | 'fail';
  checkId: string;
  component?: string;
};

type ProviderControls = {
  failAuthorA?: boolean;
  authorStarted?: (component: string) => void;
  secondAuthorStartedPromise?: Promise<void>;
  releaseSecondAuthor?: Promise<void>;
  reviewAStarted?: () => void;
  releaseReviewA?: Promise<void>;
  prepareValidationFinished?: (component: string) => void;
  prepareValidationFinishedPromise?: Promise<void>;
};

function baseConfig(): VisorConfig {
  const fixture = path.join(__dirname, '../fixtures/graph-v2/nested-spec-expansion.yaml');
  const config = yaml.load(fs.readFileSync(fixture, 'utf8')) as VisorConfig;
  config.max_parallelism = 2;

  const reviewSpec = config.subgraphs!['review-spec'] as any;
  reviewSpec.checks['author-or-refresh'].resource_group = 'component-writers';
  reviewSpec.checks['validate-authored'] = {
    type: 'noop',
    resource_group: 'component-writers',
    consumes: [{ claim: 'spec-work.validation-input@1', as: 'validation_input' }],
    emits: [{ claim: 'spec-work.validated@1', from: 'output' }],
  };
  reviewSpec.checks['prepare-validation'] = {
    type: 'noop',
    consumes: [{ claim: 'spec-work.authored@1', as: 'authored' }],
    emits: [{ claim: 'spec-work.validation-input@1', from: 'output' }],
  };
  reviewSpec.checks['audit-authored'] = {
    type: 'noop',
    consumes: [{ claim: 'spec-work.authored@1', as: 'authored' }],
    emits: [{ claim: 'spec-work.audit@1', from: 'output' }],
  };
  config.claim_types!['spec-work.audit@1'] = config.claim_types!['spec-work.authored@1'];
  config.claim_types!['spec-work.validation-input@1'] = config.claim_types!['spec-work.authored@1'];
  config.claim_types!['spec-work.validated@1'] = config.claim_types!['spec-work.authored@1'];
  return config;
}

function scopeComponent(context?: ExecutionContext): string | undefined {
  return (context?.scope as any[] | undefined)?.find(entry =>
    entry && (entry.key === 'A' || entry.key === 'B')
  )?.key;
}

class ResourceGroupProvider extends CheckProvider {
  private firstAuthorComponent?: string;

  constructor(
    private readonly events: RunEvent[],
    private readonly options: ProviderControls = {}
  ) {
    super();
  }

  getName() { return 'noop'; }
  getDescription() { return 'resource-group deterministic test provider'; }
  async validateConfig() { return true; }
  async isAvailable() { return true; }
  getRequirements() { return []; }
  getSupportedConfigKeys() { return ['type', 'resource_group']; }

  async execute(
    _pr: PRInfo,
    config: CheckProviderConfig,
    _dependencies?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const checkId = String(config.checkName);
    const component = scopeComponent(context);
    const claims = Object.values(context?.claims || {});
    const payload = claims[0]?.payload as { id?: string } | undefined;
    const id = payload?.id || component || checkId;
    const event = { checkId, ...(component ? { component } : {}) } as RunEvent;

    if (checkId === 'discover-components') {
      return { issues: [], output: { components: [
        { id: 'B', path: 'packages/b', revision: 1 },
        { id: 'A', path: 'packages/a', revision: 1 },
      ] } };
    }
    if (checkId === 'enumerate-spec-work') {
      return { issues: [], output: { specs: [{ id: 'spec-1', revision: 1, source: `${component}/one` }] } };
    }

    if (checkId === 'author-or-refresh' && component && !this.firstAuthorComponent) {
      this.firstAuthorComponent = component;
    }
    const waitsForSecondAuthor = (checkId === 'prepare-validation' || checkId === 'spec-review-1') &&
      component === this.firstAuthorComponent && this.options.secondAuthorStartedPromise;
    if (checkId === 'spec-review-1' && component === this.firstAuthorComponent) {
      if (this.options.secondAuthorStartedPromise) await this.options.secondAuthorStartedPromise;
      if (this.options.prepareValidationFinishedPromise) await this.options.prepareValidationFinishedPromise;
    }
    this.events.push({ type: 'start', ...event });
    try {
      if (checkId === 'prepare-validation' && waitsForSecondAuthor) await waitsForSecondAuthor;
      if (checkId === 'author-or-refresh' && component) {
        this.options.authorStarted?.(component);
      }
      if (checkId === 'author-or-refresh' && component && component !== this.firstAuthorComponent &&
          this.options.releaseSecondAuthor) {
        await this.options.releaseSecondAuthor;
      }
      if (checkId === 'spec-review-1' && component === this.firstAuthorComponent && this.options.releaseReviewA) {
        this.options.reviewAStarted?.();
        await this.options.releaseReviewA;
      }
      if (this.options.failAuthorA && checkId === 'author-or-refresh' && component === 'A') {
        throw new Error('synthetic author failure');
      }
      this.events.push({ type: 'finish', ...event });
      if (checkId === 'prepare-validation' && component) {
        const finished = this.options.prepareValidationFinished;
        if (finished) setImmediate(() => finished(component));
      }
      return { issues: [], output: { id, stage: checkId } };
    } catch (error) {
      this.events.push({ type: 'fail', ...event });
      throw error;
    }
  }
}

async function run(
  config: VisorConfig,
  provider: ResourceGroupProvider,
  onEngine?: (engine: StateMachineExecutionEngine) => void
) {
  const registry = CheckProviderRegistry.getInstance();
  const original = registry.getProviderOrThrow('noop');
  registry.unregister('noop');
  registry.register(provider);
  try {
    const engine = new StateMachineExecutionEngine();
    onEngine?.(engine);
    await engine.executeGroupedChecks(prInfo, ['discover-components'], undefined, config, 'table', false, 3);
    return { engine, journal: (engine as any)._lastContext.journal };
  } finally {
    registry.unregister('noop');
    registry.register(original);
  }
}

describe('Graph-v2 generated resource groups', () => {
  it('serializes grouped writer/validation while an ungrouped review uses capacity', async () => {
    const events: RunEvent[] = [];
    let authorSecondResolve!: () => void;
    let reviewAResolve!: () => void;
    let secondAuthorStartedResolve!: () => void;
    const authorSecondRelease = new Promise<void>(resolve => { authorSecondResolve = resolve; });
    const reviewARelease = new Promise<void>(resolve => { reviewAResolve = resolve; });
    const secondAuthorStartedPromise = new Promise<void>(resolve => { secondAuthorStartedResolve = resolve; });
    let firstAuthorComponent: string | undefined;
    let secondAuthorComponent: string | undefined;
    let secondAuthorStarted = false;
    let liveEngine!: StateMachineExecutionEngine;
    let reviewAStartedResolve!: () => void;
    const reviewAStartedPromise = new Promise<void>(resolve => { reviewAStartedResolve = resolve; });
    let prepareValidationFinishedResolve!: () => void;
    const prepareValidationFinishedPromise = new Promise<void>(resolve => { prepareValidationFinishedResolve = resolve; });
    const provider = new ResourceGroupProvider(events, {
      releaseSecondAuthor: authorSecondRelease,
      secondAuthorStartedPromise,
      authorStarted: component => {
        if (!firstAuthorComponent) firstAuthorComponent = component;
        else if (!secondAuthorComponent && component !== firstAuthorComponent) {
          secondAuthorComponent = component;
          secondAuthorStarted = true;
          secondAuthorStartedResolve();
        }
      },
      releaseReviewA: reviewARelease,
      reviewAStarted: reviewAStartedResolve,
      prepareValidationFinishedPromise,
      prepareValidationFinished: component => {
        if (component === firstAuthorComponent) prepareValidationFinishedResolve();
      },
    });

    const runPromise = run(baseConfig(), provider, engine => { liveEngine = engine; });
    await Promise.all([secondAuthorStartedPromise, reviewAStartedPromise]);

    // B's grouped author is executing while A's ungrouped review is executing.
    // A's grouped validation is ready but must not have an attempt yet.
    const validationAStarted = events.some(event =>
      event.type === 'start' && event.checkId === 'validate-authored' && event.component === firstAuthorComponent
    );
    expect(validationAStarted).toBe(false);
    expect(secondAuthorStarted).toBe(true);
    expect(secondAuthorStarted).toBe(true);
    expect(liveEngine).toBeDefined();
    const liveJournal = (liveEngine as any)._lastContext.journal;
    const validationGeneration = Object.values(liveJournal.getInstanceProjection().generationsById)
      .find((generation: any) => generation.checkId === 'validate-authored' &&
        generation.status === 'ready' &&
        generation.scope.some((entry: any) => entry.key === firstAuthorComponent));
    expect(validationGeneration).toBeDefined();
    expect(liveJournal.readRuntimeEvents().some((event: any) =>
      event.type === 'AttemptStarted' && event.nodeGenerationId === (validationGeneration as any).nodeGenerationId
    )).toBe(false);
    const starts = events.filter(event => event.type === 'start');
    const groupedStarts = starts.filter(event => event.checkId === 'author-or-refresh' || event.checkId === 'validate-authored');
    let activeGrouped = 0;
    for (const event of events) {
      const grouped = event.checkId === 'author-or-refresh' || event.checkId === 'validate-authored';
      if (!grouped) continue;
      if (event.type === 'start') {
        activeGrouped++;
        expect(activeGrouped).toBe(1);
      } else {
        activeGrouped--;
      }
    }
    const authorSecondStart = events.findIndex(event =>
      event.type === 'start' && event.checkId === 'author-or-refresh' && event.component === secondAuthorComponent
    );
    const authorSecondFinish = events.findIndex(event =>
      event.type === 'finish' && event.checkId === 'author-or-refresh' && event.component === secondAuthorComponent
    );
    const reviewAStart = events.findIndex(event =>
      event.type === 'start' && event.checkId === 'spec-review-1' && event.component === firstAuthorComponent
    );
    expect(authorSecondStart).toBeGreaterThanOrEqual(0);
    expect(reviewAStart).toBeGreaterThan(authorSecondStart);
    expect(authorSecondFinish).toBe(-1);
    authorSecondResolve();
    reviewAResolve();
    await runPromise;
    expect(events.findIndex(event =>
      event.type === 'finish' && event.checkId === 'author-or-refresh' && event.component === secondAuthorComponent
    )).toBeGreaterThan(authorSecondStart);
    expect(groupedStarts.filter(event => event.component === firstAuthorComponent)).toHaveLength(1);
  });

  it('releases a grouped writer after failure so the sibling writer can run', async () => {
    const events: RunEvent[] = [];
    await run(baseConfig(), new ResourceGroupProvider(events, { failAuthorA: true }));
    const authorStarts = events.filter(event => event.type === 'start' && event.checkId === 'author-or-refresh');
    const authorFailures = events.filter(event => event.type === 'fail' && event.checkId === 'author-or-refresh');
    expect(authorStarts.map(event => event.component).sort()).toEqual(['A', 'B']);
    expect(authorFailures.map(event => event.component)).toContain('A');
  });

  it('binds resource-group and execution-profile policy into the compiled config digest', () => {
    const baseline = compileClaimPlan(baseConfig());
    const resourceOnly = baseConfig();
    (resourceOnly.subgraphs!['review-spec'] as any).checks['author-or-refresh'].resource_group = 'other-group';
    const resourcePlan = compileClaimPlan(resourceOnly);
    const profileOnly = baseConfig();
    (profileOnly.subgraphs!['review-spec'] as any).checks['author-or-refresh'].ai = {
      model: 'gpt-5.6-luna',
      codex_execution_profile: 'luna-xhigh-readonly-v1',
    };
    const profilePlan = compileClaimPlan(profileOnly);
    const baselineDigest = baseline.expansionPlan.templatesByName['review-spec']
      .nodesByKey['author-or-refresh'].executionConfigDigest;
    const resourceDigest = resourcePlan.expansionPlan.templatesByName['review-spec']
      .nodesByKey['author-or-refresh'].executionConfigDigest;
    const profileDigest = profilePlan.expansionPlan.templatesByName['review-spec']
      .nodesByKey['author-or-refresh'].executionConfigDigest;
    expect(resourceDigest).not.toBe(baselineDigest);
    expect(profileDigest).not.toBe(baselineDigest);
  });

  it('rejects resource_group on a non-generated check before provider execution', async () => {
    const config = baseConfig();
    (config.checks!['discover-components'] as any).resource_group = 'static-group';
    const events: RunEvent[] = [];
    await expect(run(config, new ResourceGroupProvider(events)))
      .rejects.toThrow('outside a Graph-v2 subgraph template');
    expect(events).toHaveLength(0);
  });
});
