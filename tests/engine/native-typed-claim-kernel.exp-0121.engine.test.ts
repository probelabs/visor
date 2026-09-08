import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { CheckProvider, CheckProviderConfig, ExecutionContext } from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const prInfo: PRInfo = {
  number: 1,
  title: 'Graph v2 C1',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function claimConfig(): VisorConfig {
  return {
    version: '1.0',
    max_parallelism: 2,
    workspace: { enabled: false },
    claim_types: {
      'fixture.ready@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'string', const: 'ready' } },
        },
      },
    },
    checks: {
      producer: {
        type: 'noop',
        emits: [{ claim: 'fixture.ready@1', from: 'output' }],
      },
      'slow-sibling': { type: 'noop' },
      consumer: {
        type: 'noop',
        consumes: [{ claim: 'fixture.ready@1', cardinality: 'one' }],
      },
    },
  };
}

describe('EXP-0121 native typed-claim engine', () => {
  const registry = CheckProviderRegistry.getInstance();
  const originalNoop = registry.getProviderOrThrow('noop');
  let engine: StateMachineExecutionEngine;
  let producerOutput: unknown;
  let slowGate: ReturnType<typeof deferred>;
  let slowStarted: ReturnType<typeof deferred>;
  let consumerStarted: ReturnType<typeof deferred>;
  let invocations: string[];
  let consumerClaims: ExecutionContext['claims'];
  let active: number;
  let peakActive: number;
  let scheduleVisibleAtProviderStart: Record<string, boolean>;
  let historyVisibleAtProviderStart: Record<string, boolean>;

  class ControlledNoopProvider extends CheckProvider {
    getName() {
      return 'noop';
    }
    getDescription() {
      return 'EXP-0121 deterministic fake';
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
      return ['type', 'emits', 'consumes'];
    }
    async execute(
      _pr: PRInfo,
      config: CheckProviderConfig,
      _dependencies?: Map<string, ReviewSummary>,
      context?: ExecutionContext
    ): Promise<ReviewSummary> {
      const checkId = String(config.checkName);
      invocations.push(checkId);
      active++;
      peakActive = Math.max(peakActive, active);
      try {
        const runContext = (engine as any)._lastContext;
        scheduleVisibleAtProviderStart[checkId] = runContext.journal
          .readRuntimeEvents()
          .some((event: any) => event.type === 'CheckScheduled' && event.checkId === checkId);
        historyVisibleAtProviderStart[checkId] = (engine as any)._lastRunner
          .getState()
          .historyLog.some(
            (event: any) => event.type === 'CheckScheduled' && event.checkId === checkId
          );

        if (checkId === 'producer') return { issues: [], output: producerOutput };
        if (checkId === 'undefined-foreach') return { issues: [], output: undefined };
        if (checkId === 'slow-sibling') {
          slowStarted.resolve();
          await slowGate.promise;
          return { issues: [], output: { unrelated: 'must-not-leak' } };
        }
        if (checkId === 'consumer') {
          consumerClaims = context?.claims;
          consumerStarted.resolve();
          return { issues: [], output: { consumed: true } };
        }
        return { issues: [], output: { checkId } };
      } finally {
        active--;
      }
    }
  }

  beforeEach(() => {
    engine = new StateMachineExecutionEngine();
    producerOutput = { value: 'ready' };
    slowGate = deferred();
    slowStarted = deferred();
    consumerStarted = deferred();
    invocations = [];
    consumerClaims = undefined;
    active = 0;
    peakActive = 0;
    scheduleVisibleAtProviderStart = {};
    historyVisibleAtProviderStart = {};
    registry.unregister('noop');
    registry.register(new ControlledNoopProvider());
  });

  afterEach(() => {
    registry.unregister('noop');
    registry.register(originalNoop);
  });

  it('journals before release, overlaps ready work, and grants exact isolated context', async () => {
    const run = engine.executeGroupedChecks(
      prInfo,
      ['producer', 'slow-sibling', 'consumer'],
      undefined,
      claimConfig(),
      'table',
      false,
      2
    );

    await Promise.race([
      consumerStarted.promise,
      run.then(() => {
        throw new Error('engine completed before claim consumer started');
      }),
    ]);
    await slowStarted.promise;

    expect(invocations).toEqual(expect.arrayContaining(['producer', 'slow-sibling', 'consumer']));
    expect(peakActive).toBe(2);
    expect(scheduleVisibleAtProviderStart).toEqual({
      producer: true,
      'slow-sibling': true,
      consumer: true,
    });
    expect(historyVisibleAtProviderStart).toEqual({
      producer: true,
      'slow-sibling': true,
      consumer: true,
    });
    expect(Object.keys(consumerClaims || {})).toEqual(['fixture.ready@1']);
    expect(consumerClaims?.['fixture.ready@1'].payload).toEqual({ value: 'ready' });
    expect(Object.isFrozen(consumerClaims)).toBe(true);
    expect(Object.isFrozen(consumerClaims?.['fixture.ready@1'].payload as object)).toBe(true);

    slowGate.resolve();
    const result = await run;
    expect(result.statistics.failedExecutions).toBe(0);

    const journal = (engine as any)._lastContext.journal;
    const events = journal.readRuntimeEvents();
    const producerAttempt = events.findIndex(
      (event: any) => event.type === 'AttemptStarted' && event.checkId === 'producer'
    );
    const published = events.findIndex((event: any) => event.type === 'ClaimPublished');
    const consumerScheduled = events.findIndex(
      (event: any) => event.type === 'CheckScheduled' && event.checkId === 'consumer'
    );
    expect(producerAttempt).toBeGreaterThanOrEqual(0);
    expect(published).toBeGreaterThan(producerAttempt);
    expect(consumerScheduled).toBeGreaterThan(published);
    expect(events.map((event: any) => event.eventId)).toEqual(
      events.map((_: any, index: number) => index + 1)
    );

    const callsBeforeReplay = invocations.length;
    expect(journal.replayClaimProjection()).toEqual(journal.getClaimProjection());
    expect(invocations).toHaveLength(callsBeforeReplay);
  });

  it('fails a schema-invalid producer and never starts its consumer', async () => {
    producerOutput = { value: 'wrong' };
    const config = claimConfig();
    delete config.checks!['slow-sibling'];
    config.checks!.producer.output_schema = {};

    const result = await engine.executeGroupedChecks(
      prInfo,
      ['producer', 'consumer'],
      undefined,
      config,
      'table',
      false,
      2
    );

    expect(invocations).toEqual(['producer']);
    expect(result.statistics.failedExecutions).toBe(1);
    const events = (engine as any)._lastContext.journal.readRuntimeEvents();
    expect(events.some((event: any) => event.type === 'ClaimPublished')).toBe(false);
    expect(
      events.some(
        (event: any) =>
          event.type === 'AttemptFailed' && event.reason === 'CLAIM_SCHEMA_INVALID'
      )
    ).toBe(true);
    expect(
      events.some(
        (event: any) => event.type === 'CheckScheduled' && event.checkId === 'consumer'
      )
    ).toBe(false);
  });

  it('terminalizes an undefined non-declaring forEach attempt before blocking downstream work', async () => {
    const config = claimConfig();
    delete config.checks!['slow-sibling'];
    config.checks!['undefined-foreach'] = { type: 'noop', forEach: true };
    config.checks!.producer.depends_on = ['undefined-foreach'];

    await engine.executeGroupedChecks(
      prInfo,
      ['undefined-foreach', 'producer', 'consumer'],
      undefined,
      config,
      'table',
      false,
      2
    );

    expect(invocations).toEqual(['undefined-foreach']);
    const journal = (engine as any)._lastContext.journal;
    const events = journal.readRuntimeEvents();
    const undefinedAttempt = events.filter(
      (event: any) => event.checkId === 'undefined-foreach'
    );
    expect(undefinedAttempt.map((event: any) => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'AttemptFailed',
    ]);
    expect(undefinedAttempt[2].reason).toBe('UNDEFINED_RESULT');
    expect(
      Object.values(journal.getClaimProjection().attempts).some(
        (attempt: any) => attempt.status === 'started'
      )
    ).toBe(false);
    expect(events.some((event: any) => event.type === 'ClaimPublished')).toBe(false);
    expect(invocations).not.toContain('consumer');
  });

  it('atomically publishes two declared claims before releasing their consumer', async () => {
    const config = claimConfig();
    delete config.checks!['slow-sibling'];
    config.claim_types!['fixture.second@1'] = {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string', const: 'ready' } },
      },
    };
    config.checks!.producer.emits!.push({ claim: 'fixture.second@1', from: 'output' });
    config.checks!.consumer.consumes!.push({
      claim: 'fixture.second@1',
      cardinality: 'one',
    });

    const result = await engine.executeGroupedChecks(
      prInfo,
      ['producer', 'consumer'],
      undefined,
      config,
      'table',
      false,
      2
    );

    expect(result.statistics.failedExecutions).toBe(0);
    expect(invocations).toEqual(['producer', 'consumer']);
    expect(Object.keys(consumerClaims || {})).toEqual([
      'fixture.ready@1',
      'fixture.second@1',
    ]);
    const events = (engine as any)._lastContext.journal.readRuntimeEvents();
    const producerTerminal = events
      .filter((event: any) => event.checkId === 'producer')
      .map((event: any) => event.type);
    expect(producerTerminal).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'ClaimPublished',
      'ClaimPublished',
      'AttemptCompleted',
    ]);
  });

  it('publishes no prefix and starts no consumer when a later emission is invalid', async () => {
    const config = claimConfig();
    delete config.checks!['slow-sibling'];
    config.claim_types!['fixture.second@1'] = {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'second'],
        properties: { value: { const: 'ready' }, second: { const: true } },
      },
    };
    config.checks!.producer.emits!.push({ claim: 'fixture.second@1', from: 'output' });
    config.checks!.consumer.consumes!.push({
      claim: 'fixture.second@1',
      cardinality: 'one',
    });

    const result = await engine.executeGroupedChecks(
      prInfo,
      ['producer', 'consumer'],
      undefined,
      config,
      'table',
      false,
      2
    );

    expect(result.statistics.failedExecutions).toBe(1);
    expect(invocations).toEqual(['producer']);
    const journal = (engine as any)._lastContext.journal;
    expect(journal.readRuntimeEvents().map((event: any) => event.type)).toEqual([
      'AttemptStarted',
      'CheckScheduled',
      'AttemptFailed',
    ]);
    expect(journal.getClaimProjection().claims).toEqual({});
  });

  it.each([
    {
      name: 'fail_if',
      configure: (producer: any) => {
        producer.fail_if = 'true';
      },
      reason: 'TERMINAL_RESULT_FAILED',
    },
    {
      name: 'halt_execution',
      configure: (producer: any) => {
        producer.failure_conditions = {
          stop: {
            condition: 'true',
            message: 'stop graph',
            severity: 'error',
            halt_execution: true,
          },
        };
      },
      reason: 'HALT_EXECUTION',
    },
  ])('publishes zero claims on $name terminal failure', async ({ configure, reason }) => {
    const config = claimConfig();
    delete config.checks!['slow-sibling'];
    configure(config.checks!.producer);

    const result = await engine.executeGroupedChecks(
      prInfo,
      ['producer', 'consumer'],
      undefined,
      config,
      'table',
      false,
      2
    );

    expect(invocations).toEqual(['producer']);
    const events = (engine as any)._lastContext.journal.readRuntimeEvents();
    expect(events.some((event: any) => event.type === 'ClaimPublished')).toBe(false);
    expect(
      events.some(
        (event: any) => event.type === 'AttemptFailed' && event.reason === reason
      )
    ).toBe(true);
  });

  it('rejects undeclared versions before any provider launch', async () => {
    const config = claimConfig();
    config.checks!.consumer.consumes = [
      { claim: 'fixture.ready@2', cardinality: 'one' },
    ];
    await expect(
      engine.executeGroupedChecks(
        prInfo,
        ['producer', 'consumer'],
        undefined,
        config,
        'table',
        false,
        2
      )
    ).rejects.toThrow('undeclared claim');
    expect(invocations).toEqual([]);
  });

  it.each(['emits', 'consumes'])('rejects empty %s before any provider launch', async field => {
    const config: any = claimConfig();
    config.checks.producer[field] = [];
    await expect(
      engine.executeGroupedChecks(
        prInfo,
        ['producer', 'consumer'],
        undefined,
        config,
        'table',
        false,
        2
      )
    ).rejects.toThrow('non-empty array');
    expect(invocations).toEqual([]);
  });

  it('rejects a misspelled schema keyword before any provider launch', async () => {
    const config: any = claimConfig();
    config.claim_types['fixture.ready@1'].schema.propertiez = {};
    await expect(
      engine.executeGroupedChecks(
        prInfo,
        ['producer', 'consumer'],
        undefined,
        config,
        'table',
        false,
        2
      )
    ).rejects.toMatchObject({ code: 'INVALID_CLAIM_SCHEMA' });
    expect(invocations).toEqual([]);
  });

  it('rejects claim-mode OR dependencies before any provider launch', async () => {
    const config = claimConfig();
    config.checks!.consumer.depends_on = 'producer|slow-sibling';
    await expect(
      engine.executeGroupedChecks(
        prInfo,
        ['producer', 'slow-sibling', 'consumer'],
        undefined,
        config,
        'table',
        false,
        2
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CLAIM_OR_DEPENDENCY' });
    expect(invocations).toEqual([]);
  });

  it('preserves legacy depends_on terminal ordering and result shape', async () => {
    const config: VisorConfig = {
      version: '1.0',
      workspace: { enabled: false },
      checks: {
        producer: { type: 'noop' },
        consumer: { type: 'noop', depends_on: ['producer'] },
      },
    };
    const result = await engine.executeGroupedChecks(
      prInfo,
      ['producer', 'consumer'],
      undefined,
      config,
      'table',
      false,
      2
    );
    expect(invocations).toEqual(['producer', 'consumer']);
    expect(result.statistics.failedExecutions).toBe(0);
    expect(result.results.producer[0].output).toEqual({
      value: 'ready',
      ts: expect.any(Number),
    });
    expect((engine as any)._lastContext.journal.readRuntimeEvents()).toEqual([]);
  });

  it('preserves legacy non-claim OR dependency behavior', async () => {
    const config: VisorConfig = {
      version: '1.0',
      workspace: { enabled: false },
      checks: {
        producer: { type: 'noop' },
        'slow-sibling': { type: 'noop' },
        consumer: { type: 'noop', depends_on: 'producer|slow-sibling' },
      },
    };
    const run = engine.executeGroupedChecks(
      prInfo,
      ['producer', 'slow-sibling', 'consumer'],
      undefined,
      config,
      'table',
      false,
      2
    );
    await slowStarted.promise;
    slowGate.resolve();
    const result = await run;
    expect(result.statistics.failedExecutions).toBe(0);
    expect(invocations).toEqual(expect.arrayContaining(['producer', 'slow-sibling', 'consumer']));
    expect((engine as any)._lastContext.journal.readRuntimeEvents()).toEqual([]);
  });
});
