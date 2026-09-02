import { isAbsolute, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import {
  ProbeAgent,
  type GovernedCodexProfile,
  type GovernedIdentifiedAnswerOptions,
  type GovernedIdentifiedAnswerResult,
  type ProbeAgentOptions,
} from '@probelabs/probe';
import { canonicalJson } from '../state-machine/graph/claim-kernel';
import { immutableProofCanonicalValue, proofCanonicalJson, proofGovernedResultDigest } from './proof-wire';
import type {
  GovernedProbeDispatchPreview,
  GovernedProbeRunner,
  GovernedProbeRunnerRequest,
} from './governed-proof-inspect-check-provider';

/** The runner owns the only user message sent to the governed Probe boundary. */
export const GOVERNED_PROOF_ROLE_MESSAGE =
  'Execute the bound Proof role and return only the required JSON.';

const PROBE_TOOLS: ['search', 'extract', 'listFiles'] = [
  'search',
  'extract',
  'listFiles',
];

type ExactProbeAgentOptions = ProbeAgentOptions & {
  readonly searchDelegate: false;
  readonly enableExecutePlan: false;
};

function controllerRoot(value: string): string {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error('GOVERNED_PROOF_INVALID: workingDirectory must be absolute');
  }
  const resolved = resolve(value);
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new Error('GOVERNED_PROOF_INVALID: workingDirectory is not a directory');
    }
    return realpathSync(resolved);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GOVERNED_PROOF_INVALID:')) {
      throw error;
    }
    throw new Error('GOVERNED_PROOF_INVALID: workingDirectory is unavailable');
  }
}

function profileFor(root: string): GovernedCodexProfile {
  return {
    version: 'probe.governed-codex-profile/v1',
    profileId: 'luna-xhigh-readonly-v1',
    engine: 'codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'xhigh',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    cwd: root,
    probeTools: PROBE_TOOLS,
    fallback: false,
    retries: 0,
  };
}

export class GovernedProbeAgentRunner implements GovernedProbeRunner {
  private readonly agent: ProbeAgent;
  private readonly resultSchema: string;
  private readonly invocationDigest: string;
  private readonly userMessage: string;
  private initializePromise: Promise<void> | undefined;
  private cancelled = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(request: GovernedProbeRunnerRequest) {
    const root = controllerRoot(request.workingDirectory);
    this.resultSchema = request.resultSchema;
    this.invocationDigest = request.invocationDigest;
    this.userMessage = request.context
      ? `${GOVERNED_PROOF_ROLE_MESSAGE}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${canonicalJson(request.context)}`
      : GOVERNED_PROOF_ROLE_MESSAGE;
    const governedCodexProfile = profileFor(root);
    const options: ExactProbeAgentOptions = {
      provider: 'codex',
      path: root,
      cwd: root,
      systemPrompt: request.instructions,
      allowEdit: false,
      enableDelegate: false,
      searchDelegate: false,
      enableExecutePlan: false,
      enableBash: false,
      allowSkills: false,
      allowedTools: PROBE_TOOLS,
      governedCodexProfile,
    };
    this.agent = new ProbeAgent(options);
  }

  async preview(_request: GovernedProbeRunnerRequest): Promise<GovernedProbeDispatchPreview> {
    if (this.cancelled) throw new Error('GOVERNED_PROOF_INVALID: runner is cancelled');
    if (this.closed) throw new Error('GOVERNED_PROOF_INVALID: runner is closed');
    return this.agent.previewGovernedAnswerDispatch(this.userMessage, { schema: this.resultSchema });
  }

  async answer(_request: GovernedProbeRunnerRequest): Promise<GovernedIdentifiedAnswerResult> {
    if (this.cancelled) throw new Error('GOVERNED_PROOF_INVALID: runner is cancelled');
    if (this.closed) throw new Error('GOVERNED_PROOF_INVALID: runner is closed');
    if (!this.initializePromise) this.initializePromise = this.agent.initialize();
    await this.initializePromise;
    if (this.cancelled) throw new Error('GOVERNED_PROOF_INVALID: runner is cancelled');
    if (this.closed) throw new Error('GOVERNED_PROOF_INVALID: runner is closed');
    const options: GovernedIdentifiedAnswerOptions = {
      schema: this.resultSchema,
      invocationDigest: this.invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    };
    const identified = await this.agent.answerGoverned(this.userMessage, options);
    // Probe's generic result identity intentionally retains its historical
    // ordering. The onboarding candidate is a Proof wire, so re-project that
    // one result with Proof's UTF-8 bytewise key ordering before Visor binds
    // its candidate evidence and claim publication.
    if (_request.invocation.output_schema_id === 'proof.component-catalog-candidate@1') {
      const data = immutableProofCanonicalValue(identified.data);
      const canonical = Buffer.from(proofCanonicalJson(data), 'utf8');
      return Object.freeze({
        ...identified,
        data,
        resultIdentity: Object.freeze({
          ...identified.resultIdentity,
          resultDigest: proofGovernedResultDigest(data),
          canonicalBytes: canonical.length,
        }),
      });
    }
    return identified;
  }

  cancel(_reason: 'deadline'): void {
    if (this.cancelled || this.closed) return;
    this.cancelled = true;
    this.agent.cancel();
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.agent.close();
    }
    await this.closePromise;
  }
}

export function createGovernedProbeRunner(request: GovernedProbeRunnerRequest): GovernedProbeRunner {
  return new GovernedProbeAgentRunner(request);
}
