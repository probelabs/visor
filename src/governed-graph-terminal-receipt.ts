import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson } from './state-machine/graph/claim-kernel';
import { PROOF_ADMITTED_RECEIPT_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_CATALOG_REVALIDATION_CLAIM, PROOF_STRUCTURAL_INVENTORY_CLAIM } from './state-machine/graph/instance-plan';
import type { ExecutionJournal } from './snapshot-store';
import { requireKeyedScopePath, type InstanceProjection, type NodeGenerationProjection } from './state-machine/graph/instance-kernel';
import { validateProofCandidateEvidence } from './providers/governed-proof-inspect-check-provider';
import { COMPONENT_WORK_ITEM_CLAIM } from './providers/governed-proof-inspect-check-provider';

export const GOVERNED_GRAPH_TERMINAL_RECEIPT_SCHEMA = 'visor.governed-graph-terminal-receipt/v1';
/** Multi-component extension; v1 remains the wire shape for one-component callers. */
export const GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA = 'visor.governed-graph-terminal-receipt/v2';
export const PROOF_DISCOVERY_CATALOG_CANDIDATE_CLAIM = 'proof.component_catalog_candidate@1';
export const PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM = 'proof.project_reconciliation_receipt@1';
export const PROOF_ONBOARDING_CANDIDATE_CLAIM = 'proof.onboarding_candidate@1';
const SHA = /^[0-9a-f]{64}$/;
const FAILURE_CODES = new Set(['MANAGED_HANDLE_INVALID','MANAGED_BINDING_MISMATCH','MANAGED_START_FAILED','MANAGED_STARTED_RECEIPT_INVALID','MANAGED_OUTCOME_FAILED','MANAGED_OUTCOME_RECEIPT_INVALID','MANAGED_DEADLINE_EXCEEDED','MANAGED_CANCEL_FAILED','MANAGED_CANCEL_RECEIPT_INVALID','MANAGED_CLOSE_FAILED','MANAGED_CLEANUP_RECEIPT_INVALID','MANAGED_SANDBOX_UNSUPPORTED','MANAGED_DEBOUNCE_UNSUPPORTED','MANAGED_FATAL_SUMMARY','MANAGED_FAIL_IF','MANAGED_HALT_EXECUTION','MANAGED_CLAIM_VALIDATION_FAILED','MANAGED_POST_PROVIDER_FAILED']);
const ATTESTATION_VERSION = 'probe.governed-codex-attestation/v2';
const ATTESTATION_PROFILE = 'luna-xhigh-readonly-v1';
const ATTESTATION_DISPATCH_SOURCE = 'probe-host-tools-call';
const ATTESTATION_DISPATCH_TOOL = 'codex';
const own = (v: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(v, k);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function data(v: object, k: PropertyKey): boolean { const d = Object.getOwnPropertyDescriptor(v, k); return !!d && 'value' in d && !!d.enumerable; }
function exact(v: object, keys: readonly string[]): boolean { const ks = Reflect.ownKeys(v); return ks.length === keys.length && ks.every(k => typeof k === 'string' && keys.includes(k) && data(v, k)); }
function unicode(v: string): boolean { for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) { const n = v.charCodeAt(++i); if (Number.isNaN(n) || n < 0xdc00 || n > 0xdfff) return false; } else if (c >= 0xdc00 && c <= 0xdfff) return false; } return true; }
function boundedString(v: unknown, maxBytes: number, nonempty = true): v is string { return typeof v === 'string' && unicode(v) && (nonempty ? v.length > 0 : true) && Buffer.byteLength(v, 'utf8') <= maxBytes; }
function material(v: unknown, seen = new Set<object>()): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return unicode(v);
  if (!v || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  try {
    if (Array.isArray(v)) { const keys = Reflect.ownKeys(v); if (keys.some(k => typeof k !== 'string' || (k !== 'length' && !/^(0|[1-9][0-9]*)$/.test(k)))) return false; const length = Object.getOwnPropertyDescriptor(v, 'length'); if (!length || !('value' in length) || length.enumerable || v.length > 1024) return false; for (let i = 0; i < v.length; i++) if (!own(v, String(i)) || !material(v[i], seen)) return false; return true; }
    if (!plain(v)) return false;
    return Reflect.ownKeys(v).every(k => typeof k === 'string' && data(v, k) && material((v as Record<string, unknown>)[k], seen));
  } finally { seen.delete(v); }
}

export interface GovernedGraphTerminalReceipt {
  readonly version: typeof GOVERNED_GRAPH_TERMINAL_RECEIPT_SCHEMA;
  readonly status: 'passed' | 'failed';
  readonly sourceConfigSha256: string;
  readonly sessionId: string;
  readonly graphSemanticDigest: string;
  readonly componentCount: number;
  readonly nodes: Readonly<Record<'inspect' | 'proof_admit' | 'verify', { terminalCount: number; status: 'completed' | 'failed' | 'nonterminal' | 'absent' }>>;
  readonly attestation: Readonly<{ version: string; profileId: string; dispatch: { source: string; tool: string }; eventCount: number; usage: { status: 'unavailable' } }> | null;
  readonly candidateClaimId: string | null;
  readonly admittedReceiptClaimId: string | null;
  readonly verifyInputClaimIds: readonly string[];
  readonly providerCleanupStatus: 'clean' | 'unclean';
  readonly managedUncleanTerminalCount: number;
  readonly activeChildren: number;
  readonly activeResources: number;
  readonly memoryStatus: 'clean' | 'failed';
  readonly projectionReplayEqual: boolean;
  readonly failureCode: string | null;
  readonly exitStatus: 0 | 1;
}

export interface GovernedGraphComponentTerminalReceiptEntry {
  readonly componentKey: string;
  readonly scope: readonly unknown[];
  readonly workItemClaimId: string;
  readonly candidateClaimId: string;
  readonly admittedReceiptClaimId: string | null;
  readonly generation: Readonly<Record<'inspect' | 'proof_admit' | 'verify', { generationId: string | null; status: 'completed' | 'failed' | 'nonterminal' | 'absent' }>>;
  readonly verifyInputClaimIds: readonly string[];
  readonly attestation: GovernedGraphTerminalReceipt['attestation'];
  readonly status: 'passed' | 'failed';
  readonly cleanupStatus: 'clean';
}

