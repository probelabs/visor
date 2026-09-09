import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import type {
  CheckProviderConfig,
  ExecutionContext,
} from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import { evaluateCase } from '../../src/test-runner/evaluators';
import type { ExpectBlock } from '../../src/test-runner/assertions';

const prInfo = {
  number: 214,
  title: 'Native provider dispatch through generated graph nodes',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function config(): VisorConfig {
  return {
    version: '1.0',
    max_parallelism: 1,
    workspace: { enabled: false },
    claim_types: {
      'fixture.catalog@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'value'],
                properties: {
                  id: { type: 'string', minLength: 1 },
                  value: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
      },
      'fixture.item@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'value'],
          properties: {
            id: { type: 'string', minLength: 1 },
            value: { type: 'string', minLength: 1 },
          },
        },
      },
      'fixture.first@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'value', 'source'],
          properties: {
            id: { type: 'string', minLength: 1 },
            value: { type: 'string', minLength: 1 },
            source: { type: 'string', minLength: 1 },
          },
        },
      },
      'fixture.final@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'value', 'consumed'],
          properties: {
            id: { type: 'string', minLength: 1 },
            value: { type: 'string', minLength: 1 },
            consumed: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    subgraphs: {
      'item-pipeline': {
        input: { name: 'item', claim: 'fixture.item@1' },
        checks: {
          command1: {
            type: 'command',
            // This is intentionally a real child process. The values are read
            // from the exact generated input claim granted by the graph.
            exec: `node -e 'const id=process.argv[1],value=process.argv[2]; process.stdout.write(JSON.stringify({id,value,source:"command1"}))' '{{ outputs.catalog.id }}' '{{ outputs.catalog.value }}'`,
            consumes: [{ claim: 'fixture.item@1', as: 'item' }],
            emits: [{ claim: 'fixture.first@1', from: 'output' }],
          },
          command2: {
            type: 'command',
            // command2 consumes command1's actual emitted output, rather than
            // reading a nearest/global journal result.
            exec: `node -e 'const id=process.argv[1],value=process.argv[2],consumed=process.argv[3]; process.stdout.write(JSON.stringify({id,value,consumed}))' '{{ outputs.command1.id }}' '{{ outputs.command1.value }}' '{{ outputs.command1.source }}'`,
            consumes: [{ claim: 'fixture.first@1', as: 'first' }],
            emits: [{ claim: 'fixture.final@1', from: 'output' }],
          },
        },
      },
    },
    checks: {
      catalog: {
        type: 'command',
        exec: `node -e 'process.stdout.write(JSON.stringify({items:[{id:"alpha",value:"mechanics-only"}]}))'`,
        emits: [{ claim: 'fixture.catalog@1', from: 'output' }],
        expand: {
          claim: 'fixture.catalog@1',
          template: 'item-pipeline',
          items_pointer: '/items',
          key_pointer: '/id',
          item_claim: 'fixture.item@1',
        },
      },
    },
  } as unknown as VisorConfig;
}

