import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';

const PROFILE = resolve(__dirname, '../../examples/agent-governance/exp-0209-component-envelope/visor.yaml');

describe('EXP-0209 authored component envelope', () => {
  it('compiles the authored component selector with stable identity and expands a WorkItem', () => {
    const authored: any = yaml.load(readFileSync(PROFILE, 'utf8'));
    const inspectConfig = authored.subgraphs['onboard-component'].checks.inspect;
    expect(inspectConfig.invocation).toEqual({
      role_id: 'onboard', stance: 'owner', subject: { kind: 'component' },
      output_schema_id: 'proof.onboarding@1',
      output_schema: 'eyJ0eXBlIjoib2JqZWN0IiwiYWRkaXRpb25hbFByb3BlcnRpZXMiOmZhbHNlfQ==',
    });
    for (const field of ['id', 'fingerprint', 'instructions', 'invocation_digest', 'result_schema']) {
      expect(inspectConfig.invocation).not.toHaveProperty(field);
      expect(inspectConfig).not.toHaveProperty(field);
    }
    expect(inspectConfig.consumes).toEqual([{ claim: 'component.work_item@1', as: 'component' }]);
    const plan = compileClaimPlan(authored);
    const repeated = compileClaimPlan(yaml.load(readFileSync(PROFILE, 'utf8'))).expansionPlan;
    expect(repeated.graphSemanticDigest).toBe(plan.expansionPlan.graphSemanticDigest);
    const journal = new ExecutionJournal(plan);
    const sessionId = 'exp-0209-envelope-test';
    const request = journal.requestCatalogReconciliation({ sessionId, ownerCheck: 'discover' });
    const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt({
      requestId: request.requestId,
      attemptId: catalogAttempt.attemptId,
      fence: catalogAttempt.fence,
    });
    journal.completeAttempt({
      sessionId,
      checkId: 'discover',
      scope: [],
      attemptId: catalogAttempt.attemptId,
      fence: catalogAttempt.fence,
      payload: authored.checks.discover.value,
    });

    const [ready] = journal.queryReadyWork();
    expect(ready).toBeDefined();
    const execution = journal.getGeneratedExecution(ready.nodeGenerationId);
    expect(Object.keys(execution.claims)).toEqual(['component']);
    expect(execution.claims.component.claim).toBe('component.work_item@1');
    expect(execution.claims.component.payload.authority.claim).toBe('proof.component_role_authority@1');

    expect(execution.node.check.invocation).toEqual(inspectConfig.invocation);
    expect(execution.node.check).not.toHaveProperty('instructions');
    expect(execution.node.check).not.toHaveProperty('invocation_digest');
    expect(execution.node.check).not.toHaveProperty('result_schema');
    expect(journal.getInstanceProjection()).toEqual(journal.replayInstanceProjection());
  });
});