export interface GovernedGraphDiscoveryTerminalReceiptEntry {
  readonly candidateClaimId: string;
  readonly admittedReceiptClaimId: string;
  readonly verifyInputClaimIds: readonly string[];
  readonly structuralInventoryClaimId: string;
  readonly catalogRevalidationClaimId: string;
  readonly projectReconciliationClaimId: string;
  readonly projectReconciliationInputClaimIds: readonly string[];
  readonly attestation: GovernedGraphTerminalReceipt['attestation'];
  readonly status: 'completed';
}

export interface GovernedGraphMultiTerminalReceipt {
  readonly version: typeof GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA;
  readonly status: 'passed' | 'failed';
  readonly sourceConfigSha256: string;
  readonly sessionId: string;
  readonly graphSemanticDigest: string;
  readonly componentCount: number;
  readonly nodes: GovernedGraphTerminalReceipt['nodes'];
  readonly discovery: GovernedGraphDiscoveryTerminalReceiptEntry;
  readonly components: readonly GovernedGraphComponentTerminalReceiptEntry[];
  readonly providerCleanupStatus: 'clean' | 'unclean';
  readonly managedUncleanTerminalCount: number;
  readonly activeChildren: number;
  readonly activeResources: number;
  readonly memoryStatus: 'clean' | 'failed';
  readonly projectionReplayEqual: boolean;
  readonly failureCode: string | null;
  readonly exitStatus: 0 | 1;
}

export type GovernedGraphTerminalReceiptDraft = Omit<GovernedGraphTerminalReceipt, 'status' | 'memoryStatus' | 'exitStatus'>;
export type GovernedGraphMultiTerminalReceiptDraft = Omit<GovernedGraphMultiTerminalReceipt, 'status' | 'memoryStatus' | 'exitStatus'>;
export type GovernedGraphAnyTerminalReceipt = GovernedGraphTerminalReceipt | GovernedGraphMultiTerminalReceipt;
export type GovernedGraphAnyTerminalReceiptDraft = GovernedGraphTerminalReceiptDraft | GovernedGraphMultiTerminalReceiptDraft;
interface GovernedReceiptPlanAuthority { readonly active: boolean; readonly expansionPlan: { readonly graphSemanticDigest?: unknown }; }
export interface GovernedReceiptProjectionInput { readonly journal: ExecutionJournal; readonly claimPlan: GovernedReceiptPlanAuthority; readonly sourceConfigSha256: string; }

function nodeSummary(generations: NodeGenerationProjection[], key: string) {
  // Inactive generations are historical lineage, not current terminal work.
  // A selective resume necessarily leaves them in the journal.
  const selected = generations.filter(g => g.status !== 'inactive' && g.templateNodeKey === key && g.checkId === key);
  const terminal = selected.filter(g => g.status === 'completed' || g.status === 'failed');
  const status = selected.length === 0 ? 'absent' : terminal.length !== selected.length ? 'nonterminal' : selected.some(g => g.status === 'failed') ? 'failed' : 'completed';
  return { terminalCount: terminal.length, status: status as 'completed' | 'failed' | 'nonterminal' | 'absent' };
}

function selectedAttestation(projection: InstanceProjection): GovernedGraphTerminalReceipt['attestation'] {
  const candidate = Object.values(projection.claimsById).find(c => c.active && c.claim === PROOF_CANDIDATE_CLAIM && c.proofCandidateEvidence);
  if (!candidate?.proofCandidateEvidence) return null;
  try {
    const evidence = validateProofCandidateEvidence(candidate.proofCandidateEvidence) as any;
    const att = evidence.probe.attestation as any;
    return { version: att.version, profileId: att.profileId, dispatch: { source: att.dispatch.source, tool: att.dispatch.tool }, eventCount: att.evidence.eventCount, usage: { status: att.usage.status } };
  } catch { throw new Error('receipt evidence validation failed'); }
}

function attestationForClaim(claim: any): GovernedGraphTerminalReceipt['attestation'] {
  if (!claim?.proofCandidateEvidence) return null;
  try {
    const evidence = validateProofCandidateEvidence(claim.proofCandidateEvidence) as any;
    const att = evidence.probe.attestation as any;
    return { version: att.version, profileId: att.profileId, dispatch: { source: att.dispatch.source, tool: att.dispatch.tool }, eventCount: att.evidence.eventCount, usage: { status: att.usage.status } };
  } catch { throw new Error('receipt evidence validation failed'); }
}

function projectionPair(journal: ExecutionJournal): { live: InstanceProjection; replay: InstanceProjection } {
  const live = journal.getInstanceProjection(); const replay = journal.replayInstanceProjection();
  return { live, replay };
}

function generationState(generation: NodeGenerationProjection | undefined): { generationId: string | null; status: 'completed' | 'failed' | 'nonterminal' | 'absent' } {
  if (!generation || generation.status === 'inactive') return { generationId: null, status: 'absent' };
  if (generation.status === 'completed') return { generationId: generation.nodeGenerationId, status: 'completed' };
  if (generation.status === 'failed') return { generationId: generation.nodeGenerationId, status: 'failed' };
  return { generationId: generation.nodeGenerationId, status: 'nonterminal' };
}

