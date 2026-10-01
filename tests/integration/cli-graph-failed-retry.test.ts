import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import type { PRInfo } from '../../src/pr-analyzer';

const NODE = process.execPath;
const SOURCE = resolve(__dirname, '../../src/index.ts');
const TS_NODE = require.resolve('ts-node/register/transpile-only');

const CONFIG = `
version: '1.0'
max_parallelism: 1
workspace: {enabled: false}
claim_types:
  project.catalog@1:
    schema:
      type: object
      additionalProperties: false
      required: [projects]
      properties:
        projects:
          type: array
          minItems: 1
          items: {type: object, additionalProperties: false, required: [id], properties: {id: {type: string}}}
  project.item@1:
    schema: {type: object, additionalProperties: false, required: [id], properties: {id: {type: string}}}
  component.catalog@1:
    schema:
      type: object
      additionalProperties: false
      required: [components]
      properties:
        components:
          type: array
          minItems: 1
          items: {type: object, additionalProperties: false, required: [id], properties: {id: {type: string}}}
  component.item@1:
    schema: {type: object, additionalProperties: false, required: [id], properties: {id: {type: string}}}
  batch.catalog@1:
    schema:
      type: object
      additionalProperties: false
      required: [batches]
      properties:
        batches:
          type: array
          minItems: 1
          items: {type: object, additionalProperties: false, required: [id], properties: {id: {type: string}}}
  batch.item@1:
    schema: {type: object, additionalProperties: false, required: [id], properties: {id: {type: string}}}
  batch.result@1:
    schema: {type: object, additionalProperties: false, required: [id], properties: {id: {type: string}}}
subgraphs:
  project:
    input: {name: project, claim: project.item@1}
    checks:
      discover-components:
        type: command
        consumes: [{claim: project.item@1, as: project}]
        emits: [{claim: component.catalog@1, from: output}]
        exec: |
          node -e 'const fs=require("fs"); fs.appendFileSync(process.env.GRAPH_CALL_LOG,"discover-components\\n"); process.stdout.write(JSON.stringify({components:[{id:"C3"},{id:"C1"},{id:"C2"}]}));'
        expand:
          claim: component.catalog@1
          template: component
          items_pointer: /components
          key_pointer: /id
          item_claim: component.item@1
      project-finished:
        type: command
        depends_on: [discover-components]
        wait_for_expansion: {owner: discover-components, terminal_node: component-finished}
        exec: |
          node -e 'const fs=require("fs"); fs.appendFileSync(process.env.GRAPH_CALL_LOG,"project-finished\\n"); process.stdout.write("project-finished");'
  component:
    input: {name: component, claim: component.item@1}
    checks:
      enumerate-batches:
        type: command
        consumes: [{claim: component.item@1, as: component}]
        emits: [{claim: batch.catalog@1, from: output}]
        exec: |
          node -e 'const fs=require("fs"); const id=process.argv[1]; const batches=id==="C3"?[{id:"C"}]:id==="C2"?[{id:"A"},{id:"B"}]:[{id:"D"}]; fs.appendFileSync(process.env.GRAPH_CALL_LOG,"enumerate:"+id+"\\n"); process.stdout.write(JSON.stringify({batches}));' '{{ outputs.component.id }}'
        expand:
          claim: batch.catalog@1
          template: batch
          items_pointer: /batches
          key_pointer: /id
          item_claim: batch.item@1
      component-finished:
        type: command
        depends_on: [enumerate-batches]
        wait_for_expansion: {owner: enumerate-batches, terminal_node: batch-finished}
        exec: |
          node -e 'const fs=require("fs"); fs.appendFileSync(process.env.GRAPH_CALL_LOG,"component-finished\\n"); process.stdout.write("component-finished");'
  batch:
    input: {name: batch, claim: batch.item@1}
    checks:
      batch-author:
        type: command
        consumes: [{claim: batch.item@1, as: batch}]
        emits: [{claim: batch.result@1, from: output}]
        exec: |
          node -e 'const fs=require("fs"); const id=process.argv[1]; if(id==="A" && process.env.RETRY_MODE==="1"){const st=fs.statSync(process.env.RETRY_PREFIX_PATH); const cp=JSON.parse(fs.readFileSync(process.env.RETRY_PREFIX_PATH,"utf8")); const last=cp.events[cp.events.length-1]; if((st.mode&511)!==384 || last.type!=="AttemptRetryRequested" || last.nodeGenerationId!==process.env.RETRY_GENERATION) process.exit(9);} fs.appendFileSync(process.env.GRAPH_CALL_LOG,"author:"+id+"\\n"); if(id==="A" && process.env.FAIL_A==="1") process.exit(7); process.stdout.write(JSON.stringify({id}));' '{{ outputs.batch.id }}'
      batch-finished:
        type: command
        depends_on: [batch-author]
        consumes: [{claim: batch.result@1, as: result}]
        exec: |
          node -e 'const fs=require("fs"); const id=process.argv[1]; fs.appendFileSync(process.env.GRAPH_CALL_LOG,"batch-finished:"+id+"\\n"); process.stdout.write("batch-finished");' '{{ outputs.result.id }}'
checks:
  discover-projects:
    type: command
    emits: [{claim: project.catalog@1, from: output}]
    exec: |
      node -e 'const fs=require("fs"); fs.appendFileSync(process.env.GRAPH_CALL_LOG,"discover-projects\\n"); process.stdout.write(JSON.stringify({projects:[{id:"P1"}]}));'
    expand:
      claim: project.catalog@1
      template: project
      items_pointer: /projects
      key_pointer: /id
      item_claim: project.item@1
`;

