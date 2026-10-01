import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import * as yaml from 'js-yaml';
import {
  StateMachineExecutionEngine,
  type ExpansionCoverageProjection,
  type InstanceClaimProjection,
  type InstanceProjection,
} from '../../src/sdk';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ManagedAgentRun,
  type ManagedRunStartRequest,
} from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';
import type { VisorConfig } from '../../src/types/config';

type Item = { id: string; mode: 'completed_clean'; revision: number };
const ITEMS: Item[] = [
  { id: 'A', mode: 'completed_clean', revision: 1 },
  { id: 'B', mode: 'completed_clean', revision: 1 },
];
const INVOCATION = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const RESULT = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
const prInfo = { title: 'public projection', files: [] } as PRInfo;

function mappedOutcome(item: Item) {
  return {
    class: 'completed_clean',
    invocationDigest: INVOCATION,
    resultDigest: RESULT,
    data: { operation: item.id, assessment: 'stable' },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture(): VisorConfig {
  return yaml.load(
    fs.readFileSync(path.join(__dirname, '../fixtures/graph-v2/expansion-coverage.yaml'), 'utf8')
  ) as VisorConfig;
}

describe('EXP-0155A public instance projection', () => {
  const registry = CheckProviderRegistry.getInstance();
  const originalNoop = registry.getProviderOrThrow('noop');
  let rootStarted = deferred();
  let rootRelease = deferred();

  class ProjectionProvider extends CheckProvider {
    getName() {
      return 'noop';
    }
    getDescription() {
      return 'deterministic EXP-0155A provider';
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
    async execute(_pr: PRInfo, config: CheckProviderConfig) {
      if (String(config.checkName) !== 'discover-operations') throw new Error('unexpected check');
      rootStarted.resolve();
      await rootRelease.promise;
      return { issues: [], output: { operations: ITEMS } };
    }
    startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
      const item = [...request.dependencyResults.values()][0].output as Item;
      const binding = request.binding;
      return {
        binding,
        started: Promise.resolve({ version: 1, kind: 'started', binding }),
        outcome: Promise.resolve({
          version: 1,
          kind: 'succeeded',
          binding,
          summary: { issues: [], output: mappedOutcome(item) },
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

  beforeEach(() => {
    rootStarted = deferred();
    rootRelease = deferred();
    registry.unregister('noop');
    registry.register(new ProjectionProvider());
  });

  afterEach(() => {
    registry.unregister('noop');
    registry.register(originalNoop);
  });

  it('returns the exact inactive-run error through both SDK methods', () => {
    const engine = new StateMachineExecutionEngine();
    for (const read of [
      () => engine.getInstanceProjection(),
      () => engine.replayInstanceProjection(),
    ]) {
      let thrown: unknown;
      try {
        read();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({
        code: 'RUN_NOT_ACTIVE',
        message: 'Instance projection requires a prior or active run',
      });
    }
  });

  it('exposes selected immutable claim payloads identically live and replayed', async () => {
    const engine = new StateMachineExecutionEngine();
    const run = engine.executeGroupedChecks(
      prInfo,
      ['discover-operations'],
      undefined,
      fixture(),
      'table'
    );
    await rootStarted.promise;
    const request = engine.requestCatalogReconciliation('discover-operations');
    rootRelease.resolve();
    await run;

    const coverage: ExpansionCoverageProjection = engine.getExpansionCoverageProjection(
      request.requestId
    );
    const live: InstanceProjection = engine.getInstanceProjection();
    const replay: InstanceProjection = engine.replayInstanceProjection();
    expect(replay).toEqual(live);
    expect(coverage.items).toHaveLength(2);

    for (const item of coverage.items) {
      expect(item.outcomeClaimId).not.toBeNull();
      const matches = Object.values(live.claimsById).filter(
        claim => claim.claimId === item.outcomeClaimId
      );
      expect(matches).toHaveLength(1);
      const selected: InstanceClaimProjection = matches[0];
      expect(selected).toMatchObject({
        claimId: item.outcomeClaimId,
        payloadFingerprint: item.outcomePayloadFingerprint,
        active: true,
        kind: 'generated-output',
        payload: mappedOutcome(ITEMS.find(candidate => candidate.id === item.key)!),
      });
    }

    for (const projection of [live, replay]) {
      expect(Object.isFrozen(projection)).toBe(true);
      expect(Object.isFrozen(projection.claimsById)).toBe(true);
      for (const claim of Object.values(projection.claimsById)) {
        expect(Object.isFrozen(claim)).toBe(true);
        expect(Object.isFrozen(claim.payload as object)).toBe(true);
      }
    }
    const selected = live.claimsById[coverage.items[0].outcomeClaimId!];
    expect(() => {
      (live as { lastEventId: number }).lastEventId = -1;
    }).toThrow(TypeError);
    expect(() => {
      (selected.payload as { data: { operation: string } }).data.operation = 'mutated';
    }).toThrow(TypeError);
    expect(engine.getInstanceProjection()).toEqual(live);
    expect(engine.replayInstanceProjection()).toEqual(replay);
  });

  it('has only exact AST-approved acquisition, error, and delegation statements', () => {
    const file = path.join(__dirname, '../../src/state-machine-execution-engine.ts');
    const sourceText = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const engine = source.statements.find(
      node => ts.isClassDeclaration(node) && node.name?.text === 'StateMachineExecutionEngine'
    );
    if (!engine || !ts.isClassDeclaration(engine)) throw new Error('engine class not found');

    for (const name of ['getInstanceProjection', 'replayInstanceProjection']) {
      const methods = engine.members.filter(
        member => ts.isMethodDeclaration(member) && member.name.getText(source) === name
      );
      expect(methods).toHaveLength(1);
      const method = methods[0] as ts.MethodDeclaration;
      expect(method.modifiers?.map(modifier => modifier.kind)).toEqual([
        ts.SyntaxKind.PublicKeyword,
      ]);
      expect(method.parameters).toHaveLength(0);
      expect(method.type?.getText(source)).toBe('InstanceProjection');
      const statements = [...method.body!.statements];
      expect(statements.map(statement => statement.kind)).toEqual([
        ts.SyntaxKind.VariableStatement,
        ts.SyntaxKind.IfStatement,
        ts.SyntaxKind.ReturnStatement,
      ]);
      expect(statements[0].getText(source)).toBe('const journal = this._lastContext?.journal;');
      expect(statements[1].getText(source)).toBe(`if (!journal) {
      const error = new Error('Instance projection requires a prior or active run') as Error & {
        code: string;
      };
      error.code = 'RUN_NOT_ACTIVE';
      throw error;
    }`);
      expect(statements[2].getText(source)).toBe(`return journal.${name}();`);
    }
  });
});
