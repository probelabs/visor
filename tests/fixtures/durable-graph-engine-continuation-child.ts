import fs from 'fs';
import path from 'path';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ExecutionContext,
  type ManagedAgentRun,
  type ManagedRunStartRequest,
} from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import type { GeneratedDispatchGate } from '../../src/types/engine';

type Item = { id: 'A' | 'B'; revision: number };

export const OWNER = 'discover-items';
export const prInfo = {
  number: 1,
  title: 'durable graph continuation',
  author: 'fixture',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

export function config(): VisorConfig {
  return {
    version: '1.0',
    max_parallelism: 2,
    workspace: {
      enabled: true,
      base_path:
        process.env.VISOR_CONTINUATION_WORKSPACE_PATH || '/tmp/visor-graph-continuation-workspaces',
      cleanup_on_exit: true,
    },
    claim_types: {
      'items.catalog@1': {
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
                required: ['id', 'revision'],
                properties: {
                  id: { enum: ['A', 'B'] },
                  revision: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
      },
      'items.item@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'revision'],
          properties: {
            id: { enum: ['A', 'B'] },
            revision: { type: 'integer', minimum: 1 },
          },
        },
      },
      'items.inspected@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'revision'],
          properties: {
            id: { enum: ['A', 'B'] },
            revision: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    subgraphs: {
      'inspect-and-summarize': {
        input: { name: 'item', claim: 'items.item@1' },
        checks: {
          inspect: {
            type: 'durable-fixture',
            consumes: [{ claim: 'items.item@1', as: 'item' }],
            emits: [{ claim: 'items.inspected@1', from: 'output' }],
          },
          summarize: {
            type: 'durable-fixture',
            consumes: [{ claim: 'items.inspected@1', as: 'inspection' }],
          },
        },
      },
    },
    checks: {
      [OWNER]: {
        type: 'durable-fixture',
        emits: [{ claim: 'items.catalog@1', from: 'output' }],
        expand: {
          claim: 'items.catalog@1',
          template: 'inspect-and-summarize',
          items_pointer: '/items',
          key_pointer: '/id',
          item_claim: 'items.item@1',
        },
      },
    },
  } as VisorConfig;
}

function itemsFor(mode: string): Item[] {
  return mode === 'continue'
    ? [
        { id: 'A', revision: 2 },
        { id: 'B', revision: 1 },
      ]
    : [
        { id: 'A', revision: 1 },
        { id: 'B', revision: 1 },
      ];
}

class DurableFixtureProvider extends CheckProvider {
  constructor(
    private readonly mode: string,
    private readonly calls: unknown[]
  ) {
    super();
  }

  getName(): string {
    return 'durable-fixture';
  }

  getDescription(): string {
    return 'Deterministic durable continuation fixture provider';
  }

  async validateConfig(): Promise<boolean> {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getRequirements(): string[] {
    return [];
  }

  getSupportedConfigKeys(): string[] {
    return ['type'];
  }

  async execute(
    _pr: PRInfo,
    providerConfig: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    executionContext?: ExecutionContext
  ): Promise<ReviewSummary> {
    const checkId = String(providerConfig.checkName);
    const parent = (executionContext as any)?._parentContext;
    this.calls.push({
      kind: 'owner',
      checkId,
      sessionId: parent?.sessionId,
      workingDirectory: parent?.workingDirectory,
      workingDirectoryExists:
        typeof parent?.workingDirectory === 'string' && fs.existsSync(parent.workingDirectory),
    });
    return { issues: [], output: { items: itemsFor(this.mode) } };
  }

  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const binding = request.binding;
    const item = [...request.dependencyResults.values()][0]?.output as
      | { id: 'A' | 'B'; revision: number }
      | undefined;
    const key = item?.id || binding.scope[binding.scope.length - 1]?.key;
    const checkId = request.checkConfig.checkName || binding.checkId;
    this.calls.push({
      kind: 'generated',
      checkId,
      key,
      sessionId: binding.sessionId,
      binding,
    });
    const output =
      checkId === 'inspect'
        ? { id: key, revision: item?.revision }
        : { id: key, revision: item?.revision, summarized: true };
    return {
      binding,
      started: Promise.resolve({ version: 1, kind: 'started', binding }),
      outcome: Promise.resolve({
        version: 1,
        kind: 'succeeded',
        binding,
        summary: { issues: [], output },
      }),
      cancel: async () => ({ version: 1, kind: 'cancelled', binding, reason: 'deadline' }),
      close: async () => ({
        version: 1,
        kind: 'cleanup',
        binding,
        status: 'clean',
        activeChildren: 0,
        activeResources: 0,
      }),
    };
  }
}

function installProvider(mode: string, calls: unknown[]): () => void {
  const registry = CheckProviderRegistry.getInstance();
  const previous = registry.getProvider('durable-fixture');
  if (previous) registry.unregister('durable-fixture');
  registry.register(new DurableFixtureProvider(mode, calls));
  return () => {
    registry.unregister('durable-fixture');
    if (previous) registry.register(previous);
  };
}

function writeArtifact(directory: string, name: string, value: unknown): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value), 'utf8');
}