function runCli(root: string, configPath: string, args: string[], callLog: string, failA: boolean, allowFailure = false, extraEnv: Record<string, string> = {}): boolean {
  const env = {
    ...process.env,
    GRAPH_CALL_LOG: callLog,
    FAIL_A: failA ? '1' : '0',
    VISOR_NO_REMOTE_EXTENDS: 'true',
    NO_COLOR: '1',
    TS_NODE_TRANSPILE_ONLY: '1',
    TS_NODE_PROJECT: resolve(__dirname, '../../tsconfig.json'),
    ...extraEnv,
  };
  delete env.NODE_ENV;
  delete env.JEST_WORKER_ID;
  try {
    execFileSync(NODE, ['-r', TS_NODE, SOURCE, '--config', configPath, '--check', 'discover-projects', '--output', 'json', '--disable-code-context', '--max-parallelism', '1', ...args], {
      cwd: root,
      env,
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return false;
  }
  return true;
}

const PR_INFO: PRInfo = {
  number: 1,
  title: 'graph retry fixture',
  author: 'fixture',
  base: 'main',
  head: 'retry',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
};

async function prepareFailedCheckpoint(root: string, config: VisorConfig, checkpointPath: string, callLog: string): Promise<void> {
  const previousLog = process.env.GRAPH_CALL_LOG;
  const previousFail = process.env.FAIL_A;
  process.env.GRAPH_CALL_LOG = callLog;
  process.env.FAIL_A = '1';
  try {
    const produce = new StateMachineExecutionEngine(root);
    const allowOnlyC = (generation: any): 'dispatch' | 'defer' =>
      generation.checkId === 'batch-author' || generation.checkId === 'batch-finished'
        ? (generation.scope.some((segment: any) => segment.kind === 'keyed' && segment.key === 'C') ? 'dispatch' : 'defer')
        : 'dispatch';
    await produce.executeGroupedChecks(PR_INFO, ['discover-projects'], undefined, config, 'json', false, 1, false, undefined, allowOnlyC);
    const checkpointC = produce.exportGraphCheckpoint();
    const checkpointA = join(root, 'checkpoint-c.json');
    writeFileSync(checkpointA, `${canonicalGraphCheckpointJson(checkpointC)}\n`, { mode: 0o600 });

    const fail = new StateMachineExecutionEngine(root);
    const allowOnlyA = (generation: any): 'dispatch' | 'defer' =>
      generation.subgraphInstanceId && generation.scope.some((segment: any) => segment.kind === 'keyed' && segment.key === 'A')
        ? 'dispatch'
        : 'defer';
    const failed = await fail.resumeGraphCheckpoint({
      checkpoint: checkpointC,
      config,
      prInfo: PR_INFO,
      maxParallelism: 1,
      generatedDispatchGate: allowOnlyA,
    });
    writeFileSync(checkpointPath, `${canonicalGraphCheckpointJson(failed.checkpoint)}\n`, { mode: 0o600 });
  } finally {
    if (previousLog === undefined) delete process.env.GRAPH_CALL_LOG; else process.env.GRAPH_CALL_LOG = previousLog;
    if (previousFail === undefined) delete process.env.FAIL_A; else process.env.FAIL_A = previousFail;
  }
}

function checkpointProjection(config: VisorConfig, checkpointPath: string): ReturnType<ExecutionJournal['getInstanceProjection']> {
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  return ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
}

function generationFor(config: VisorConfig, checkpointPath: string, checkId: string, key: string): any {
  return Object.values(checkpointProjection(config, checkpointPath).generationsById).find(generation =>
    generation.checkId === checkId && generation.scope.some(segment => segment.kind === 'keyed' && segment.key === key));
}

describe('source CLI Graph-v2 failed-generation retry', () => {
  it('reopens only A and its same-instance terminal while preserving B/D and parent barriers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-cli-graph-retry-'));
    chmodSync(root, 0o700);
    const configPath = join(root, 'retry.yaml');
    const checkpointFailed = join(root, 'checkpoint-failed.json');
    const checkpointFinal = join(root, 'checkpoint-final.json');
    const outputFinal = join(root, 'output-final.json');
    const callLog = join(root, 'calls.log');
    try {
      writeFileSync(configPath, CONFIG, { mode: 0o600 });
      const config = require('js-yaml').load(CONFIG) as VisorConfig;
      await prepareFailedCheckpoint(root, config, checkpointFailed, callLog);
      const afterFailure = readFileSync(callLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      expect(afterFailure).toContain('author:C');
      expect(afterFailure).toContain('batch-finished:C');
      expect(afterFailure).toContain('author:A');
      expect(afterFailure).not.toContain('author:B');
      expect(afterFailure).not.toContain('author:D');
      const failedA = generationFor(config, checkpointFailed, 'batch-author', 'A');
      expect(failedA?.status).toBe('failed');
      expect(generationFor(config, checkpointFailed, 'batch-author', 'B')?.status).toBe('ready');
      expect(generationFor(config, checkpointFailed, 'batch-author', 'D')?.status).toBe('ready');
      expect(generationFor(config, checkpointFailed, 'batch-author', 'C')?.status).toBe('completed');
      const failedAttempt = failedA.attemptId;
      const failedFence = failedA.fence;
      const callsBeforeNegativeCases = readFileSync(callLog, 'utf8');
      const invokeRejectedRetry = (generationId: string, extraArgs: string[] = [], retryConfigPath = configPath): void => {
        const succeeded = runCli(root, retryConfigPath, [
          '--graph-retry-generation', generationId,
          '--graph-retry-side-effects', 'absent',
          '--graph-resume-ready',
          '--graph-checkpoint-in', checkpointFailed,
          '--graph-checkpoint-out', checkpointFinal,
          '--output-file', outputFinal,
          ...extraArgs,
        ], callLog, false, true);
        expect(succeeded).toBe(false);
        expect(readFileSync(callLog, 'utf8')).toBe(callsBeforeNegativeCases);
      };
      invokeRejectedRetry('b'.repeat(64));
      invokeRejectedRetry(generationFor(config, checkpointFailed, 'batch-author', 'C').nodeGenerationId);
      const retryPrefixPath = `${checkpointFinal}.retry.json`;
      writeFileSync(retryPrefixPath, 'preexisting', { mode: 0o600 });
      invokeRejectedRetry(failedA.nodeGenerationId);
      rmSync(retryPrefixPath);
      invokeRejectedRetry(failedA.nodeGenerationId, ['--output-file', retryPrefixPath]);
      const mismatchedConfigPath = join(root, 'mismatched.yaml');
      writeFileSync(mismatchedConfigPath, CONFIG.replace('key_pointer: /id', 'key_pointer: /wrong'), { mode: 0o600 });
      invokeRejectedRetry(failedA.nodeGenerationId, [], mismatchedConfigPath);

      runCli(root, configPath, [
        '--graph-retry-generation', failedA.nodeGenerationId,
        '--graph-retry-side-effects', 'absent',
        '--graph-resume-ready',
        '--graph-checkpoint-in', checkpointFailed,
        '--graph-checkpoint-out', checkpointFinal,
        '--output-file', outputFinal,
      ], callLog, false, false, {
        RETRY_MODE: '1',
        RETRY_PREFIX_PATH: `${checkpointFinal}.retry.json`,
        RETRY_GENERATION: failedA.nodeGenerationId,
      });
      const afterRetry = readFileSync(callLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      expect(afterRetry.slice(callsBeforeNegativeCases.trim().split(/\r?\n/).filter(Boolean).length)).toEqual(['author:A', 'batch-finished:A']);
      expect(afterRetry).not.toContain('author:B');
      expect(afterRetry).not.toContain('author:D');
      expect(afterRetry.filter(call => call === 'batch-finished:C')).toHaveLength(1);
      expect(afterRetry).not.toContain('project-finished');

      const checkpointFailedValue = JSON.parse(readFileSync(checkpointFailed, 'utf8'));
      const retryPrefixValue = JSON.parse(readFileSync(retryPrefixPath, 'utf8'));
      const checkpointFinalValue = JSON.parse(readFileSync(checkpointFinal, 'utf8'));
      expect(retryPrefixValue.events.slice(0, checkpointFailedValue.events.length)).toEqual(checkpointFailedValue.events);
      expect(retryPrefixValue.events.at(-1)).toMatchObject({ type: 'AttemptRetryRequested', nodeGenerationId: failedA.nodeGenerationId });
      expect(checkpointFinalValue.events.slice(0, retryPrefixValue.events.length)).toEqual(retryPrefixValue.events);
      expect(checkpointFinalValue.sessionId).toBe(checkpointFailedValue.sessionId);
      expect(checkpointFinalValue.graphSemanticDigest).toBe(checkpointFailedValue.graphSemanticDigest);
      expect(readFileSync(retryPrefixPath, 'utf8')).toBe(`${canonicalGraphCheckpointJson(retryPrefixValue)}\n`);
      expect(readFileSync(checkpointFinal, 'utf8')).toBe(`${canonicalGraphCheckpointJson(checkpointFinalValue)}\n`);
      expect(statSync(retryPrefixPath).mode & 0o777).toBe(0o600);
      expect(statSync(checkpointFinal).mode & 0o777).toBe(0o600);
      const finalProjection = checkpointProjection(config, checkpointFinal);
      const finalA = generationFor(config, checkpointFinal, 'batch-author', 'A');
      expect(finalA?.status).toBe('completed');
      expect(finalA.attemptId).not.toBe(failedAttempt);
      expect(finalA.fence).toBeGreaterThan(failedFence);
      expect(generationFor(config, checkpointFinal, 'batch-finished', 'A')?.status).toBe('completed');
      expect(generationFor(config, checkpointFinal, 'batch-author', 'B')?.status).toBe('ready');
      expect(generationFor(config, checkpointFinal, 'batch-author', 'D')?.status).toBe('ready');
      expect(Object.values(finalProjection.generationsById).some(generation => generation.templateNodeKey === 'project-finished' && generation.status === 'completed')).toBe(false);
      const output = JSON.parse(readFileSync(outputFinal, 'utf8'));
      expect(output.__graph_checkpoint[0].output.state).toBe('paused');
      expect(output.__graph_checkpoint[0].output.retryGeneration).toBe(failedA.nodeGenerationId);
      expect(output.__graph_checkpoint[0].output.deferredInstances).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
