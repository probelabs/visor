import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import * as ProbeModule from '@probelabs/probe';
import { createGovernedProbeRunner, governedCandidateShape, GOVERNED_PROOF_ROLE_MESSAGE, GovernedProbeAgentRunner, renderGovernedProbePublicRequest, sanitizeGovernedAnswerFailure, withGovernedProbeRunnerBudget } from '../../../src/providers/governed-probe-runner';
import { immutableCanonicalValue, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';
import type { GovernedProbeRunnerRequest } from '../../../src/providers/governed-proof-inspect-check-provider';

const root = process.cwd();
const invocationDigest = `sha256:${'a'.repeat(64)}`;
const binding = Object.freeze({
  managedRunId: 'managed',
  sessionId: 'session',
  checkId: 'inspect',
  scope: [],
  nodeInstanceId: 'node',
  nodeGenerationId: 'generation',
  attemptId: 'attempt',
  fence: 1,
});

function request(overrides: Partial<GovernedProbeRunnerRequest> = {}): GovernedProbeRunnerRequest {
  return Object.freeze({
    message: 'authored text must not cross the runner boundary',
    instructions: 'exact C0 instructions',
    invocation: Object.freeze({ role_id: 'role' }),
    invocationDigest,
    resultSchema: '{"type":"object"}',
    executionConfigDigest: 'b'.repeat(64),
    binding,
    workingDirectory: root,
    ...overrides,
  });
}

function result(): Record<string, unknown> {
  return {
    data: { ok: true },
    runtimeAttestation: {},
    resultIdentity: {},
  };
}

function governedFailure(fields: Record<string, unknown>): Error {
  const failure = new Error('secret failure message');
  Object.defineProperty(failure, 'name', { value: 'GovernedAnswerFailure', configurable: true });
  Object.defineProperty(failure, 'stack', { value: 'secret stack and private path', enumerable: true, configurable: true });
  Object.defineProperty(failure, 'cause', { value: 'secret cause', enumerable: true, configurable: true });
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(failure, key, { value, enumerable: true, configurable: true });
  return failure;
}

function candidatePayload(text: string, overrides: Record<string, unknown> = {}): object {
  const bytes = Buffer.byteLength(text, 'utf8');
  return Object.freeze({
    version: 'probe.governed-answer-candidate/v1',
    text,
    boundary: Object.freeze({
      selectedOrigin: 'result_content',
      selectedChunkCount: bytes === 0 ? 0 : 1,
      selectedBytes: bytes,
      resultTextItemCount: bytes === 0 ? 0 : 1,
      resultTextBytes: bytes,
      rawFinalMessageCount: 0,
      rawFinalPartCount: 0,
      rawFinalBytes: 0,
      ...overrides,
    }),
  });
}

function emitCandidateAndFail(answerMock: { mockImplementationOnce: (implementation: () => Promise<never>) => unknown }, payload: unknown, failure: Error, capture: (payload: unknown) => void): void {
  answerMock.mockImplementationOnce(async () => {
    capture(payload);
    throw failure;
  });
}

function rawSha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

describe('private governed Probe runner', () => {
  const initialize = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const previewGovernedAnswerDispatch = jest.fn().mockResolvedValue({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'1'.repeat(64)}`, promptBytes: 7 });
  const answerGoverned = jest.fn().mockResolvedValue(result());
  const cancel = jest.fn();
  const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    jest.clearAllMocks();
    initialize.mockClear();
    previewGovernedAnswerDispatch.mockClear();
    previewGovernedAnswerDispatch.mockResolvedValue({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'1'.repeat(64)}`, promptBytes: 7 });
    answerGoverned.mockClear();
    answerGoverned.mockResolvedValue(result());
    cancel.mockClear();
    close.mockClear();
    const prototype = ProbeModule.ProbeAgent.prototype;
    for (const [name, implementation] of Object.entries({ initialize, previewGovernedAnswerDispatch, answerGoverned, cancel, close })) {
      descriptors.set(name, Object.getOwnPropertyDescriptor(prototype, name));
      Object.defineProperty(prototype, name, { configurable: true, writable: true, value: implementation });
    }
  });

  afterEach(() => {
    const prototype = ProbeModule.ProbeAgent.prototype;
    for (const name of ['initialize', 'previewGovernedAnswerDispatch', 'answerGoverned', 'cancel', 'close']) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else delete (prototype as unknown as Record<string, unknown>)[name];
    }
    descriptors.clear();
  });

  it('constructs without dispatching and binds the controller cwd before answering', () => {
    const runner = new GovernedProbeAgentRunner(request());
    expect(runner).toBeDefined();
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it('keeps only the closed typed Probe failure fields and freezes the projection', () => {
    const failure = governedFailure({
      answerFailureStage: 'schema_result_validation',
      schemaResultValidationSubreason: 'schema_mismatch',
      schemaResultValidationKeyword: 'type',
      secret: 'candidate-controlled text',
    });
    const projection = sanitizeGovernedAnswerFailure(failure);
    expect(projection).toEqual({
      answerFailureStage: 'schema_result_validation',
      schemaResultValidationSubreason: 'schema_mismatch',
      schemaResultValidationKeyword: 'type',
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(JSON.stringify(projection)).not.toContain('secret');
    expect(sanitizeGovernedAnswerFailure(new Error('secret message'))).toEqual({ answerFailureStage: 'unknown' });
  });

  it('keeps the closed exec diagnostic on the public answer failure record', async () => {
    const stderrText = 'access token could not be refreshed because your refresh token was revoked';
    const failure = governedFailure({
      answerFailureStage: 'provider_engine',
      providerEngineFailureBoundary: 'query',
      providerEngineDiagnostic: {
        version: 'probe.governed-codex-exec-failure/v1',
        code: 'GOVERNED_CODEX_EXEC_EXIT',
        stderr: {
          source: 'codex-exec-stderr/v1',
          bytes: Buffer.byteLength(stderrText, 'utf8'),
          digest: rawSha256(stderrText),
          safeMessage: 'access_token_refresh_revoked',
        },
      },
    });
    answerGoverned.mockRejectedValueOnce(failure);
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as any);
    try {
      const runner = new GovernedProbeAgentRunner(request());
      await expect(runner.answer(request())).rejects.toBe(failure);
      expect(JSON.parse(writes[0])).toEqual(expect.objectContaining({
        schema: 'governed-probe-failure/v1',
        phase: 'answer',
        failure: {
          answerFailureStage: 'provider_engine',
          providerEngineFailureBoundary: 'query',
          providerEngineDiagnostic: {
            version: 'probe.governed-codex-exec-failure/v1',
            code: 'GOVERNED_CODEX_EXEC_EXIT',
            stderr: {
              source: 'codex-exec-stderr/v1',
              bytes: Buffer.byteLength(stderrText, 'utf8'),
              digest: rawSha256(stderrText),
              safeMessage: 'access_token_refresh_revoked',
            },
          },
        },
      }));
      expect(writes[0]).not.toContain(stderrText);
      expect(writes[0]).not.toContain('secret stack');
    } finally {
      stderr.mockRestore();
    }
  });

  it('keeps only the closed structural rejected-item event metadata', () => {
    const event = {
      source: 'codex-exec-rejected-item/v1',
      predicate: 'item_status',
      eventType: 'item.completed',
      itemType: 'mcp_tool_call',
      eventFields: [
        {name: 'item', type: 'object'},
        {name: 'type', type: 'string', size: 15},
      ],
      itemFields: [
        {name: '<unsafe>', type: 'string', size: 7},
        {name: 'id', type: 'string', size: 4},
      ],
    };
    const projection = sanitizeGovernedAnswerFailure(governedFailure({
      answerFailureStage: 'provider_engine',
      providerEngineFailureBoundary: 'query',
      providerEngineDiagnostic: {
        version: 'probe.governed-codex-exec-failure/v1',
        code: 'GOVERNED_CODEX_EXEC_ITEM',
        event,
      },
    }));
    expect(projection).toEqual({
      answerFailureStage: 'provider_engine',
      providerEngineFailureBoundary: 'query',
      providerEngineDiagnostic: {
        version: 'probe.governed-codex-exec-failure/v1',
        code: 'GOVERNED_CODEX_EXEC_ITEM',
        event,
      },
    });
    expect(Object.isFrozen((projection as any).providerEngineDiagnostic.event)).toBe(true);
    for (const malformed of [
      {...event, predicate: 'item_private'},
      {...event, eventFields: [{name: '9starts-with-digit', type: 'string', size: 1}]},
      {...event, itemFields: [{name: 'type', type: 'boolean', size: 1}]},
      {...event, itemFields: [{name: 'type', type: 'string', size: -1}]},
      {...event, extra: 'drop'},
    ]) {
      expect(sanitizeGovernedAnswerFailure(governedFailure({
        answerFailureStage: 'provider_engine',
        providerEngineFailureBoundary: 'query',
        providerEngineDiagnostic: {
          version: 'probe.governed-codex-exec-failure/v1',
          code: 'GOVERNED_CODEX_EXEC_ITEM',
          event: malformed,
        },
      }))).toEqual({answerFailureStage: 'provider_engine', providerEngineFailureBoundary: 'query'});
    }
    const accessor = governedFailure({
      answerFailureStage: 'provider_engine',
      providerEngineFailureBoundary: 'query',
      providerEngineDiagnostic: {
        version: 'probe.governed-codex-exec-failure/v1',
        code: 'GOVERNED_CODEX_EXEC_ITEM',
        event,
      },
    });
    Object.defineProperty((accessor as any).providerEngineDiagnostic, 'event', {enumerable: true, get: () => event});
    expect(sanitizeGovernedAnswerFailure(accessor)).toEqual({
      answerFailureStage: 'provider_engine',
      providerEngineFailureBoundary: 'query',
    });
  });

  it('preserves the value-free projection for item error and start-payload predicates', () => {
    const baseEvent = {
      source: 'codex-exec-rejected-item/v1',
      eventType: 'item.started',
      itemType: 'command_execution',
      eventFields: [{name: 'type', type: 'string', size: 18}],
      itemFields: [{name: 'error', type: 'object'}],
    };
    for (const predicate of ['item_error', 'item_started_payload']) {
      const event = {...baseEvent, predicate};
      expect(sanitizeGovernedAnswerFailure(governedFailure({
        answerFailureStage: 'provider_engine',
        providerEngineFailureBoundary: 'query',
        providerEngineDiagnostic: {
          version: 'probe.governed-codex-exec-failure/v1',
          code: 'GOVERNED_CODEX_EXEC_ITEM',
          event,
        },
      }))).toEqual({
        answerFailureStage: 'provider_engine',
        providerEngineFailureBoundary: 'query',
        providerEngineDiagnostic: {
          version: 'probe.governed-codex-exec-failure/v1',
          code: 'GOVERNED_CODEX_EXEC_ITEM',
          event,
        },
      });
      expect(sanitizeGovernedAnswerFailure(governedFailure({
        answerFailureStage: 'provider_engine',
        providerEngineFailureBoundary: 'query',
        providerEngineDiagnostic: {
          version: 'probe.governed-codex-exec-failure/v1',
          code: 'GOVERNED_CODEX_EXEC_ITEM',
          event: {...event, itemStatus: 'failed'},
        },
      }))).toEqual({answerFailureStage: 'provider_engine', providerEngineFailureBoundary: 'query'});
    }
    for (const itemStatus of ['failed', 'declined']) {
      const event = {...baseEvent, predicate: 'item_status', itemStatus};
      expect(sanitizeGovernedAnswerFailure(governedFailure({
        answerFailureStage: 'provider_engine',
        providerEngineFailureBoundary: 'query',
        providerEngineDiagnostic: {
          version: 'probe.governed-codex-exec-failure/v1',
          code: 'GOVERNED_CODEX_EXEC_ITEM',
          event,
        },
      }))).toEqual({
        answerFailureStage: 'provider_engine',
        providerEngineFailureBoundary: 'query',
        providerEngineDiagnostic: {
          version: 'probe.governed-codex-exec-failure/v1',
          code: 'GOVERNED_CODEX_EXEC_ITEM',
          event,
        },
      });
    }
  });

  it('drops malformed or accessor-backed exec diagnostics without widening the failure record', () => {
    const base = {
      answerFailureStage: 'provider_engine',
      providerEngineFailureBoundary: 'query',
    };
    const valid = {
      version: 'probe.governed-codex-exec-failure/v1',
      code: 'GOVERNED_CODEX_EXEC_EXIT',
      stderr: {source: 'codex-exec-stderr/v1', bytes: 1, digest: `sha256:${'a'.repeat(64)}`},
    };
    for (const diagnostic of [
      {...valid, code: 'GOVERNED_CODEX_EXEC_PRIVATE'},
      {...valid, extra: 'secret'},
      {...valid, stderr: {...valid.stderr, safeMessage: 'arbitrary'}},
      {...valid, stderr: {...valid.stderr, digest: 'not-a-digest'}},
    ]) {
      expect(sanitizeGovernedAnswerFailure(governedFailure({...base, providerEngineDiagnostic: diagnostic}))).toEqual(base);
    }
    const accessor = governedFailure(base);
    Object.defineProperty(accessor, 'providerEngineDiagnostic', {enumerable: true, get: () => valid});
    expect(sanitizeGovernedAnswerFailure(accessor)).toEqual(base);
  });

  it('emits one public preview failure record and rethrows the original Probe error', async () => {
    const failure = governedFailure({
      answerFailureStage: 'native_event_grammar',
      nativeEventFailureBoundary: 'raw_item_predicate',
      nativeEventFailureRawItemPredicate: 'message_content_kind',
    });
    previewGovernedAnswerDispatch.mockRejectedValueOnce(failure);
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as any);
    try {
      const runner = new GovernedProbeAgentRunner(request());
      await expect(runner.preview(request())).rejects.toBe(failure);
      await expect(runner.answer(request())).resolves.toBeDefined();
      expect(writes).toHaveLength(1);
      const record = JSON.parse(writes[0]) as Record<string, any>;
      expect(record).toEqual({
        schema: 'governed-probe-failure/v1',
        provider: 'governed-proof-inspect',
        phase: 'preview',
        check_id: 'inspect',
        scope: [],
        failure: {
          answerFailureStage: 'native_event_grammar',
          nativeEventFailureBoundary: 'raw_item_predicate',
          nativeEventFailureRawItemPredicate: 'message_content_kind',
        },
      });
      expect(writes[0]).not.toContain('secret');
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    ['initialize', 'initialize'],
    ['answer', 'answer'],
  ])('reports the Probe %s phase separately', async (_label, phase) => {
    const failure = governedFailure({ answerFailureStage: 'provider_engine', providerEngineFailureBoundary: 'query' });
    if (phase === 'initialize') initialize.mockRejectedValueOnce(failure);
    else answerGoverned.mockRejectedValueOnce(failure);
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as any);
    try {
      const runner = new GovernedProbeAgentRunner(request());
      await expect(runner.answer(request())).rejects.toBe(failure);
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])).toEqual(expect.objectContaining({ phase, failure: { answerFailureStage: 'provider_engine', providerEngineFailureBoundary: 'query' } }));
      expect(writes[0]).not.toContain('secret');
    } finally {
      stderr.mockRestore();
    }
  });

  it('emits the closed public candidate record only for a schema validation failure', async () => {
    const text = '{"ok":false}';
    const failure = governedFailure({ answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason: 'schema_mismatch', schemaResultValidationKeyword: 'type' });
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as any);
    try {
      const runner = new GovernedProbeAgentRunner(request());
      emitCandidateAndFail(answerGoverned, candidatePayload(text), failure, payload => (runner as any).captureCandidate(payload));
      await expect(runner.answer(request())).rejects.toBe(failure);
      expect(writes).toHaveLength(2);
      expect(JSON.parse(writes[0])).toEqual({
        schema: 'governed-probe-public-candidate/v1',
        provider: 'governed-proof-inspect',
        phase: 'answer',
        check_id: 'inspect',
        scope: [],
        selectedOrigin: 'result_content',
        candidateChunkCount: 1,
        candidateBytes: Buffer.byteLength(text, 'utf8'),
        candidateSha256: rawSha256(text),
        candidateShape: 'valid_json',
        captureTruncated: false,
        candidateText: text,
        resultTextItemCount: 1,
        resultTextBytes: Buffer.byteLength(text, 'utf8'),
        rawFinalMessageCount: 0,
        rawFinalPartCount: 0,
        rawFinalBytes: 0,
      });
      expect(JSON.parse(writes[1])).toEqual(expect.objectContaining({ schema: 'governed-probe-failure/v1', phase: 'answer' }));
    } finally {
      stderr.mockRestore();
    }
  });

  it('emits an exact empty candidate record and keeps parser shape labels bounded', async () => {
    const failure = governedFailure({ answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason: 'response_json' });
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as any);
    try {
      const runner = new GovernedProbeAgentRunner(request());
      emitCandidateAndFail(answerGoverned, candidatePayload('', { selectedOrigin: 'none' }), failure, payload => (runner as any).captureCandidate(payload));
      await expect(runner.answer(request())).rejects.toBe(failure);
      expect(writes).toHaveLength(2);
      expect(JSON.parse(writes[0])).toEqual(expect.objectContaining({
        schema: 'governed-probe-public-candidate/v1',
        selectedOrigin: 'none',
        candidateChunkCount: 0,
        candidateBytes: 0,
        candidateSha256: rawSha256(''),
        candidateShape: 'empty',
        captureTruncated: false,
        candidateText: '',
      }));
      expect(governedCandidateShape('not JSON')).toBe('non_json');
      expect(governedCandidateShape('{"ok":')).toBe('malformed_json');
      expect(governedCandidateShape('{"ok":true}')).toBe('valid_json');
    } finally {
      stderr.mockRestore();
    }
  });

  it('hashes oversized candidate text but redacts its public text capture', async () => {
    const text = `{"value":"${'x'.repeat(131100)}"}`;
    const failure = governedFailure({ answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason: 'response_json' });
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as any);
    try {
      const runner = new GovernedProbeAgentRunner(request());
      emitCandidateAndFail(answerGoverned, candidatePayload(text), failure, payload => (runner as any).captureCandidate(payload));
      await expect(runner.answer(request())).rejects.toBe(failure);
      expect(writes).toHaveLength(2);
      const record = JSON.parse(writes[0]) as Record<string, unknown>;
      expect(record.candidateBytes).toBe(Buffer.byteLength(text, 'utf8'));
      expect(record.candidateSha256).toBe(rawSha256(text));
      expect(record.candidateShape).toBe('valid_json');
      expect(record.captureTruncated).toBe(true);
      expect(record.candidateText).toBeNull();
      expect(writes[0]).not.toContain(text);
    } finally {
      stderr.mockRestore();
    }
  });

  it('rejects hostile candidate payloads without masking the original failure', async () => {
    let versionRead = false;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'version', { enumerable: true, get() { versionRead = true; throw new Error('getter must not run'); } });
    Object.defineProperty(hostile, 'text', { enumerable: true, value: '{}' });
    Object.defineProperty(hostile, 'boundary', { enumerable: true, value: Object.freeze({}) });
    Object.freeze(hostile);
    const failure = governedFailure({ answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason: 'response_json' });
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as any);
    try {
      const runner = new GovernedProbeAgentRunner(request());
      emitCandidateAndFail(answerGoverned, hostile, failure, payload => (runner as any).captureCandidate(payload));
      await expect(runner.answer(request())).rejects.toBe(failure);
      expect(versionRead).toBe(false);
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])).toEqual(expect.objectContaining({ schema: 'governed-probe-failure/v1', phase: 'answer' }));
    } finally {
      stderr.mockRestore();
    }
  });

  it('allows four concurrent scoped factories and denies the fifth before dispatch', async () => {
    await withGovernedProbeRunnerBudget(4, async () => {
      await Promise.all(Array.from({ length: 4 }, () => Promise.resolve().then(() => createGovernedProbeRunner(request()))));
      expect(() => createGovernedProbeRunner(request({ workingDirectory: 'project' }))).toThrow('GOVERNED_PROOF_BUDGET_EXCEEDED');
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it('isolates overlapping scopes and leaves unscoped construction unchanged', async () => {
    let release!: () => void;
    const overlap = new Promise<void>(resolve => { release = resolve; });
    const first = withGovernedProbeRunnerBudget(1, async () => { const runner = createGovernedProbeRunner(request()); await overlap; return runner; });
    const second = withGovernedProbeRunnerBudget(1, async () => { const runner = createGovernedProbeRunner(request()); await overlap; return runner; });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(() => createGovernedProbeRunner(request())).not.toThrow();
  });

  it('initializes once and sends the authored message with the bound C0 schema/digest', async () => {
    const runner = new GovernedProbeAgentRunner(request());
    await runner.answer(request({ message: 'candidate-controlled text' }));
    await runner.answer(request({
      instructions: 'another request must not change system prompt',
      invocationDigest: `sha256:${'f'.repeat(64)}`,
      resultSchema: '{"type":"string"}',
    }));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(answerGoverned).toHaveBeenCalledTimes(2);
    expect(answerGoverned).toHaveBeenNthCalledWith(1, request().message, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
    expect(answerGoverned).toHaveBeenNthCalledWith(2, request().message, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
  });

  it('uses generic governed review guidance without evaluator-specific oracle text', async () => {
    const runner = new GovernedProbeAgentRunner(request({ message: GOVERNED_PROOF_ROLE_MESSAGE }));
    await runner.answer(request());
    expect(GOVERNED_PROOF_ROLE_MESSAGE).toContain('dependency closure as the exclusive citation scope');
    expect(GOVERNED_PROOF_ROLE_MESSAGE).toContain('review every owned path');
    expect(GOVERNED_PROOF_ROLE_MESSAGE).toContain('input and validation through control flow to the resulting effect');
    expect(GOVERNED_PROOF_ROLE_MESSAGE).toContain('regression-test function names and line numbers');
    expect(GOVERNED_PROOF_ROLE_MESSAGE).not.toMatch(/hidden oracle|TestMalformedWriteDoesNotPersist/i);
    expect(answerGoverned).toHaveBeenCalledWith(GOVERNED_PROOF_ROLE_MESSAGE, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
  });

  it('puts the exact canonical component context in the Probe user message', async () => {
    const context: any = immutableCanonicalValue({
      version: 'visor.proof-runtime-context/v1',
      component: { claimId: '1'.repeat(64), claim: 'component.work_item@1', payloadFingerprint: sha256Canonical({ componentId: 'http-adapter' }), scope: [], payload: { componentId: 'http-adapter' } },
      authority: { claimId: '3'.repeat(64), claim: 'proof.component_role_authority@1', payloadFingerprint: sha256Canonical({ roleId: 'onboard' }), scope: [], payload: { roleId: 'onboard' } },
    });
    const runner = new GovernedProbeAgentRunner(request({ context, contextDigest: `sha256:${'5'.repeat(64)}` }));
    await runner.answer(request({ context }));
    expect(answerGoverned).toHaveBeenCalledWith(`${request().message}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${JSON.stringify(context)}`, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
  });

  it('retains the fallible-candidate instruction for reviewed component context', async () => {
    const context: any = immutableCanonicalValue({ version: 'visor.proof-reviewed-component-context/v1', component: { claimId: '1'.repeat(64) }, reviewed: { claimId: '2'.repeat(64) } });
    const runner = new GovernedProbeAgentRunner(request({ context }));
    await runner.answer(request({ context }));
    const message = answerGoverned.mock.calls[0][0] as string;
    expect(message).toContain('independent packet findings are fallible candidates');
    expect(message).toContain('never infer approval from packet or aggregate completion');
  });

  it('renders a canonical public request envelope without private runner fields', () => {
    const envelope = JSON.parse(renderGovernedProbePublicRequest(request()));
    expect(envelope).toEqual({
      version: 'governed-probe-public-request/v1',
      system: { role: 'system', content: request().instructions },
      user: { role: 'user', content: request().message },
      result_schema: request().resultSchema,
      check_id: 'inspect',
      scope: [],
    });
    expect(JSON.stringify(envelope)).not.toContain('invocationDigest');
    expect(JSON.stringify(envelope)).not.toContain('executionConfigDigest');
  });

  it('puts the canonical project discovery inventory in the authored Probe message', async () => {
    const context: any = immutableCanonicalValue({
      version: 'visor.proof-project-discovery-context/v1',
      project: { claimId: '1'.repeat(64), claim: 'project.discovery_item@1', payloadFingerprint: sha256Canonical({ project_id: 'journalservice' }), scope: [], payload: { project_id: 'journalservice' } },
      current_inventory: { claimId: '2'.repeat(64), claim: 'proof.structural_inventory@1', payloadFingerprint: sha256Canonical({ sorted_paths: ['entry.go', 'go.mod'] }), scope: [], payload: { sorted_paths: ['entry.go', 'go.mod'] } },
    });
    const authored = 'Return the closed catalog from this inventory.';
    const runner = new GovernedProbeAgentRunner(request({ message: authored, context, contextDigest: `sha256:${'5'.repeat(64)}` }));
    await runner.answer(request({ message: 'ignored by construction', context }));
    expect(answerGoverned).toHaveBeenCalledWith(`${authored}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${JSON.stringify(context)}`, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
  });

  it.each([
    ['empty', ''],
    ['oversized', 'x'.repeat(32769)],
  ])('rejects an %s authored message before Probe construction', (_label, message) => {
    expect(() => new GovernedProbeAgentRunner(request({ message }))).toThrow('message');
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it('cancels and closes at most once without initializing or dispatching a model', async () => {
    const runner = new GovernedProbeAgentRunner(request());
    runner.cancel('deadline');
    runner.cancel('deadline');
    await runner.close();
    await runner.close();
    runner.cancel('deadline');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
    await expect(runner.answer(request())).rejects.toThrow('cancelled');
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it.each([
    ['relative path', 'project'],
    ['missing path', ''],
  ])('rejects a non-controller-owned %s before Probe construction', (_label, path) => {
    expect(() => new GovernedProbeAgentRunner(request({ workingDirectory: path }))).toThrow('workingDirectory');
    expect(initialize).not.toHaveBeenCalled();
  });
});