function journalGate(
  mode: 'pause' | 'resume' | 'invalid',
  observations: unknown[]
): GeneratedDispatchGate {
  return generation => {
    if (!Object.isFrozen(generation) || generation.status !== 'ready' ||
        !generation.nodeGenerationId || !generation.nodeInstanceId || !generation.templateNodeKey) {
      throw new Error('generated dispatch gate received a non-journal-ready value');
    }
    observations.push({
      generationId: generation.nodeGenerationId,
      checkId: generation.checkId,
      templateNodeKey: generation.templateNodeKey,
      scope: generation.scope,
      status: generation.status,
      frozen: Object.isFrozen(generation),
    });
    if (mode === 'invalid') return 'invalid-decision' as never;
    if (mode === 'pause') return generation.scope.some(part => part.key === 'B') ? 'defer' : 'dispatch';
    return undefined;
  };
}

async function produce(directory: string): Promise<void> {
  const calls: unknown[] = [];
  const restore = installProvider('produce', calls);
  try {
    const engine = new StateMachineExecutionEngine(process.cwd());
    await engine.executeGroupedChecks(prInfo, [OWNER], undefined, config());
    const context = (engine as any)._lastContext;
    const checkpoint = JSON.parse(
      JSON.stringify(context.journal.exportGraphCheckpoint(context.sessionId))
    );
    writeArtifact(directory, 'producer.json', {
      pid: process.pid,
      checkpoint,
      calls,
      projection: context.journal.getInstanceProjection(),
      events: context.journal.readRuntimeEvents(),
    });
  } finally {
    restore();
  }
}

async function pauseAtReadyFrontier(directory: string): Promise<void> {
  const calls: unknown[] = [];
  const gateObservations: unknown[] = [];
  const restore = installProvider('produce', calls);
  try {
    const engine = new StateMachineExecutionEngine(process.cwd());
    await engine.executeGroupedChecks(
      prInfo,
      [OWNER],
      undefined,
      config(),
      undefined,
      false,
      2,
      false,
      undefined,
      journalGate('pause', gateObservations),
    );
    const context = (engine as any)._lastContext;
    const checkpoint = JSON.parse(JSON.stringify(context.journal.exportGraphCheckpoint(context.sessionId)));
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config()), checkpoint);
    writeArtifact(directory, 'paused.json', {
      pid: process.pid,
      checkpoint,
      calls,
      gateObservations,
      projection: context.journal.getInstanceProjection(),
      restoredLive: restored.getInstanceProjection(),
      replay: restored.replayInstanceProjection(),
      canonicalReexport: restored.exportGraphCheckpoint(checkpoint.sessionId),
      events: context.journal.readRuntimeEvents(),
    });
  } finally {
    restore();
  }
}

async function resumeFromReadyFrontier(directory: string): Promise<void> {
  const source = JSON.parse(fs.readFileSync(path.join(directory, 'paused.json'), 'utf8'));
  const calls: unknown[] = [];
  const gateObservations: unknown[] = [];
  const restoreProvider = installProvider('produce', calls);
  try {
    const engine = new StateMachineExecutionEngine(process.cwd());
    const resumed = await engine.resumeGraphCheckpoint({
      checkpoint: source.checkpoint,
      config: config(),
      prInfo,
      maxParallelism: 2,
      generatedDispatchGate: journalGate('resume', gateObservations),
    });
    const returnedCheckpoint = JSON.parse(JSON.stringify(resumed.checkpoint));
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config()), returnedCheckpoint);
    writeArtifact(directory, 'resumed.json', {
      pid: process.pid,
      calls,
      gateObservations,
      checkpoint: returnedCheckpoint,
      projection: engine.getInstanceProjection(),
      restoredLive: restored.getInstanceProjection(),
      replay: restored.replayInstanceProjection(),
      canonicalReexport: restored.exportGraphCheckpoint(returnedCheckpoint.sessionId),
      transitions: ((engine as any)._lastRunner.getState().historyLog as unknown[]).filter(
        event => (event as any).type === 'StateTransition',
      ),
      result: resumed.result,
    });
  } finally {
    restoreProvider();
  }
}