describe('Graph v2 generated nodes use the ordinary command provider', () => {
  it('passes exact item claims and scope through real command1 -> command2 processes', async () => {
    const engine = new StateMachineExecutionEngine();
    const registry = CheckProviderRegistry.getInstance();
    const commandProvider = registry.getProviderOrThrow('command') as any;
    const originalExecute = commandProvider.execute;
    const calls: Array<{
      checkId: string;
      dependencies?: Map<string, ReviewSummary>;
      context?: ExecutionContext;
    }> = [];
    let result: Awaited<ReturnType<StateMachineExecutionEngine['executeGroupedChecks']>>;

    commandProvider.execute = async function (
      pr: PRInfo,
      providerConfig: CheckProviderConfig,
      dependencies?: Map<string, ReviewSummary>,
      context?: ExecutionContext
    ) {
      const result = await originalExecute.call(this, pr, providerConfig, dependencies, context);
      calls.push({
        checkId: String(providerConfig.checkName),
        dependencies,
        context,
      });
      return result;
    };

    try {
      result = await engine.executeGroupedChecks(
        prInfo,
        ['catalog'],
        undefined,
        config(),
        'table',
        false,
        1
      );
    } finally {
      commandProvider.execute = originalExecute;
    }

    const command1 = calls.find(call => call.checkId === 'command1');
    const command2 = calls.find(call => call.checkId === 'command2');
    expect(calls.map(call => call.checkId)).toEqual(['catalog', 'command1', 'command2']);
    expect(command1).toBeDefined();
    expect(command2).toBeDefined();

    const itemClaim = command1!.context!.claims?.item;
    expect(itemClaim).toBeDefined();
    expect(itemClaim!.payload).toEqual({ id: 'alpha', value: 'mechanics-only' });
    expect(itemClaim!.provenance).toBe('controller');
    expect(itemClaim!.scope).toEqual(command1!.context!.scope);
    expect(command1!.context!.scope).toEqual([
      expect.objectContaining({
        kind: 'keyed',
        expansionOwnerCheck: 'catalog',
        key: 'alpha',
      }),
    ]);

    const firstClaim = command2!.context!.claims?.first;
    expect(firstClaim).toBeDefined();
    expect(firstClaim!.payload).toEqual({
      id: 'alpha',
      value: 'mechanics-only',
      source: 'command1',
    });
    expect(firstClaim!.provenance).toBe('attempt');
    expect(firstClaim!.scope).toEqual(command2!.context!.scope);
    expect(command2!.dependencies?.get('command1')?.output).toEqual(firstClaim!.payload);

    const journal = (engine as any)._lastContext.journal;
    const projection = journal.getInstanceProjection();
    const childGenerations = Object.values(projection.generationsById).filter((generation: any) =>
      generation.checkId === 'command1' || generation.checkId === 'command2'
    ) as any[];
    expect(childGenerations).toHaveLength(2);

    // The returned child rows are keyed by opaque nodeGenerationId, but carry
    // the logical check id needed by native Visor assertions.
    for (const child of childGenerations) {
      const childStats = result.statistics.checks.find(
        (stats: any) => stats.checkName === child.nodeGenerationId
      );
      expect(childStats).toEqual(
        expect.objectContaining({
          checkName: child.nodeGenerationId,
          logicalCheckName: child.checkId,
        })
      );
    }

    const logicalErrors = evaluateCase(
      'graph-v2-generated-logical-step',
      result.statistics,
      { calls: [] },
      undefined,
      {
        calls: [
          { step: 'catalog', exactly: 1 },
          { logical_step: 'command1', exactly: 1 },
          { logical_step: 'command2', exactly: 1 },
        ],
      } satisfies ExpectBlock,
      true,
      {},
      result.results,
      {}
    );
    expect(logicalErrors).toEqual([]);

    // Legacy exact-hash assertions remain valid against the same engine
    // result, with no logical-id aliasing of the exact step selector.
    const exactErrors = evaluateCase(
      'graph-v2-generated-exact-step',
      result.statistics,
      { calls: [] },
      undefined,
      {
        calls: [
          { step: 'catalog', exactly: 1 },
          ...childGenerations.map(child => ({ step: child.nodeGenerationId, exactly: 1 })),
        ],
      } satisfies ExpectBlock,
      true,
      {},
      result.results,
      {}
    );
    expect(exactErrors).toEqual([]);

    const events = journal.readRuntimeEvents() as readonly any[];
    const generated = events.filter(event => event.nodeGenerationId);
    expect(generated.filter(event => event.type === 'AttemptFailed')).toHaveLength(0);
    expect(generated.filter(event => event.type === 'AttemptCompleted')).toHaveLength(2);
    expect(
      generated
        .filter(event => event.type === 'ClaimPublished')
        .map(event => event.claim)
        .sort()
    ).toEqual(['fixture.final@1', 'fixture.first@1']);

    const finalClaim = generated.find(
      event => event.type === 'ClaimPublished' && event.claim === 'fixture.final@1'
    );
    expect(finalClaim?.payload).toEqual({
      id: 'alpha',
      value: 'mechanics-only',
      consumed: 'command1',
    });
    expect(finalClaim?.parentClaimIds).toContain(firstClaim!.claimId);
    expect(projection).toEqual(journal.replayInstanceProjection());
  });
});
