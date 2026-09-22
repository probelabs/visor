import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { qualifiedNestedExpansionOwner } from '../../src/state-machine/graph/instance-plan';
import type { VisorConfig } from '../../src/types/config';

const NODE = process.execPath;
const SOURCE = resolve(__dirname, '../../src/index.ts');
const TS_NODE = require.resolve('ts-node/register/transpile-only');
const CONFIG_PATH = resolve(__dirname, '../fixtures/graph-v2/cli-ready-resume.yaml');
const OWNER = qualifiedNestedExpansionOwner('project', 'materialize');

function config(): VisorConfig {
  return require('js-yaml').load(readFileSync(CONFIG_PATH, 'utf8')) as VisorConfig;
}

function runCli(root: string, args: string[], callLog: string): void {
  const env = {
    ...process.env,
    GRAPH_CALL_LOG: callLog,
    VISOR_NO_REMOTE_EXTENDS: 'true',
    NO_COLOR: '1',
    TS_NODE_TRANSPILE_ONLY: '1',
    TS_NODE_PROJECT: resolve(__dirname, '../../tsconfig.json'),
  };
  delete env.NODE_ENV;
  delete env.JEST_WORKER_ID;
  execFileSync(NODE, ['-r', TS_NODE, SOURCE, ...args], {
    cwd: root,
    env,
    stdio: 'pipe',
    timeout: 30000,
  });
}

function checkpointProjection(checkpointPath: string): ReturnType<ExecutionJournal['getInstanceProjection']> {
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  return ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config()), checkpoint).getInstanceProjection();
}

describe('source CLI Graph-v2 ready-only bounded resume', () => {
  it('runs one keyed child instance, then resumes only the remaining child and barrier', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-cli-graph-ready-'));
    chmodSync(root, 0o700);
    const checkpointA = join(root, 'checkpoint-a.json');
    const checkpointB = join(root, 'checkpoint-b.json');
    const outputA = join(root, 'output-a.json');
    const outputB = join(root, 'output-b.json');
    const callLog = join(root, 'calls.log');
    try {
      runCli(root, [
        '--config', CONFIG_PATH,
        '--check', 'discover',
        '--output', 'json',
        '--output-file', outputA,
        '--disable-code-context',
        '--max-parallelism', '1',
        '--graph-dispatch-owner', OWNER,
        '--graph-dispatch-limit', '1',
        '--graph-checkpoint-out', checkpointA,
      ], callLog);

      const firstCalls = readFileSync(callLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      expect(firstCalls).toHaveLength(4);
      expect(firstCalls.slice(0, 2)).toEqual(['discover', 'materialize']);
      const admittedChildMatch = firstCalls[2].match(/^inspect:(A|B)$/);
      expect(admittedChildMatch).not.toBeNull();
      const admittedChild = admittedChildMatch![1];
      const remainingChild = admittedChild === 'A' ? 'B' : 'A';
      expect(firstCalls.slice(2)).toEqual([`inspect:${admittedChild}`, `terminal:${admittedChild}`]);
      const firstOutput = JSON.parse(readFileSync(outputA, 'utf8'));
      expect(firstOutput.__graph_checkpoint[0].output).toMatchObject({
        state: 'paused',
        dispatchOwner: OWNER,
        dispatchLimit: 1,
        deferredInstances: 1,
      });
      expect(firstOutput.__graph_checkpoint[0].content).toContain('resume is required');
      expect(firstOutput.__graph_checkpoint[0].content).not.toContain('complete');

      const checkpointABytes = readFileSync(checkpointA, 'utf8');
      const checkpointAValue = JSON.parse(checkpointABytes);
      expect(checkpointABytes).toBe(`${canonicalGraphCheckpointJson(checkpointAValue)}\n`);
      expect(statSync(checkpointA).mode & 0o777).toBe(0o600);
      const projectionA = checkpointProjection(checkpointA);
      const childrenA = Object.values(projectionA.instancesById).filter(instance => instance.parentSubgraphInstanceId);
      expect(childrenA.map(instance => [instance.itemKey, instance.status]).sort()).toEqual([['A', 'active'], ['B', 'active']]);
      const terminalGenerations = Object.values(projectionA.generationsById).filter(generation => generation.templateNodeKey === 'terminal');
      expect(terminalGenerations.filter(generation => generation.status === 'completed')).toHaveLength(1);
      const inspectRemaining = Object.values(projectionA.generationsById).find(generation =>
        generation.templateNodeKey === 'inspect' && generation.scope.some(segment => segment.kind === 'keyed' && segment.key === remainingChild));
      expect(inspectRemaining?.status).toBe('ready');
      expect(Object.values(projectionA.generationsById).some(generation => generation.templateNodeKey === 'barrier' && generation.status === 'completed')).toBe(false);

      runCli(root, [
        '--config', CONFIG_PATH,
        '--check', 'discover',
        '--output', 'json',
        '--output-file', outputB,
        '--disable-code-context',
        '--max-parallelism', '1',
        '--graph-dispatch-owner', OWNER,
        '--graph-dispatch-limit', '1',
        '--graph-resume-ready',
        '--timeout', '0',
        '--graph-checkpoint-in', checkpointA,
        '--graph-checkpoint-out', checkpointB,
      ], callLog);

      const allCalls = readFileSync(callLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      expect(allCalls).toEqual(['discover', 'materialize', `inspect:${admittedChild}`, `terminal:${admittedChild}`, `inspect:${remainingChild}`, `terminal:${remainingChild}`, 'barrier']);
      const secondOutput = JSON.parse(readFileSync(outputB, 'utf8'));
      expect(secondOutput.__graph_checkpoint[0].output).toMatchObject({
        state: 'drained-without-defer',
        dispatchOwner: OWNER,
        dispatchLimit: 1,
        deferredInstances: 0,
      });
      expect(secondOutput.__graph_checkpoint[0].content).not.toContain('workflow complete');

      const checkpointBValue = JSON.parse(readFileSync(checkpointB, 'utf8'));
      expect(checkpointBValue.sessionId).toBe(checkpointAValue.sessionId);
      expect(checkpointBValue.graphSemanticDigest).toBe(checkpointAValue.graphSemanticDigest);
      expect(checkpointBValue.events.slice(0, checkpointAValue.events.length)).toEqual(checkpointAValue.events);
      expect(checkpointBValue.events.some((event: { type?: string }) => event.type === 'CatalogReconciliationRequested')).toBe(false);
      expect(readFileSync(checkpointB, 'utf8')).toBe(`${canonicalGraphCheckpointJson(checkpointBValue)}\n`);
      expect(statSync(checkpointB).mode & 0o777).toBe(0o600);
      const projectionB = checkpointProjection(checkpointB);
      expect(Object.values(projectionB.generationsById).filter(generation => generation.templateNodeKey === 'terminal' && generation.status === 'completed')).toHaveLength(2);
      expect(Object.values(projectionB.generationsById).filter(generation => generation.templateNodeKey === 'barrier' && generation.status === 'completed')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