function projectMultiComponentReceipt(input: GovernedReceiptProjectionInput, live: InstanceProjection, replay: InstanceProjection, sessionId: string, graphSemanticDigest: string): GovernedGraphMultiTerminalReceiptDraft {
  const activeClaims = Object.values(live.claimsById).filter((claim: any) => claim.active);
  const instances = Object.values(live.instancesById).filter(instance => instance.status === 'active');
  const componentInstances = instances.filter(instance => activeClaims.some((claim: any) => claim.claim === COMPONENT_WORK_ITEM_CLAIM && claim.subgraphInstanceId === instance.subgraphInstanceId && claim.claimId === instance.activeItemClaimId));
  if (componentInstances.length < 2) throw new Error('multi-component receipt requires at least two active component WorkItems');
  if (componentInstances.some(instance => instance.sessionId !== sessionId || instance.scope.length < 1 || instance.scope[instance.scope.length - 1].kind !== 'keyed')) throw new Error('receipt topology contains a foreign component');
  const componentKey = (instance: typeof componentInstances[number]) => instance.scope[instance.scope.length - 1].key;
  const sortedInstances = [...componentInstances].sort((left, right) => componentKey(left).localeCompare(componentKey(right)));
  const keys = sortedInstances.map(componentKey);
  if (new Set(keys).size !== keys.length) throw new Error('receipt has duplicate component keys');

  const generations = Object.values(live.generationsById);
  const componentIds = new Set(componentInstances.map(instance => instance.subgraphInstanceId));
  const componentGenerations = generations.filter(generation => componentIds.has(generation.subgraphInstanceId));
  const reserved = new Set(['inspect', 'proof_admit', 'verify']);
  for (const generation of componentGenerations.filter(generation => generation.status !== 'inactive')) {
    if (!reserved.has(generation.templateNodeKey) || generation.templateNodeKey !== generation.checkId) throw new Error('receipt graph generation key is not exact');
  }

  const discoveryCandidates = activeClaims.filter((claim: any) => claim.claim === PROOF_DISCOVERY_CATALOG_CANDIDATE_CLAIM);
  if (discoveryCandidates.length !== 1) throw new Error('receipt requires exactly one discovery catalog candidate');
  const discoveryCandidate: any = discoveryCandidates[0];
  const discoveryScope = canonicalJson(discoveryCandidate.scope);
  const discoveryReceipts = activeClaims.filter((claim: any) => claim.claim === PROOF_ADMITTED_RECEIPT_CLAIM && canonicalJson(claim.scope) === discoveryScope && claim.parentClaimIds.includes(discoveryCandidate.claimId));
  if (discoveryReceipts.length !== 1) throw new Error('receipt requires exactly one admitted discovery entry');
  const discoveryReceipt: any = discoveryReceipts[0];
  if (!Array.isArray(discoveryReceipt.parentClaimIds) || discoveryReceipt.parentClaimIds.length < 1 || new Set(discoveryReceipt.parentClaimIds).size !== discoveryReceipt.parentClaimIds.length) throw new Error('discovery admission inputs are not exact');
  const inventories = activeClaims.filter((claim: any) => claim.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM && canonicalJson(claim.scope) === discoveryScope);
  if (inventories.length !== 1) throw new Error('receipt requires exactly one current structural inventory');
  const revalidations = activeClaims.filter((claim: any) => claim.claim === PROOF_CATALOG_REVALIDATION_CLAIM && canonicalJson(claim.scope) === discoveryScope);
  if (revalidations.length !== 1) throw new Error('receipt requires exactly one current catalog revalidation');
  const revalidation: any = revalidations[0];
  const requiredRevalidationInputs = [inventories[0].claimId, discoveryCandidate.claimId, discoveryReceipt.claimId].sort();
  if (canonicalJson([...revalidation.parentClaimIds].sort()) !== canonicalJson(requiredRevalidationInputs)) throw new Error('catalog revalidation inputs are missing, foreign, or stale');

  const componentEntries = sortedInstances.map(instance => {
    const key = componentKey(instance);
    const scope = instance.scope;
    const scopeJson = canonicalJson(scope);
    const inScope = (claim: any) => claim.active && claim.subgraphInstanceId === instance.subgraphInstanceId && canonicalJson(claim.scope) === scopeJson;
    const componentClaims = Object.values(live.claimsById).filter(inScope);
    const workItems = componentClaims.filter((claim: any) => claim.claim === COMPONENT_WORK_ITEM_CLAIM);
    if (workItems.length !== 1 || workItems[0].claimId !== instance.activeItemClaimId) throw new Error(`receipt work item claim is missing, duplicated, or stale for ${key}`);
    const candidates = componentClaims.filter((claim: any) => claim.claim === PROOF_CANDIDATE_CLAIM);
    if (candidates.length !== 1) throw new Error(`receipt candidate claim is missing or duplicated for ${key}`);
    const admitted = componentClaims.filter((claim: any) => claim.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
    if (admitted.length !== 1 || !admitted[0].parentClaimIds.includes(candidates[0].claimId)) throw new Error(`receipt admitted claim is missing, duplicated, or detached for ${key}`);
    const currentGenerations = (key: string) => generations.filter(generation => generation.status !== 'inactive' && generation.subgraphInstanceId === instance.subgraphInstanceId && generation.templateNodeKey === key && generation.checkId === key);
    const byKey = (key: string): NodeGenerationProjection | undefined => {
      const values = currentGenerations(key);
      if (values.length > 1) throw new Error(`receipt has duplicate active ${key} generations for ${componentKey(instance)}`);
      return values[0];
    };
    const inspect = byKey('inspect');
    const proofAdmit = byKey('proof_admit');
    const verify = byKey('verify');
    if (!inspect || !proofAdmit || !verify) throw new Error(`receipt component ${key} is missing a terminal onboarding generation`);
    const inspectState = generationState(inspect);
    const proofState = generationState(proofAdmit);
    const verifyState = generationState(verify);
    if ([inspectState.status, proofState.status, verifyState.status].some(status => status === 'absent' || status === 'nonterminal')) throw new Error(`receipt component ${key} is nonterminal`);
    const verifyInputs = [...verify.activeInputClaimIds];
    if (verifyInputs.length !== 2 || canonicalJson([...verifyInputs].sort()) !== canonicalJson([candidates[0].claimId, admitted[0].claimId].sort())) throw new Error(`receipt verify inputs are not exact for ${key}`);
    const componentManaged = Object.values(live.managedRunsByAttemptId).filter((run: any) => run.binding.scope && canonicalJson(run.binding.scope) === scopeJson);
    if (componentManaged.some((run: any) => run.binding.sessionId !== sessionId || canonicalJson(run.binding.scope) !== scopeJson || !generations.some(generation => generation.nodeGenerationId === run.binding.nodeGenerationId && generation.subgraphInstanceId === instance.subgraphInstanceId))) throw new Error(`receipt managed run is outside component ${key}`);
    if (componentManaged.some((run: any) => run.status !== 'terminated' || run.cleanupStatus !== 'clean')) throw new Error(`receipt component ${key} is not cleanup-quiescent`);
    const status = inspectState.status === 'completed' && proofState.status === 'completed' && verifyState.status === 'completed' ? 'passed' as const : 'failed' as const;
    return {
      componentKey: key,
      scope,
      workItemClaimId: (workItems[0] as any).claimId,
      candidateClaimId: (candidates[0] as any).claimId,
      admittedReceiptClaimId: (admitted[0] as any)?.claimId || null,
      generation: { inspect: inspectState, proof_admit: proofState, verify: verifyState },
      verifyInputClaimIds: verifyInputs,
      attestation: attestationForClaim(candidates[0]),
      status,
      cleanupStatus: 'clean' as const,
    };
  });
  const reconciliations = activeClaims.filter((claim: any) => claim.claim === PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM && canonicalJson(claim.scope) === discoveryScope);
  if (reconciliations.length !== 1) throw new Error('receipt requires exactly one final whole-project reconciliation');
  const reconciliation: any = reconciliations[0];
  const requiredReconciliationInputs = [revalidation.claimId, ...componentEntries.map(component => component.admittedReceiptClaimId!)].sort();
  if (canonicalJson(reconciliation.parentClaimIds) !== canonicalJson(requiredReconciliationInputs)) throw new Error('whole-project reconciliation inputs are incomplete, duplicated, or foreign');
  const discovery = {
    candidateClaimId: discoveryCandidate.claimId,
    admittedReceiptClaimId: discoveryReceipt.claimId,
    verifyInputClaimIds: [...discoveryReceipt.parentClaimIds].sort(),
    structuralInventoryClaimId: (inventories[0] as any).claimId,
    catalogRevalidationClaimId: revalidation.claimId,
    projectReconciliationClaimId: reconciliation.claimId,
    projectReconciliationInputClaimIds: [...reconciliation.parentClaimIds].sort(),
    attestation: attestationForClaim(discoveryCandidate),
    status: 'completed' as const,
  };
  const managed = Object.values(live.managedRunsByAttemptId);
  const managedUncleanTerminalCount = managed.filter(run => run.status === 'terminated' && run.cleanupStatus !== 'clean').length;
  if (managed.some(run => run.status !== 'terminated')) throw new Error('receipt managed cleanup is not quiescent');
  const failedRun = managed.find(run => run.controllerDecision === 'failed');
  const failureCode = failedRun?.failureCode ?? null;
  if (failureCode !== null && !FAILURE_CODES.has(failureCode)) throw new Error('receipt failure code is not allowlisted');
  const nodes = {
    inspect: nodeSummary(componentGenerations, 'inspect'),
    proof_admit: nodeSummary(componentGenerations, 'proof_admit'),
    verify: nodeSummary(componentGenerations, 'verify'),
  };
  const projectionReplayEqual = canonicalJson(live) === canonicalJson(replay);
  return Object.freeze({
    version: GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA,
    sourceConfigSha256: input.sourceConfigSha256,
    sessionId,
    graphSemanticDigest,
    componentCount: componentEntries.length,
    nodes,
    discovery,
    components: componentEntries,
    providerCleanupStatus: managedUncleanTerminalCount === 0 ? 'clean' : 'unclean',
    managedUncleanTerminalCount,
    activeChildren: 0,
    activeResources: 0,
    projectionReplayEqual,
    failureCode: failureCode && FAILURE_CODES.has(failureCode) ? failureCode : null,
  });
}

export function projectGovernedGraphTerminalReceipt(input: GovernedReceiptProjectionInput): GovernedGraphAnyTerminalReceiptDraft {
  if (!SHA.test(input.sourceConfigSha256)) throw new Error('invalid receipt source digest');
  const events = input.journal.readRuntimeEvents(); const sessions = new Set(events.map(event => event.sessionId));
  if (sessions.size !== 1) throw new Error('receipt session identity is not unique');
  const { live, replay } = projectionPair(input.journal);
  const plan = input.claimPlan;
  if (!plan.active) throw new Error('receipt graph plan is not active');
  const graphSemanticDigest = plan?.expansionPlan?.graphSemanticDigest;
  if (typeof graphSemanticDigest !== 'string' || !SHA.test(graphSemanticDigest)) throw new Error('invalid receipt graph digest');
  if (canonicalJson(live) !== canonicalJson(replay)) throw new Error('receipt projection replay mismatch');
  const sessionId = [...sessions][0];
  if (Buffer.byteLength(sessionId, 'utf8') > 256) throw new Error('receipt session identity is oversized');
  const instances = Object.values(live.instancesById);
  const activeInstances = instances.filter(instance => instance.status === 'active');
  const activeComponentWorkItems = Object.values(live.claimsById).filter((claim: any) => claim.active && claim.claim === COMPONENT_WORK_ITEM_CLAIM);
  if (activeComponentWorkItems.length > 1) return projectMultiComponentReceipt(input, live, replay, sessionId, graphSemanticDigest);
  if (instances.length !== 1 || activeInstances.length !== 1) throw new Error('receipt topology is not one active component');
  const component = activeInstances[0];
  if (component.sessionId !== sessionId || component.parentSubgraphInstanceId !== undefined || component.scope.length !== 1 || component.scope[0].kind !== 'keyed') throw new Error('receipt topology is not one deterministic root component');
  if (instances.some(instance => instance.sessionId !== sessionId)) throw new Error('receipt instance session identity is not unique');
  const generations = Object.values(live.generationsById);
  const reservedGenerationKeys = new Set(['inspect', 'proof_admit', 'verify']);
  for (const generation of generations) {
    if (reservedGenerationKeys.has(generation.templateNodeKey) || reservedGenerationKeys.has(generation.checkId)) {
      if (generation.templateNodeKey !== generation.checkId || !reservedGenerationKeys.has(generation.templateNodeKey)) throw new Error('receipt graph generation key is not exact');
    }
  }
  const nodes = { inspect: nodeSummary(generations, 'inspect'), proof_admit: nodeSummary(generations, 'proof_admit'), verify: nodeSummary(generations, 'verify') };
  if (Object.values(nodes).some(node => node.status === 'nonterminal')) throw new Error('receipt graph is not terminal');
  const managed = Object.values(live.managedRunsByAttemptId);
  const componentScope = canonicalJson(component.scope);
  for (const run of managed) {
    const binding = run.binding;
    const generation = live.generationsById[binding.nodeGenerationId];
    if (binding.sessionId !== sessionId || canonicalJson(binding.scope) !== componentScope || !generation || generation.subgraphInstanceId !== component.subgraphInstanceId || canonicalJson(generation.scope) !== componentScope) throw new Error('receipt managed run is outside the component binding');
  }
  const managedUncleanTerminalCount = managed.filter(run => run.status === 'terminated' && run.cleanupStatus !== 'clean').length;
  const nonterminalManagedRuns = managed.filter(run => run.status !== 'terminated');
  if (managedUncleanTerminalCount !== 0 || nonterminalManagedRuns.length !== 0) throw new Error('receipt managed cleanup is not quiescent');
  // The managed lifecycle reducer only records a clean terminal after the
  // provider's cleanup receipt proves both counts are exactly zero.
  const activeChildren = 0; const activeResources = 0;
  const candidate = Object.values(live.claimsById).filter(c => c.active && c.claim === PROOF_CANDIDATE_CLAIM);
  const admitted = Object.values(live.claimsById).filter(c => c.active && c.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  if (candidate.length > 1 || admitted.length > 1) throw new Error('receipt has duplicate reserved claims');
  for (const claim of [...candidate, ...admitted]) if (claim.subgraphInstanceId !== component.subgraphInstanceId || canonicalJson(claim.scope) !== componentScope) throw new Error('receipt reserved claim is outside the component binding');
  const activationEvents: any[] = events.filter(event => event.type === 'NodeGenerationActivated');
  for (const event of activationEvents) {
    if (reservedGenerationKeys.has(event.templateNodeKey) || reservedGenerationKeys.has(event.checkId)) {
      if (event.templateNodeKey !== event.checkId || !reservedGenerationKeys.has(event.templateNodeKey)) throw new Error('receipt graph activation key is not exact');
    }
  }
  const generationFor = (key: string): NodeGenerationProjection[] => generations.filter(g => g.status !== 'inactive' && g.templateNodeKey === key && g.checkId === key);
  const activationFor = (key: string): any[] => activationEvents.filter(event => event.templateNodeKey === key && event.checkId === key && generations.some(generation => generation.nodeGenerationId === event.nodeGenerationId && generation.status !== 'inactive'));
  const inspectGenerations = generationFor('inspect');
  const proofGenerations = generationFor('proof_admit');
  const verifyGenerations = generationFor('verify');
  if (inspectGenerations.length !== 1 || proofGenerations.length !== 1 || verifyGenerations.length > 1) throw new Error('receipt graph generation cardinality is not exact');
  for (const [key, selected] of [['inspect', inspectGenerations], ['proof_admit', proofGenerations], ['verify', verifyGenerations]] as const) {
    const generation = selected[0];
    const activated = activationFor(key);
    if (activated.length !== selected.length || selected.some(value => value.subgraphInstanceId !== component.subgraphInstanceId || canonicalJson(value.scope) !== componentScope)) throw new Error('receipt graph generation is outside the component binding');
    if (generation && (activated.length !== 1 || activated[0].nodeGenerationId !== generation.nodeGenerationId || activated[0].sessionId !== sessionId || activated[0].subgraphInstanceId !== component.subgraphInstanceId || canonicalJson(activated[0].scope) !== componentScope)) throw new Error('receipt graph generation is not journal-bound');
  }
  const verifyEvents = activationFor('verify');
  const verify = verifyGenerations[0];
  const failedRun = managed.find(run => run.controllerDecision === 'failed');
  const failureCode = failedRun?.failureCode ?? null;
  if (failureCode !== null && !FAILURE_CODES.has(failureCode)) throw new Error('receipt failure code is not allowlisted');
  if (verify && (!verifyEvents[0] || canonicalJson(verify.activeInputClaimIds) !== canonicalJson((verifyEvents[0] as any).activeInputClaimIds))) throw new Error('receipt verify inputs are not journal-bound');
  if (!verify && !(failureCode === 'MANAGED_OUTCOME_FAILED' && nodes.proof_admit.status === 'failed' && nodes.verify.status === 'absent')) throw new Error('receipt verify generation is absent without an authoritative proof rejection');
  const componentCount = activeInstances.length;
  const candidateClaimId = candidate[0]?.claimId || null; const admittedReceiptClaimId = admitted[0]?.claimId || null;
  const journalInputs = [...(verify?.activeInputClaimIds || [])];
  if (verify && (!candidateClaimId || !admittedReceiptClaimId || candidateClaimId === admittedReceiptClaimId || canonicalJson([...journalInputs].sort()) !== canonicalJson([candidateClaimId, admittedReceiptClaimId].sort()))) throw new Error('receipt verify inputs are not exact');
  if (!verify && journalInputs.length !== 0) throw new Error('receipt verify inputs are not exact');
  const projectionReplayEqual = canonicalJson(live) === canonicalJson(replay); if (!projectionReplayEqual) throw new Error('receipt projection replay mismatch');
  const verifyInputClaimIds = verify ? [candidateClaimId!, admittedReceiptClaimId!] : [];
  return Object.freeze({ version: GOVERNED_GRAPH_TERMINAL_RECEIPT_SCHEMA, sourceConfigSha256: input.sourceConfigSha256, sessionId, graphSemanticDigest, componentCount, nodes, attestation: selectedAttestation(live), candidateClaimId, admittedReceiptClaimId, verifyInputClaimIds, providerCleanupStatus: managedUncleanTerminalCount === 0 && activeChildren === 0 && activeResources === 0 ? 'clean' : 'unclean', managedUncleanTerminalCount, activeChildren, activeResources, projectionReplayEqual, failureCode: failureCode && FAILURE_CODES.has(failureCode) ? failureCode : null, });
}

export function finalizeGovernedGraphTerminalReceipt(draft: GovernedGraphAnyTerminalReceiptDraft, status: 'passed' | 'failed', memoryStatus: 'clean' | 'failed', exitStatus: 0 | 1): GovernedGraphAnyTerminalReceipt {
  if ((draft as any).version === GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA) {
    const multi = draft as GovernedGraphMultiTerminalReceiptDraft;
    const failedComponents = multi.components.filter(component => component.status === 'failed');
    if (memoryStatus !== 'clean' || !multi.projectionReplayEqual || (status === 'passed' && (exitStatus !== 0 || failedComponents.length > 0 || multi.discovery.status !== 'completed' || multi.failureCode !== null || multi.components.some(component => component.status !== 'passed'))) || (status === 'failed' && exitStatus !== 1)) throw new Error('receipt terminal facts do not satisfy multi-component variant');
    const receipt = Object.freeze({ ...multi, status, memoryStatus, exitStatus });
    validateGovernedGraphTerminalReceipt(receipt);
    return receipt;
  }
  const one = draft as GovernedGraphTerminalReceiptDraft;
  const failureCode = one.failureCode;
  if (memoryStatus !== 'clean' || !one.projectionReplayEqual || (status === 'passed' && exitStatus !== 0) || (status === 'failed' && exitStatus !== 1) || status === 'passed' && (one.nodes.inspect.status !== 'completed' || one.nodes.proof_admit.status !== 'completed' || one.nodes.verify.status !== 'completed' || !one.attestation || !one.candidateClaimId || !one.admittedReceiptClaimId || canonicalJson(one.verifyInputClaimIds) !== canonicalJson([one.candidateClaimId, one.admittedReceiptClaimId]) || one.failureCode !== null)) throw new Error('receipt terminal facts do not satisfy variant');
  const receipt = Object.freeze({ ...one, status, failureCode, memoryStatus, exitStatus });
  validateGovernedGraphTerminalReceipt(receipt);
  return receipt;
}

function validateAttestation(value: unknown, allowNull = true): void {
  if (value === null && allowNull) return;
  const a: any = value;
  if (!plain(a) || !exact(a, ['version','profileId','dispatch','eventCount','usage']) || a.version !== ATTESTATION_VERSION || a.profileId !== ATTESTATION_PROFILE || !plain(a.dispatch) || !exact(a.dispatch, ['source','tool']) || a.dispatch.source !== ATTESTATION_DISPATCH_SOURCE || a.dispatch.tool !== ATTESTATION_DISPATCH_TOOL || !plain(a.usage) || !exact(a.usage, ['status']) || a.usage.status !== 'unavailable' || typeof a.eventCount !== 'number' || !Number.isSafeInteger(a.eventCount) || a.eventCount < 0 || a.eventCount > 1024) throw new Error('invalid governed attestation');
}

function validateMultiTerminalReceipt(value: any): asserts value is GovernedGraphMultiTerminalReceipt {
  const keys = ['version','status','sourceConfigSha256','sessionId','graphSemanticDigest','componentCount','nodes','discovery','components','providerCleanupStatus','managedUncleanTerminalCount','activeChildren','activeResources','memoryStatus','projectionReplayEqual','failureCode','exitStatus'];
  if (!exact(value, keys) || value.version !== GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA) throw new Error('invalid multi-component governed terminal receipt');
  const r: any = value;
  if ((r.status !== 'passed' && r.status !== 'failed') || !SHA.test(r.sourceConfigSha256) || !SHA.test(r.graphSemanticDigest) || !boundedString(r.sessionId, 256) || !Number.isSafeInteger(r.componentCount) || r.componentCount < 2 || r.componentCount > 1024 || !Array.isArray(r.components) || r.components.length !== r.componentCount || r.providerCleanupStatus !== 'clean' || ![r.managedUncleanTerminalCount,r.activeChildren,r.activeResources].every((n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1024) || r.managedUncleanTerminalCount !== 0 || r.activeChildren !== 0 || r.activeResources !== 0 || r.memoryStatus !== 'clean' || r.projectionReplayEqual !== true || (r.failureCode !== null && (typeof r.failureCode !== 'string' || !FAILURE_CODES.has(r.failureCode))) || (r.exitStatus !== 0 && r.exitStatus !== 1)) throw new Error('invalid multi-component governed terminal receipt');
  if (!plain(r.nodes) || !exact(r.nodes, ['inspect','proof_admit','verify'])) throw new Error('invalid governed node summary');
  for (const key of ['inspect','proof_admit','verify']) {
    const node: any = ((r.nodes as any)[key] as any);
    if (!plain(node) || !exact(node, ['terminalCount','status'])) throw new Error('invalid governed node summary');
    const n: any = node;
    if (!Number.isSafeInteger(n.terminalCount) || n.terminalCount < 0 || n.terminalCount > 1024 || !['completed','failed','nonterminal','absent'].includes(n.status)) throw new Error('invalid governed node summary');
  }
  const discovery: any = r.discovery as any;
  if (!plain(discovery) || !exact(discovery, ['candidateClaimId','admittedReceiptClaimId','verifyInputClaimIds','structuralInventoryClaimId','catalogRevalidationClaimId','projectReconciliationClaimId','projectReconciliationInputClaimIds','attestation','status'])) throw new Error('invalid governed discovery receipt');
  const d: any = discovery;
  if (!SHA.test(d.candidateClaimId) || !SHA.test(d.admittedReceiptClaimId) || !SHA.test(d.structuralInventoryClaimId) || !SHA.test(d.catalogRevalidationClaimId) || !SHA.test(d.projectReconciliationClaimId) || !Array.isArray(d.verifyInputClaimIds) || d.verifyInputClaimIds.length < 1 || d.verifyInputClaimIds.some((id: unknown) => typeof id !== 'string' || !SHA.test(id)) || !d.verifyInputClaimIds.includes(d.candidateClaimId) || canonicalJson([...d.verifyInputClaimIds].sort()) !== canonicalJson(d.verifyInputClaimIds) || !Array.isArray(d.projectReconciliationInputClaimIds) || d.projectReconciliationInputClaimIds.some((id: unknown) => typeof id !== 'string' || !SHA.test(id)) || canonicalJson([...d.projectReconciliationInputClaimIds].sort()) !== canonicalJson(d.projectReconciliationInputClaimIds) || !d.projectReconciliationInputClaimIds.includes(d.catalogRevalidationClaimId) || d.status !== 'completed') throw new Error('invalid governed discovery receipt');
  validateAttestation(d.attestation);
  let previousKey: string | undefined;
  const componentKeys = new Set<string>();
  for (const componentValue of r.components as any[]) {
    const component: any = componentValue as any;
    if (!plain(component) || !exact(component, ['componentKey','scope','workItemClaimId','candidateClaimId','admittedReceiptClaimId','generation','verifyInputClaimIds','attestation','status','cleanupStatus'])) throw new Error('invalid governed component receipt');
    const c: any = component;
    let validatedScope;
    try { validatedScope = requireKeyedScopePath(c.scope); } catch { throw new Error('invalid governed component receipt'); }
    if (!boundedString(c.componentKey, 256) || validatedScope[validatedScope.length - 1].key !== c.componentKey || !SHA.test(c.workItemClaimId) || !SHA.test(c.candidateClaimId) || (c.admittedReceiptClaimId !== null && !SHA.test(c.admittedReceiptClaimId)) || !Array.isArray(c.verifyInputClaimIds) || (c.status !== 'passed' && c.status !== 'failed') || c.cleanupStatus !== 'clean') throw new Error('invalid governed component receipt');
    if (previousKey !== undefined && previousKey >= c.componentKey) throw new Error('governed components are not sorted');
    previousKey = c.componentKey;
    if (componentKeys.has(c.componentKey)) throw new Error('duplicate governed component receipt');
    componentKeys.add(c.componentKey);
    const generation: any = c.generation as any;
    if (!plain(generation) || !exact(generation, ['inspect','proof_admit','verify'])) throw new Error('invalid governed component generations');
    for (const key of ['inspect','proof_admit','verify']) {
      const node: any = generation[key];
      if (!plain(node) || !exact(node, ['generationId','status'])) throw new Error('invalid governed component generation');
      const n: any = node;
      if ((n.generationId !== null && !SHA.test(n.generationId)) || !['completed','failed','nonterminal','absent'].includes(n.status) || (n.status === 'absent' && n.generationId !== null) || (n.status !== 'absent' && n.generationId === null)) throw new Error('invalid governed component generation');
    }
    validateAttestation(c.attestation);
    if (!c.attestation || c.admittedReceiptClaimId === null || ['inspect','proof_admit','verify'].some(key => !['completed','failed'].includes((generation as any)[key].status)) || c.verifyInputClaimIds.length !== 2 || canonicalJson([...c.verifyInputClaimIds].sort()) !== canonicalJson([c.candidateClaimId, c.admittedReceiptClaimId].sort())) throw new Error('invalid incomplete governed component');
    if (c.status === 'passed' && (!c.attestation || (generation as any).inspect.status !== 'completed' || (generation as any).proof_admit.status !== 'completed' || (generation as any).verify.status !== 'completed' || c.admittedReceiptClaimId === null || c.candidateClaimId === c.admittedReceiptClaimId || c.workItemClaimId === c.candidateClaimId || c.verifyInputClaimIds.length !== 2 || canonicalJson([...c.verifyInputClaimIds].sort()) !== canonicalJson([c.candidateClaimId, c.admittedReceiptClaimId].sort()))) throw new Error('invalid passed governed component');
  }
  if (['inspect','proof_admit','verify'].some(key => r.nodes[key].status !== 'completed' || r.nodes[key].terminalCount !== r.componentCount)) throw new Error('multi-component governed receipt has a nonterminal aggregate');
  const expectedReconciliationInputs = [d.catalogRevalidationClaimId, ...r.components.map((component: any) => component.admittedReceiptClaimId)].sort();
  if (canonicalJson(d.projectReconciliationInputClaimIds) !== canonicalJson(expectedReconciliationInputs)) throw new Error('invalid whole-project reconciliation inputs');
  if (r.status === 'passed' && (r.exitStatus !== 0 || r.memoryStatus !== 'clean' || r.failureCode !== null || r.discovery.status !== 'completed' || r.nodes.inspect.status !== 'completed' || r.nodes.inspect.terminalCount !== r.componentCount || r.nodes.proof_admit.status !== 'completed' || r.nodes.proof_admit.terminalCount !== r.componentCount || r.nodes.verify.status !== 'completed' || r.nodes.verify.terminalCount !== r.componentCount || r.components.some((component: any) => component.status !== 'passed'))) throw new Error('invalid passed multi-component governed receipt');
  const canonical = canonicalJson(value); if (!canonical.endsWith('}') || Buffer.byteLength(canonical + '\n', 'utf8') > 262144) throw new Error('governed receipt is oversized or noncanonical');
}

export function validateGovernedGraphTerminalReceipt(value: unknown): asserts value is GovernedGraphAnyTerminalReceipt {
  if (plain(value) && value.version === GOVERNED_GRAPH_MULTI_TERMINAL_RECEIPT_SCHEMA) {
    if (!material(value)) throw new Error('invalid governed terminal receipt');
    validateMultiTerminalReceipt(value);
    return;
  }
  const keys = ['version','status','sourceConfigSha256','sessionId','graphSemanticDigest','componentCount','nodes','attestation','candidateClaimId','admittedReceiptClaimId','verifyInputClaimIds','providerCleanupStatus','managedUncleanTerminalCount','activeChildren','activeResources','memoryStatus','projectionReplayEqual','failureCode','exitStatus'];
  if (!plain(value) || !exact(value, keys) || !material(value)) throw new Error('invalid governed terminal receipt');
  const r: any = value;
  if (r.version !== GOVERNED_GRAPH_TERMINAL_RECEIPT_SCHEMA || (r.status !== 'passed' && r.status !== 'failed') || !SHA.test(r.sourceConfigSha256) || !SHA.test(r.graphSemanticDigest) || !boundedString(r.sessionId, 256) || r.componentCount !== 1 || r.providerCleanupStatus !== 'clean' || ![r.managedUncleanTerminalCount,r.activeChildren,r.activeResources].every((n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1024) || r.managedUncleanTerminalCount !== 0 || r.activeChildren !== 0 || r.activeResources !== 0 || (r.memoryStatus !== 'clean' && r.memoryStatus !== 'failed') || r.projectionReplayEqual !== true || (r.failureCode !== null && (typeof r.failureCode !== 'string' || !FAILURE_CODES.has(r.failureCode))) || (r.exitStatus !== 0 && r.exitStatus !== 1) || !Array.isArray(r.verifyInputClaimIds) || r.verifyInputClaimIds.length > 2 || r.verifyInputClaimIds.some((id: unknown) => typeof id !== 'string' || !SHA.test(id))) throw new Error('invalid governed terminal receipt');
  if (!plain(r.nodes) || !exact(r.nodes, ['inspect','proof_admit','verify'])) throw new Error('invalid governed node summary');
  const nodeMap: any = r.nodes as any;
  for (const key of ['inspect','proof_admit','verify']) { const node: any = nodeMap[key] as any; if (!plain(node) || !exact(node, ['terminalCount','status'])) throw new Error('invalid governed node summary'); const n: any = node as any; if (!Number.isSafeInteger(n.terminalCount) || n.terminalCount < 0 || n.terminalCount > 1024 || !['completed','failed','nonterminal','absent'].includes(n.status)) throw new Error('invalid governed node summary'); }
  for (const id of ['candidateClaimId','admittedReceiptClaimId']) if (r[id] !== null && (typeof r[id] !== 'string' || !SHA.test(r[id]))) throw new Error('invalid governed claim ID');
  if (r.status === 'passed' && (r.exitStatus !== 0 || r.memoryStatus !== 'clean' || r.failureCode !== null || nodeMap.inspect.status !== 'completed' || nodeMap.inspect.terminalCount !== 1 || nodeMap.proof_admit.status !== 'completed' || nodeMap.proof_admit.terminalCount !== 1 || nodeMap.verify.status !== 'completed' || nodeMap.verify.terminalCount !== 1 || !r.attestation || !r.candidateClaimId || !r.admittedReceiptClaimId || canonicalJson(r.verifyInputClaimIds) !== canonicalJson([r.candidateClaimId, r.admittedReceiptClaimId]))) throw new Error('invalid passed governed receipt');
  if (r.status === 'failed' && (r.exitStatus !== 1 || r.memoryStatus !== 'clean' || r.failureCode !== 'MANAGED_OUTCOME_FAILED' || nodeMap.inspect.status !== 'completed' || nodeMap.inspect.terminalCount !== 1 || nodeMap.proof_admit.status !== 'failed' || nodeMap.proof_admit.terminalCount !== 1 || nodeMap.verify.status !== 'absent' || nodeMap.verify.terminalCount !== 0 || r.verifyInputClaimIds.length !== 0 || !r.attestation || !r.candidateClaimId || r.admittedReceiptClaimId !== null)) throw new Error('invalid failed governed receipt');
  validateAttestation(r.attestation);
  const canonical = canonicalJson(value); if (!canonical.endsWith('}') || Buffer.byteLength(canonical + '\n', 'utf8') > 65536) throw new Error('governed receipt is oversized or noncanonical');
}

export function serializeGovernedGraphTerminalReceipt(value: GovernedGraphAnyTerminalReceipt): Buffer { validateGovernedGraphTerminalReceipt(value); return Buffer.from(canonicalJson(value) + '\n', 'utf8'); }

function ownedUnlink(file: string, identity: fs.Stats | undefined): void { if (!identity) return; let current: fs.Stats; try { current = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file); }
function verifyOwnedAbsence(file: string, identity: fs.Stats | undefined): void { if (!identity) return; let current: fs.Stats; try { current = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } if (current.dev === identity.dev && current.ino === identity.ino) throw new Error('owned receipt rollback was not absent'); }

export function publishGovernedGraphTerminalReceipt(value: GovernedGraphAnyTerminalReceipt, target: string): void {
  const bytes = serializeGovernedGraphTerminalReceipt(value); if (process.platform === 'win32' || !path.isAbsolute(target)) throw new Error('receipt publication requires an absolute POSIX path');
  const requestedParent = path.dirname(target); const requestedParentStat = fs.lstatSync(requestedParent); if (requestedParentStat.isSymbolicLink() || !requestedParentStat.isDirectory()) throw new Error('receipt parent must be a real directory'); const parent = fs.realpathSync(requestedParent); const parentStat = fs.lstatSync(parent); if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('receipt parent must be a real directory'); const pst = fs.statSync(parent); if (!pst.isDirectory() || (pst.mode & 0o777) !== 0o700) throw new Error('receipt parent must be a private 0700 directory'); const parentIdentity = { dev: pst.dev, ino: pst.ino }; const sameParent = () => { const requested = fs.lstatSync(requestedParent); const canonical = fs.lstatSync(parent); const current = fs.statSync(parent); return !requested.isSymbolicLink() && requested.isDirectory() && !canonical.isSymbolicLink() && canonical.isDirectory() && current.dev === parentIdentity.dev && current.ino === parentIdentity.ino && current.isDirectory() && (current.mode & 0o777) === 0o700; };
  const name = path.basename(target); if (name === '.' || name === '..' || name.length === 0) throw new Error('receipt target must be a regular file name');
  const finalTarget = path.join(parent, name); try { fs.lstatSync(finalTarget); throw new Error('receipt target already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = path.join(parent, `.visor-governed-receipt-${randomBytes(16).toString('hex')}.tmp`); let tempStat: fs.Stats | undefined; let targetStat: fs.Stats | undefined; let fd: number | undefined; let parentFd: number | undefined;
  const syncRollbackParent = (): void => { if (!sameParent()) throw new Error('receipt parent identity changed during rollback'); const rollbackFd = fs.openSync(parent, fs.constants.O_RDONLY); try { fs.fsyncSync(rollbackFd); } finally { fs.closeSync(rollbackFd); } if (!sameParent()) throw new Error('receipt parent identity changed during rollback'); };
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    tempStat = fs.fstatSync(fd); if (!tempStat.isFile() || (tempStat.mode & 0o777) !== 0o600) throw new Error('receipt temporary identity invalid');
    let offset = 0; while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!Number.isInteger(written) || written <= 0) throw new Error('receipt write made no progress'); offset += written; }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; tempStat = fs.lstatSync(temp); if (!tempStat.isFile() || (tempStat.mode & 0o777) !== 0o600 || tempStat.size !== bytes.length) throw new Error('receipt temporary identity invalid');
    if (!sameParent()) throw new Error('receipt parent identity changed'); fs.linkSync(temp, finalTarget); targetStat = fs.lstatSync(finalTarget); if (!targetStat.isFile() || targetStat.dev !== tempStat.dev || targetStat.ino !== tempStat.ino || (targetStat.mode & 0o777) !== 0o600 || targetStat.size !== bytes.length) throw new Error('receipt target identity invalid');
    if (!sameParent()) throw new Error('receipt parent identity changed'); fs.unlinkSync(temp); tempStat = undefined; if (!sameParent()) throw new Error('receipt parent identity changed'); parentFd = fs.openSync(parent, fs.constants.O_RDONLY); fs.fsyncSync(parentFd); if (!sameParent()) throw new Error('receipt parent identity changed'); fs.closeSync(parentFd); parentFd = undefined;
  } catch (error) { let rollbackError: unknown; try { if (fd !== undefined) fs.closeSync(fd); } catch (closeError) { rollbackError ||= closeError; } try { if (parentFd !== undefined) fs.closeSync(parentFd); } catch (closeError) { rollbackError ||= closeError; } try { ownedUnlink(temp, tempStat); } catch (unlinkError) { rollbackError ||= unlinkError; } try { ownedUnlink(finalTarget, targetStat); } catch (unlinkError) { rollbackError ||= unlinkError; } try { if (targetStat) syncRollbackParent(); } catch (syncError) { rollbackError ||= syncError; } try { verifyOwnedAbsence(temp, tempStat); } catch (absenceError) { rollbackError ||= absenceError; } try { verifyOwnedAbsence(finalTarget, targetStat); } catch (absenceError) { rollbackError ||= absenceError; } if (rollbackError) throw new Error(`receipt rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); throw error; }
}
