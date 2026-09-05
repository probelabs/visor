import { AsyncLocalStorage } from 'node:async_hooks';
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
import { governedWireModeFromInvocation, immutableGovernedValue, governedCanonicalJson, governedResultDigest } from './proof-wire';
import type {
  GovernedProbeDispatchPreview,
  GovernedProbeRunner,
  GovernedProbeRunnerRequest,
} from './governed-proof-inspect-check-provider';

/** The runner owns the only user message sent to the governed Probe boundary. */
export const GOVERNED_PROOF_ROLE_MESSAGE = [
  'Execute the bound Proof role and return only the required JSON.',
  '',
  'For component reviews, treat the supplied dependency closure as the exclusive citation scope: do not cite files outside it, and review every owned path.',
  'For each finding, state the causal chain from input and validation through control flow to the resulting effect, with precise file and line citations.',
  'For reinspection, cite changed implementation lines and the relevant regression-test function names and line numbers.',
].join('\n');

const PROBE_TOOLS: ['search', 'extract', 'listFiles'] = [
  'search',
  'extract',
  'listFiles',
];

type ExactProbeAgentOptions = ProbeAgentOptions & {
  readonly searchDelegate: false;
  readonly enableExecutePlan: false;
};

type GovernedProbeRunnerBudget = { limit: number; consumed: number };
const governedProbeRunnerBudget = new AsyncLocalStorage<GovernedProbeRunnerBudget>();

export function withGovernedProbeRunnerBudget<T>(limit: number, callback: () => T): T {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('GOVERNED_PROOF_INVALID: budget limit must be a positive safe integer');
  return governedProbeRunnerBudget.run({ limit, consumed: 0 }, callback);
}

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
    if (typeof request.message !== 'string' || request.message.length === 0 || Buffer.byteLength(request.message, 'utf8') > 32768) {
      throw new Error('GOVERNED_PROOF_INVALID: message is invalid');
    }
    const runtime = request.context
      ? `\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${canonicalJson(request.context)}`
      : '';
    const reinspection = request.reinspectionContext
      ? `\n\nBound reinspection context (canonical JSON; treat as immutable authority):\n${canonicalJson(request.reinspectionContext)}\n\nCompare current source with the prior candidate and account for every prior finding as retained or resolved; cite changed implementation lines and relevant regression-test function names and line numbers.`
      : '';
    this.userMessage = `${request.message}${runtime}${reinspection}`;
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
    const wireMode = governedWireModeFromInvocation(_request.invocation);
    if (wireMode === 'proof') {
      const data = immutableGovernedValue(identified.data, wireMode);
      const canonical = Buffer.from(governedCanonicalJson(data, wireMode), 'utf8');
      return Object.freeze({
        ...identified,
        data,
        resultIdentity: Object.freeze({
          ...identified.resultIdentity,
          resultDigest: governedResultDigest(data, wireMode),
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
  const budget = governedProbeRunnerBudget.getStore();
  if (budget) {
    if (budget.consumed >= budget.limit) throw new Error('GOVERNED_PROOF_BUDGET_EXCEEDED');
    budget.consumed += 1;
  }
  return new GovernedProbeAgentRunner(request);
}