async function rejectInvalidResume(directory: string): Promise<void> {
  const source = JSON.parse(fs.readFileSync(path.join(directory, 'paused.json'), 'utf8'));
  const calls: unknown[] = [];
  const gateObservations: unknown[] = [];
  const restoreProvider = installProvider('produce', calls);
  try {
    const engine = new StateMachineExecutionEngine(process.cwd());
    try {
      await engine.resumeGraphCheckpoint({
        checkpoint: source.checkpoint,
        config: config(),
        prInfo,
        generatedDispatchGate: journalGate('invalid', gateObservations),
      });
      throw new Error('invalid generated dispatch gate unexpectedly succeeded');
    } catch (error) {
      writeArtifact(directory, 'invalid-resume.json', {
        pid: process.pid,
        calls,
        gateObservations,
        error: { code: (error as any)?.code, message: String((error as Error)?.message || error) },
        events: (engine as any)._lastContext?.journal.readRuntimeEvents() || [],
      });
    }
  } finally {
    restoreProvider();
  }
}

async function legacyGate(directory: string): Promise<void> {
  const calls: unknown[] = [];
  const restore = installProvider('produce', calls);
  try {
    const engine = new StateMachineExecutionEngine(process.cwd());
    await engine.executeGroupedChecks(
      prInfo,
      [OWNER],
      undefined,
      config(),
      undefined,
      false,
      2,
      false,
      undefined,
      async () => {},
    );
    const context = (engine as any)._lastContext;
    writeArtifact(directory, 'legacy-gate.json', {
      pid: process.pid,
      calls,
      projection: context.journal.getInstanceProjection(),
      events: context.journal.readRuntimeEvents(),
    });
  } finally {
    restore();
  }
}

async function continueFrom(directory: string): Promise<void> {
  const source = JSON.parse(fs.readFileSync(path.join(directory, 'producer.json'), 'utf8'));
  const calls: unknown[] = [];
  const restoreProvider = installProvider('continue', calls);
  try {
    const engine = new StateMachineExecutionEngine(process.cwd());
    const continued = await engine.continueGraphCheckpoint({
      checkpoint: source.checkpoint,
      expansionOwnerCheck: OWNER,
      config: config(),
      prInfo,
      maxParallelism: 2,
    });
    const returnedCheckpoint = JSON.parse(JSON.stringify(continued.checkpoint));
    const restored = ExecutionJournal.restoreGraphCheckpoint(
      compileClaimPlan(config()),
      returnedCheckpoint
    );
    const projection = engine.getInstanceProjection();
    const restoredLive = restored.getInstanceProjection();
    const replay = restored.replayInstanceProjection();
    const canonicalReexport = restored.exportGraphCheckpoint(returnedCheckpoint.sessionId);
    const history = ((engine as any)._lastRunner.getState().historyLog as unknown[]).filter(
      event => (event as any).type === 'StateTransition'
    );
    writeArtifact(directory, 'continuation.json', {
      pid: process.pid,
      requestId: continued.requestId,
      calls,
      checkpoint: returnedCheckpoint,
      projection,
      restoredLive,
      replay,
      canonicalReexport,
      transitions: history,
      result: continued.result,
    });
  } finally {
    restoreProvider();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const directory = process.argv[3];
  if (!directory || !['produce', 'continue', 'pause', 'resume', 'invalid-resume', 'legacy-gate'].includes(mode)) {
    throw new Error('usage: durable-graph-engine-continuation-child.ts <mode> <dir>');
  }
  if (mode === 'produce') await produce(directory);
  else if (mode === 'continue') await continueFrom(directory);
  else if (mode === 'pause') await pauseAtReadyFrontier(directory);
  else if (mode === 'resume') await resumeFromReadyFrontier(directory);
  else if (mode === 'invalid-resume') await rejectInvalidResume(directory);
  else await legacyGate(directory);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
