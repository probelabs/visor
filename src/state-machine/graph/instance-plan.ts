import { TextDecoder } from 'util';
import type {
  CheckConfig,
  ClaimConsumptionConfig,
  ClaimEmissionConfig,
  ClaimTypeConfig,
  ExpansionConfig,
  SubgraphConfig,
  VisorConfig,
  WaitForExpansionConfig,
} from '../../types/config';
import {
  immutableCanonicalValue,
  sha256Canonical,
  type ClaimSchemaValidator,
} from './claim-kernel';
import { PROOF_ROLE_AUTHORITY_CLAIM, isGovernedProofComponentSelector } from '../../providers/governed-proof-inspect-check-provider';

const CLAIM_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[1-9][0-9]*$/;
const BINDING_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const CONTROLLER_TIMEOUT_MIN = 1;
const CONTROLLER_TIMEOUT_MAX = 2147483647;

/** Reserved EXP-0205 admission profile identifiers. */
export const PROOF_CANDIDATE_CLAIM = 'proof.candidate@1';
export const PROOF_ADMITTED_RECEIPT_CLAIM = 'proof.admitted_receipt@1';
/** Reserved only for the opt-in discovery-admission egress suffix. */
export const PROOF_CATALOG_REVALIDATION_CLAIM = 'proof.catalog_revalidation@1';
export const PROOF_STRUCTURAL_INVENTORY_CLAIM = 'proof.structural_inventory@1';
export const PROOF_ADMITTED_CATALOG_PROVIDER_TYPE = 'proof-admitted-catalog';
export const PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE = 'proof-catalog-revalidate';
export const PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE = 'proof-structural-inventory';
export const PROOF_ADMIT_PROVIDER_TYPE = 'proof-admit';
export const GOVERNED_PROOF_INSPECT_PROVIDER_TYPE = 'governed-proof-inspect';
export const PROOF_PROJECT_RECONCILE_PROVIDER_TYPE = 'proof-project-reconcile';
export const PROOF_PROJECT_RECONCILE_NODE_KEY = 'project_reconcile';
export const PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM = 'proof.project_reconciliation_receipt@1';
export const PROOF_ADMIT_NODE_KEY = 'proof_admit';

export class InstancePlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'InstancePlanError';
    this.code = code;
  }
}

export interface CompiledJsonPointer {
  readonly source: string;
  readonly tokens: readonly string[];
}

export interface CompiledTemplateNode {
  readonly templateNodeKey: string;
  readonly check: CheckConfig;
  readonly emissions: readonly ClaimEmissionConfig[];
  readonly consumptions: readonly Required<ClaimConsumptionConfig>[];
  readonly dependencyNodeKeys: readonly string[];
  readonly executionConfigDigest: string;
  readonly waitForExpansion?: Readonly<WaitForExpansionConfig>;
}

export interface CompiledSubgraphTemplate {
  readonly name: string;
  readonly input: Readonly<{ name: string; claim: string }>;
  readonly templateDigest: string;
  readonly templateNodeKeys: readonly string[];
  readonly topology: readonly string[];
  readonly reverseTopology: readonly string[];
  readonly sourceNodeKeys: readonly string[];
  readonly nodesByKey: Readonly<Record<string, CompiledTemplateNode>>;
  readonly emitterByClaim: Readonly<Record<string, string>>;
  readonly dependentsByNode: Readonly<Record<string, readonly string[]>>;
}

export interface CompiledExpansion {
  readonly expansionOwnerCheck: string;
  readonly depth: 1 | 2;
  readonly parentTemplateName: string | null;
  readonly parentTemplateNodeKey: string | null;
  readonly catalogClaimRef: string;
  readonly catalogValidator: ClaimSchemaValidator;
  readonly templateName: string;
  readonly templateDigest: string;
  readonly expansionSpecDigest: string;
  readonly itemsPointer: CompiledJsonPointer;
  readonly keyPointer: CompiledJsonPointer;
  readonly itemClaimRef: string;
  readonly itemValidator: ClaimSchemaValidator;
  readonly template: CompiledSubgraphTemplate;
  readonly coverage?: Readonly<{
    outcomeClaimRef: string;
    classPointer: CompiledJsonPointer;
    emitterNodeKey: string;
  }>;
  readonly graphSemanticDigest: string;
}

export interface ExpansionPlan {
  readonly active: boolean;
  readonly graphSemanticDigest: string;
  readonly byOwner: Readonly<Record<string, CompiledExpansion>>;
  readonly byNestedOwner: Readonly<Record<string, CompiledExpansion>>;
  readonly templatesByName: Readonly<Record<string, CompiledSubgraphTemplate>>;
}

export interface ExpansionCompileAuthority {
  readonly claimTypes: Readonly<Record<string, ClaimTypeConfig>>;
  readonly validatorsByClaim: Readonly<Record<string, ClaimSchemaValidator>>;
  readonly rootEmitterByClaim: Readonly<Record<string, string>>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean { const actual = Reflect.ownKeys(value); return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key) && (() => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor && 'value' in descriptor && descriptor.enumerable; })()); }

function validUnicode(value: string): boolean { for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false; index++; } else if (code >= 0xdc00 && code <= 0xdfff) return false; } return true; }

function validText(value: unknown, max: number, nonempty = true): value is string { return typeof value === 'string' && validUnicode(value) && (!nonempty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= max; }

function validVisible(value: unknown, max: number): value is string { return typeof value === 'string' && validUnicode(value) && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max && /^[\x21-\x7e]+$/.test(value); }

function validDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value); }

function decodeGovernedSchema(value: unknown): string { if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return ''; const bytes = Buffer.from(value, 'base64'); if (bytes.length < 1 || bytes.length > 131072 || bytes.toString('base64') !== value) return ''; try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return validUnicode(decoded) ? decoded : ''; } catch { return ''; } }

function validateControllerAi(name: string, value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) rejectReservedProfile(name, 'inspect ai must be a plain object');
  const keys = Reflect.ownKeys(value); const descriptor = Object.getOwnPropertyDescriptor(value, 'timeout');
  if (keys.length !== 1 || keys[0] !== 'timeout' || !descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value) || descriptor.value < CONTROLLER_TIMEOUT_MIN || descriptor.value > CONTROLLER_TIMEOUT_MAX) rejectReservedProfile(name, 'inspect ai.timeout must be one finite integer from 1 through 2147483647');
}

function componentSelectorTemplateBindingAllowed(inputName: string | undefined, inputClaim: string | undefined, check: CheckConfig): boolean {
  if (inputName !== 'component' || inputClaim !== 'component.work_item@1') return false;
  const consumes = check.consumes;
  if (!Array.isArray(consumes) || consumes.length !== 1) return false;
  const consumption = consumes[0] as unknown as Record<string, unknown>;
  const keys = Reflect.ownKeys(consumption);
  return Object.getPrototypeOf(consumption) === Object.prototype &&
    (keys.length === 2 || (keys.length === 3 && consumption.cardinality === 'one')) &&
    keys.every(key => typeof key === 'string' && (key === 'claim' || key === 'as' || key === 'cardinality')) &&
    consumption.claim === 'component.work_item@1' && consumption.as === 'component';
}

function validateGovernedInspectConfig(name: string, check: CheckConfig, componentSelectorAllowed = false): void {
  const record = check as Record<string, unknown>, allowed = ['type', 'message', 'instructions', 'invocation', 'invocation_digest', 'result_schema', 'profile', 'ai', 'emits', 'consumes', 'expand'], prototype = Object.getPrototypeOf(record);
  if ((prototype !== Object.prototype && prototype !== null) || !hasExactKeys(record, Reflect.ownKeys(record).filter(key => typeof key === 'string') as string[])) rejectReservedProfile(name, 'inspect config must be a plain materialized object');
  if (Reflect.ownKeys(record).some(key => typeof key !== 'string' || !allowed.includes(key as string))) rejectReservedProfile(name, 'inspect config contains unknown provider or topology keys');
  validateControllerAi(name, record.ai);
  if (record.profile !== 'luna-xhigh-readonly-v1') rejectReservedProfile(name, 'inspect governed config is invalid');
  if (isGovernedProofComponentSelector(record.invocation)) {
    if (!componentSelectorAllowed) rejectReservedProfile(name, 'component selector is only valid for a component.work_item@1 template input bound as component');
    if (['message', 'instructions', 'invocation_digest', 'result_schema'].some(key => hasOwn(record, key))) rejectReservedProfile(name, 'component selector cannot author resolved Proof fields');
    const selectorInvocation = record.invocation as Record<string, unknown>;
    const decodedSelectorSchema = decodeGovernedSchema(selectorInvocation.output_schema);
    let selectorSchema: unknown;
    try { selectorSchema = JSON.parse(decodedSelectorSchema); } catch { rejectReservedProfile(name, 'component selector output schema is not JSON'); }
    if (!decodedSelectorSchema || !selectorSchema || typeof selectorSchema !== 'object' || Array.isArray(selectorSchema) || !validMaterialized(selectorSchema)) rejectReservedProfile(name, 'component selector output schema is invalid');
    return;
  }
  if (!validText(record.message, 32768) || !validText(record.instructions, 131072) || !validDigest(record.invocation_digest) || !validText(record.result_schema, 131072)) rejectReservedProfile(name, 'inspect governed config is invalid');
  const invocation = record.invocation;
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation) || !hasExactKeys(invocation, ['role_id', 'stance', 'subject', 'output_schema_id', 'output_schema']) || !validMaterialized(invocation)) rejectReservedProfile(name, 'inspect invocation is not closed');
  const invocationRecord = invocation as Record<string, unknown>, subject = invocationRecord.subject;
  if (!validVisible(invocationRecord.role_id, 128) || (invocationRecord.stance !== 'owner' && invocationRecord.stance !== 'external-review') || !validVisible(invocationRecord.output_schema_id, 128) || !subject || typeof subject !== 'object' || Array.isArray(subject) || !hasExactKeys(subject, ['kind', 'id', 'fingerprint']) || !validMaterialized(subject)) rejectReservedProfile(name, 'inspect invocation fields are invalid');
  const subjectRecord = subject as Record<string, unknown>;
  if ((subjectRecord.kind !== 'project' && subjectRecord.kind !== 'requirement') || !validVisible(subjectRecord.id, 128) || !validDigest(subjectRecord.fingerprint)) rejectReservedProfile(name, 'inspect invocation subject is invalid');
  const decoded = decodeGovernedSchema(invocationRecord.output_schema); if (!decoded || record.result_schema !== decoded) rejectReservedProfile(name, 'inspect result schema is not bound to invocation');
  let parsed: unknown; try { parsed = JSON.parse(decoded); } catch { rejectReservedProfile(name, 'inspect output schema is not JSON'); }
  if (!validMaterialized(parsed) || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) rejectReservedProfile(name, 'inspect output schema must be a JSON object');
}

function validMaterialized(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (typeof value === 'string') return validUnicode(value); if (!value || typeof value !== 'object' || seen.has(value)) return false; seen.add(value);
  try {
    if (Array.isArray(value)) { const keys = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, 'length'); if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) || !length || !('value' in length) || length.enumerable) return false; for (const key of keys) { if (key === 'length') continue; const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d) || !d.enumerable) return false; } for (let i = 0; i < value.length; i++) if (!hasOwn(value, String(i))) return false; return value.every(item => validMaterialized(item, seen)); }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false; for (const key of Reflect.ownKeys(value)) { if (typeof key !== 'string') return false; const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d) || !d.enumerable || !validMaterialized(d.value, seen)) return false; } return true;
  } finally { seen.delete(value); }
}

/** Unambiguous static address for one generated expansion owner. */
export function qualifiedNestedExpansionOwner(
  parentTemplateName: string,
  parentTemplateNodeKey: string
): string {
  return JSON.stringify([parentTemplateName, parentTemplateNodeKey]);
}

function frozenRecord<T>(record: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(record);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InstancePlanError('INVALID_EXPANSION_CONFIG', `${field} must be a non-empty string`);
  }
  return value;
}

/** Strict RFC 6901 syntax compilation; no executable selector language is accepted. */
export function compileJsonPointer(pointer: unknown, field: string): CompiledJsonPointer {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
    throw new InstancePlanError(
      'INVALID_JSON_POINTER',
      `${field} must be an RFC 6901 JSON Pointer`
    );
  }
  const tokens = pointer === '' ? [] : pointer.slice(1).split('/');
  const decoded = tokens.map(token => {
    if (/~(?:[^01]|$)/.test(token)) {
      throw new InstancePlanError(
        'INVALID_JSON_POINTER',
        `${field} contains an invalid RFC 6901 escape`
      );
    }
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  return Object.freeze({ source: pointer, tokens: Object.freeze(decoded) });
}

/** Resolve a previously compiled pointer without coercion or fallback lookup. */
export function resolveJsonPointer(value: unknown, pointer: CompiledJsonPointer): unknown {
  let current = value;
  for (const token of pointer.tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        throw new InstancePlanError(
          'JSON_POINTER_NOT_FOUND',
          `Pointer ${pointer.source} does not resolve exactly`
        );
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        throw new InstancePlanError(
          'JSON_POINTER_NOT_FOUND',
          `Pointer ${pointer.source} does not resolve exactly`
        );
      }
      current = current[index];
      continue;
    }
    if (
      !current ||
      typeof current !== 'object' ||
      !hasOwn(current as object, token)
    ) {
      throw new InstancePlanError(
        'JSON_POINTER_NOT_FOUND',
        `Pointer ${pointer.source} does not resolve exactly`
      );
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function dependencyTokens(check: CheckConfig, checkId: string): string[] {
  const raw = check.depends_on;
  const tokens = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const orToken = tokens.find(token => token.includes('|'));
  if (orToken) {
    throw new InstancePlanError(
      'UNSUPPORTED_TEMPLATE_OR_DEPENDENCY',
      `Template check "${checkId}" uses unsupported OR dependency token "${orToken}"`
    );
  }
  return tokens;
}

function hasRouting(check: CheckConfig): boolean {
  return ['on_init', 'on_success', 'on_fail', 'on_finish'].some(field => {
    if (!hasOwn(check, field)) return false;
    const value = check[field as keyof CheckConfig];
    return value !== undefined && value !== null;
  });
}

function resolvedTemplateCheck(check: CheckConfig): CheckConfig {
  const consumptions = (check.consumes || []).map(consumption => ({
    ...consumption,
    cardinality: 'one' as const,
  }));
  return immutableCanonicalValue<CheckConfig>({
    ...check,
    type: check.type || 'ai',
    ...(check.consumes ? { consumes: consumptions } : {}),
  });
}

function compileWaitForExpansion(
  templateName: string,
  nodeKey: string,
  value: unknown,
  siblingKeys: ReadonlySet<string>,
): Readonly<WaitForExpansionConfig> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, ['owner', 'terminal_node'])) {
    throw new InstancePlanError(
      'INVALID_WAIT_FOR_EXPANSION',
      `Template check "${templateName}.${nodeKey}" wait_for_expansion must contain only owner and terminal_node`
    );
  }
  const record = value as Record<string, unknown>;
  const owner = requireNonEmptyString(record.owner, `subgraphs.${templateName}.checks.${nodeKey}.wait_for_expansion.owner`);
  const terminalNode = requireNonEmptyString(record.terminal_node, `subgraphs.${templateName}.checks.${nodeKey}.wait_for_expansion.terminal_node`);
  if (owner === nodeKey || !siblingKeys.has(owner)) {
    throw new InstancePlanError(
      'INVALID_WAIT_FOR_EXPANSION',
      `Template check "${templateName}.${nodeKey}" wait_for_expansion.owner must name a sibling node`
    );
  }
  return Object.freeze({ owner, terminal_node: terminalNode });
}

function claimList(check: CheckConfig, field: 'emits' | 'consumes'): string[] {
  return (check[field] || []).map(declaration => declaration.claim).sort();
}

function validateCatalogEgressConfig(
  templateName: string,
  nodeKey: string,
  check: CheckConfig,
  allowed: readonly string[],
): void {
  const record = check as Record<string, unknown>;
  if (Reflect.ownKeys(record).some(key =>
    typeof key !== 'string' || !allowed.includes(key) ||
    !Object.getOwnPropertyDescriptor(record, key)?.enumerable ||
    !('value' in (Object.getOwnPropertyDescriptor(record, key) || {}))
  )) {
    rejectReservedProfile(templateName, `${nodeKey} contains an unknown or non-materialized key`);
  }
}

function rejectReservedProfile(templateName: string, detail: string): never {
  throw new InstancePlanError(
    'RESERVED_PROOF_ADMISSION_PROFILE',
    `Subgraph template "${templateName}" violates the reserved proof admission profile: ${detail}`
  );
}

/**
 * The proof admission node is deliberately a fixed, tiny profile. It is
 * validated after all ordinary declaration, emitter, dependency, and topology
 * checks so no alternate claim path can be smuggled through a template.
 */
function validateReservedProofAdmissionTemplate(
  name: string,
  inputName: string,
  inputClaim: string,
  nodeKeys: readonly string[],
  resolvedChecks: Readonly<Record<string, CheckConfig>>,
  consumptionsByNode: Readonly<Record<string, readonly Required<ClaimConsumptionConfig>[]>>,
  topology: readonly string[],
  authority: ExpansionCompileAuthority
): void {
  const triggered = nodeKeys.some(nodeKey => {
    const check = resolvedChecks[nodeKey];
    return (
      check.type === PROOF_ADMIT_PROVIDER_TYPE || check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE ||
      check.type === PROOF_ADMITTED_CATALOG_PROVIDER_TYPE ||
      check.type === PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE ||
      check.type === PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE ||
      check.type === PROOF_PROJECT_RECONCILE_PROVIDER_TYPE ||
      claimList(check, 'emits').some(
        claim => claim === PROOF_CANDIDATE_CLAIM || claim === PROOF_ADMITTED_RECEIPT_CLAIM || claim === PROOF_CATALOG_REVALIDATION_CLAIM || claim === PROOF_STRUCTURAL_INVENTORY_CLAIM || claim === PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM
      ) ||
      claimList(check, 'consumes').some(
        claim => claim === PROOF_CANDIDATE_CLAIM || claim === PROOF_ADMITTED_RECEIPT_CLAIM || claim === PROOF_CATALOG_REVALIDATION_CLAIM || claim === PROOF_STRUCTURAL_INVENTORY_CLAIM || claim === PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM
      )
    );
  });
  if (!triggered) return;

  if (!hasOwn(authority.claimTypes, PROOF_CANDIDATE_CLAIM)) {
    rejectReservedProfile(name, `missing ${PROOF_CANDIDATE_CLAIM} declaration`);
  }
  if (!hasOwn(authority.claimTypes, PROOF_ADMITTED_RECEIPT_CLAIM)) {
    rejectReservedProfile(name, `missing ${PROOF_ADMITTED_RECEIPT_CLAIM} declaration`);
  }
  if (
    inputClaim === PROOF_CANDIDATE_CLAIM ||
    inputClaim === PROOF_ADMITTED_RECEIPT_CLAIM
  ) {
    rejectReservedProfile(name, 'a reserved claim cannot be the template input');
  }

  const hasCatalogEgress = nodeKeys.includes('revalidate_catalog') || nodeKeys.includes('materialize_catalog');
  const hasProjectReconciliation = nodeKeys.includes(PROOF_PROJECT_RECONCILE_NODE_KEY);
  const expectedNodes = hasCatalogEgress
    ? [
        'structural_inventory',
        'inspect',
        PROOF_ADMIT_NODE_KEY,
        'verify',
        'revalidate_catalog',
        'materialize_catalog',
        ...(hasProjectReconciliation ? [PROOF_PROJECT_RECONCILE_NODE_KEY] : []),
      ]
    : ['inspect', PROOF_ADMIT_NODE_KEY, 'verify'];
  const expectedNodeKeys = [...expectedNodes].sort();
  if (nodeKeys.length !== expectedNodeKeys.length || nodeKeys.some((key, index) => key !== expectedNodeKeys[index])) {
    rejectReservedProfile(name, `expected exactly the nodes ${expectedNodes.join(', ')}`);
  }
  if (topology.join('\0') !== expectedNodes.join('\0')) {
    rejectReservedProfile(name, `expected topology ${expectedNodes.join(' -> ')}`);
  }

  for (const nodeKey of nodeKeys) {
    const check = resolvedChecks[nodeKey];
    if (hasOwn(check, 'expand') && nodeKey !== 'materialize_catalog') rejectReservedProfile(name, `${nodeKey} cannot use check.expand`);
    if (nodeKey !== PROOF_ADMIT_NODE_KEY && check.type === PROOF_ADMIT_PROVIDER_TYPE) {
      rejectReservedProfile(name, `provider type ${PROOF_ADMIT_PROVIDER_TYPE} is only valid at ${PROOF_ADMIT_NODE_KEY}`);
    }
  }

  const inspect = resolvedChecks.inspect;
  if (inspect.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE) {
    rejectReservedProfile(name, `inspect must have type ${GOVERNED_PROOF_INSPECT_PROVIDER_TYPE}`);
  }
  validateGovernedInspectConfig(name, inspect, componentSelectorTemplateBindingAllowed(inputName, inputClaim, inspect));
  if (claimList(inspect, 'emits').join('\0') !== PROOF_CANDIDATE_CLAIM) {
    rejectReservedProfile(name, `inspect must emit only ${PROOF_CANDIDATE_CLAIM}`);
  }
  const inspectInputs = claimList(inspect, 'consumes');
  const expectedInspectInputs = hasCatalogEgress
    ? [inputClaim, PROOF_STRUCTURAL_INVENTORY_CLAIM].sort()
    : inspectInputs.includes(PROOF_ROLE_AUTHORITY_CLAIM)
    ? [inputClaim, PROOF_ROLE_AUTHORITY_CLAIM].sort()
    : [inputClaim];
  if (
    inspectInputs.length !== expectedInspectInputs.length ||
    inspectInputs.some((claim, index) => claim !== expectedInspectInputs[index])
  ) {
    rejectReservedProfile(name, `inspect must consume the template input claim and, when present, ${PROOF_ROLE_AUTHORITY_CLAIM}`);
  }

  const proofAdmit = resolvedChecks[PROOF_ADMIT_NODE_KEY];
  if (proofAdmit.type !== PROOF_ADMIT_PROVIDER_TYPE) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must have type ${PROOF_ADMIT_PROVIDER_TYPE}`);
  }
  if (claimList(proofAdmit, 'emits').join('\0') !== PROOF_ADMITTED_RECEIPT_CLAIM) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must emit only ${PROOF_ADMITTED_RECEIPT_CLAIM}`);
  }
  if (claimList(proofAdmit, 'consumes').join('\0') !== PROOF_CANDIDATE_CLAIM) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must consume only ${PROOF_CANDIDATE_CLAIM}`);
  }

  const verify = resolvedChecks.verify;
  if (verify.type === PROOF_ADMIT_PROVIDER_TYPE) {
    rejectReservedProfile(name, 'verify cannot use the proof admission provider');
  }
  if (
    claimList(verify, 'emits').length !== 0 ||
    claimList(verify, 'consumes').join('\0') !==
      [PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM].sort().join('\0')
  ) {
    rejectReservedProfile(name, 'verify must consume both reserved claims and emit none');
  }

  // Keep this assertion close to the profile so future changes cannot make
  // the candidate-consumer exemption implicit or broaden it accidentally.
  if (consumptionsByNode[PROOF_ADMIT_NODE_KEY].length !== 1) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must have exactly one candidate consumer`);
  }

  if (hasCatalogEgress) {
    if (!hasOwn(authority.claimTypes, PROOF_STRUCTURAL_INVENTORY_CLAIM)) {
      rejectReservedProfile(name, `missing ${PROOF_STRUCTURAL_INVENTORY_CLAIM} declaration`);
    }
    if (
      !hasOwn(resolvedChecks, 'revalidate_catalog') ||
      !hasOwn(resolvedChecks, 'materialize_catalog')
    ) {
      rejectReservedProfile(name, 'catalog egress requires both revalidate_catalog and materialize_catalog');
    }
    const structuralInventory = resolvedChecks.structural_inventory;
    if (structuralInventory.type !== PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE) {
      rejectReservedProfile(name, `structural_inventory must have type ${PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE}`);
    }
    validateCatalogEgressConfig(name, 'structural_inventory', structuralInventory, ['type', 'consumes', 'emits']);
    if (claimList(structuralInventory, 'consumes').join('\0') !== inputClaim ||
        claimList(structuralInventory, 'emits').join('\0') !== PROOF_STRUCTURAL_INVENTORY_CLAIM) {
      rejectReservedProfile(name, 'structural_inventory must consume the template input and emit only the current Proof inventory');
    }
    if (resolvedChecks.revalidate_catalog.type !== PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE) {
      rejectReservedProfile(name, `revalidate_catalog must have type ${PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE}`);
    }
    validateCatalogEgressConfig(name, 'revalidate_catalog', resolvedChecks.revalidate_catalog, [
      'type', 'depends_on', 'consumes', 'emits',
    ]);
    if (claimList(resolvedChecks.revalidate_catalog, 'emits').join('\0') !== PROOF_CATALOG_REVALIDATION_CLAIM) {
      rejectReservedProfile(name, `revalidate_catalog must emit only ${PROOF_CATALOG_REVALIDATION_CLAIM}`);
    }
    if (
      claimList(resolvedChecks.revalidate_catalog, 'consumes').join('\0') !==
      [PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM].sort().join('\0')
    ) {
      rejectReservedProfile(name, 'revalidate_catalog must consume the template input, candidate, and admission receipt');
    }
    const materialize = resolvedChecks.materialize_catalog;
    if (materialize.type !== PROOF_ADMITTED_CATALOG_PROVIDER_TYPE) {
      rejectReservedProfile(name, `materialize_catalog must have type ${PROOF_ADMITTED_CATALOG_PROVIDER_TYPE}`);
    }
    validateCatalogEgressConfig(name, 'materialize_catalog', materialize, [
      'type', 'consumes', 'emits', 'expand',
    ]);
    if (!materialize.expand || typeof materialize.expand !== 'object' || Array.isArray(materialize.expand)) {
      rejectReservedProfile(name, 'materialize_catalog must own a downstream expansion');
    }
    if (claimList(materialize, 'emits').length !== 1 || claimList(materialize, 'emits')[0] === PROOF_CANDIDATE_CLAIM || claimList(materialize, 'emits')[0] === PROOF_ADMITTED_RECEIPT_CLAIM || claimList(materialize, 'emits')[0] === PROOF_CATALOG_REVALIDATION_CLAIM) {
      rejectReservedProfile(name, 'materialize_catalog must emit exactly one non-reserved catalog claim');
    }
    if (
      claimList(materialize, 'consumes').join('\0') !==
      [PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM, PROOF_CATALOG_REVALIDATION_CLAIM].sort().join('\0')
    ) {
      rejectReservedProfile(name, 'materialize_catalog must consume the template input, candidate, admission receipt, and current revalidation');
    }

    if (hasProjectReconciliation) {
      const reconciliation = resolvedChecks[PROOF_PROJECT_RECONCILE_NODE_KEY];
      if (reconciliation.type !== PROOF_PROJECT_RECONCILE_PROVIDER_TYPE) {
        rejectReservedProfile(
          name,
          `${PROOF_PROJECT_RECONCILE_NODE_KEY} must have type ${PROOF_PROJECT_RECONCILE_PROVIDER_TYPE}`
        );
      }
      validateCatalogEgressConfig(name, PROOF_PROJECT_RECONCILE_NODE_KEY, reconciliation, [
        'type',
        'depends_on',
        'wait_for_expansion',
        'emits',
      ]);
      const dependencies = dependencyTokens(
        reconciliation,
        `${name}.${PROOF_PROJECT_RECONCILE_NODE_KEY}`
      );
      if (dependencies.length !== 1 || dependencies[0] !== 'materialize_catalog') {
        rejectReservedProfile(
          name,
          `${PROOF_PROJECT_RECONCILE_NODE_KEY} must depend only on materialize_catalog`
        );
      }
      if (claimList(reconciliation, 'emits').join('\0') !== PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM) {
        rejectReservedProfile(
          name,
          `${PROOF_PROJECT_RECONCILE_NODE_KEY} must emit only ${PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM}`
        );
      }
      const wait = reconciliation.wait_for_expansion;
      if (
        !wait ||
        typeof wait !== 'object' ||
        Array.isArray(wait) ||
        !hasExactKeys(wait, ['owner', 'terminal_node']) ||
        (wait as Record<string, unknown>).owner !== 'materialize_catalog' ||
        (wait as Record<string, unknown>).terminal_node !== 'verify'
      ) {
        rejectReservedProfile(
          name,
          `${PROOF_PROJECT_RECONCILE_NODE_KEY} must wait for materialize_catalog terminal verify`
        );
      }
    }
  }
}

function topologicalOrder(
  templateName: string,
  dependencies: Readonly<Record<string, readonly string[]>>
): readonly string[] {
  const remaining = new Map(
    Object.entries(dependencies).map(([node, values]) => [node, new Set(values)])
  );
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, values]) => values.size === 0)
      .map(([node]) => node)
      .sort();
    if (ready.length === 0) {
      throw new InstancePlanError(
        'TEMPLATE_CYCLE',
        `Subgraph template "${templateName}" contains a dependency cycle`
      );
    }
    for (const node of ready) {
      remaining.delete(node);
      order.push(node);
    }
    for (const values of remaining.values()) {
      for (const node of ready) values.delete(node);
    }
  }
  return Object.freeze(order);
}

function compileTemplate(
  name: string,
  authored: SubgraphConfig,
  authority: ExpansionCompileAuthority
): CompiledSubgraphTemplate {
  if (!authored || typeof authored !== 'object' || Array.isArray(authored)) {
    throw new InstancePlanError('INVALID_SUBGRAPH_TEMPLATE', `Subgraph "${name}" must be an object`);
  }
  const inputName = requireNonEmptyString(authored.input?.name, `subgraphs.${name}.input.name`);
  if (!BINDING_NAME_PATTERN.test(inputName)) {
    throw new InstancePlanError(
      'INVALID_TEMPLATE_BINDING',
      `Subgraph "${name}" input name "${inputName}" is not a canonical binding name`
    );
  }
  const inputClaim = requireNonEmptyString(
    authored.input?.claim,
    `subgraphs.${name}.input.claim`
  );
  if (!CLAIM_REF_PATTERN.test(inputClaim) || !hasOwn(authority.claimTypes, inputClaim)) {
    throw new InstancePlanError(
      'UNKNOWN_TEMPLATE_CLAIM',
      `Subgraph "${name}" references undeclared input claim "${inputClaim}"`
    );
  }
  if (!authored.checks || typeof authored.checks !== 'object' || Array.isArray(authored.checks)) {
    throw new InstancePlanError(
      'INVALID_SUBGRAPH_TEMPLATE',
      `Subgraph "${name}" requires a checks map`
    );
  }
  const nodeKeys = Object.keys(authored.checks).sort();
  if (nodeKeys.length === 0 || nodeKeys.some(node => node.length === 0)) {
    throw new InstancePlanError(
      'INVALID_SUBGRAPH_TEMPLATE',
      `Subgraph "${name}" requires at least one named check`
    );
  }

  const resolvedChecks: Record<string, CheckConfig> = {};
  const emitterByClaim: Record<string, string> = {};
  const consumptionsByNode: Record<string, readonly Required<ClaimConsumptionConfig>[]> = {};
  let consumesTemplateInput = false;

  for (const nodeKey of nodeKeys) {
    const check = authored.checks[nodeKey];
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      throw new InstancePlanError(
        'INVALID_TEMPLATE_CHECK',
        `Template check "${name}.${nodeKey}" must be an object`
      );
    }
    if (check.forEach || check.type === 'workflow' || hasRouting(check)) {
      throw new InstancePlanError(
        'UNSUPPORTED_TEMPLATE_EXECUTION',
        `Template check "${name}.${nodeKey}" cannot use forEach, workflow, or lifecycle routing`
      );
    }
    if (check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE) {
      validateGovernedInspectConfig(name, check, componentSelectorTemplateBindingAllowed(inputName, inputClaim, check));
    }
    for (const field of ['emits', 'consumes'] as const) {
      if (hasOwn(check, field) && (!Array.isArray(check[field]) || check[field]!.length === 0)) {
        throw new InstancePlanError(
          'EMPTY_TEMPLATE_CLAIM_DECLARATION',
          `Template check "${name}.${nodeKey}" declares ${field}, which must be a non-empty array`
        );
      }
    }

    const resolved = resolvedTemplateCheck(check);
    const seenClaims = new Set<string>();
    const seenBindings = new Set<string>();
    const consumptions = (resolved.consumes || []).map(consumption => {
      if (
        !CLAIM_REF_PATTERN.test(consumption.claim) ||
        !hasOwn(authority.claimTypes, consumption.claim)
      ) {
        throw new InstancePlanError(
          'UNKNOWN_TEMPLATE_CLAIM',
          `Template check "${name}.${nodeKey}" consumes undeclared claim "${consumption.claim}"`
        );
      }
      if (consumption.cardinality !== 'one') {
        throw new InstancePlanError(
          'UNSUPPORTED_TEMPLATE_CARDINALITY',
          `Template check "${name}.${nodeKey}" supports cardinality one only`
        );
      }
      const binding = requireNonEmptyString(
        consumption.as,
        `subgraphs.${name}.checks.${nodeKey}.consumes.as`
      );
      if (!BINDING_NAME_PATTERN.test(binding)) {
        throw new InstancePlanError(
          'INVALID_TEMPLATE_BINDING',
          `Template check "${name}.${nodeKey}" has invalid binding "${binding}"`
        );
      }
      if (seenClaims.has(consumption.claim) || seenBindings.has(binding)) {
        throw new InstancePlanError(
          'DUPLICATE_TEMPLATE_CONSUMPTION',
          `Template check "${name}.${nodeKey}" has a duplicate claim or binding`
        );
      }
      if (consumption.claim === inputClaim) {
        consumesTemplateInput = true;
        if (binding !== inputName) {
          throw new InstancePlanError(
            'INVALID_TEMPLATE_BINDING',
            `Template input claim "${inputClaim}" must bind as "${inputName}"`
          );
        }
      }
      seenClaims.add(consumption.claim);
      seenBindings.add(binding);
      return Object.freeze({
        claim: consumption.claim,
        cardinality: 'one' as const,
        as: binding,
      });
    });
    consumptionsByNode[nodeKey] = Object.freeze(consumptions);

    for (const emission of resolved.emits || []) {
      if (!CLAIM_REF_PATTERN.test(emission.claim) || !hasOwn(authority.claimTypes, emission.claim)) {
        throw new InstancePlanError(
          'UNKNOWN_TEMPLATE_CLAIM',
          `Template check "${name}.${nodeKey}" emits undeclared claim "${emission.claim}"`
        );
      }
      if (emission.from !== 'output') {
        throw new InstancePlanError(
          'UNSUPPORTED_TEMPLATE_CLAIM_SOURCE',
          `Template check "${name}.${nodeKey}" uses an unsupported claim source`
        );
      }
      if (emission.claim === inputClaim) {
        throw new InstancePlanError(
          'FORGED_CONTROLLER_ITEM_CLAIM',
          `Template check "${name}.${nodeKey}" cannot emit controller input claim "${inputClaim}"`
        );
      }
      const existing = emitterByClaim[emission.claim];
      if (existing) {
        throw new InstancePlanError(
          'DUPLICATE_TEMPLATE_EMITTER',
          `Template claim "${emission.claim}" has duplicate emitters "${existing}" and "${nodeKey}"`
        );
      }
      emitterByClaim[emission.claim] = nodeKey;
    }
    resolvedChecks[nodeKey] = resolved;
  }
  if (!consumesTemplateInput) {
    throw new InstancePlanError(
      'UNUSED_TEMPLATE_INPUT',
      `Subgraph "${name}" has no check consuming its input claim "${inputClaim}"`
    );
  }

  const dependencies: Record<string, readonly string[]> = {};
  for (const nodeKey of nodeKeys) {
    const effective = new Set(dependencyTokens(resolvedChecks[nodeKey], `${name}.${nodeKey}`));
    for (const dependency of effective) {
      if (!hasOwn(resolvedChecks, dependency)) {
        throw new InstancePlanError(
          'UNKNOWN_TEMPLATE_CHECK',
          `Template check "${name}.${nodeKey}" depends on unknown check "${dependency}"`
        );
      }
    }
    for (const consumption of consumptionsByNode[nodeKey]) {
      if (consumption.claim === inputClaim) continue;
      const emitter = emitterByClaim[consumption.claim];
      if (!emitter) {
        throw new InstancePlanError(
          'MISSING_TEMPLATE_EMITTER',
          `Template claim "${consumption.claim}" consumed by "${name}.${nodeKey}" has no template emitter`
        );
      }
      effective.add(emitter);
    }
    dependencies[nodeKey] = Object.freeze([...effective].sort());
  }
  const topology = topologicalOrder(name, dependencies);
  validateReservedProofAdmissionTemplate(
    name,
    inputName,
    inputClaim,
    nodeKeys,
    resolvedChecks,
    consumptionsByNode,
    topology,
    authority
  );
  const dependentsByNode: Record<string, readonly string[]> = {};
  for (const nodeKey of nodeKeys) {
    dependentsByNode[nodeKey] = Object.freeze(
      nodeKeys.filter(candidate => dependencies[candidate].includes(nodeKey)).sort()
    );
  }

  const input = Object.freeze({ name: inputName, claim: inputClaim });
  const resolvedTemplate = immutableCanonicalValue({
    name,
    input,
    checks: resolvedChecks,
  });
  const templateDigest = sha256Canonical({ v: 1, template: resolvedTemplate });
  const nodesByKey: Record<string, CompiledTemplateNode> = {};
  for (const nodeKey of nodeKeys) {
    const check = resolvedChecks[nodeKey];
    const waitForExpansion = compileWaitForExpansion(
      name,
      nodeKey,
      check.wait_for_expansion,
      new Set(nodeKeys),
    );
    if (waitForExpansion &&
        (dependencies[nodeKey].length !== 1 || dependencies[nodeKey][0] !== waitForExpansion.owner ||
          (check.consumes?.length || 0) !== 0)) {
      throw new InstancePlanError(
        'INVALID_WAIT_FOR_EXPANSION',
        `Template check "${name}.${nodeKey}" wait_for_expansion must depend only on its owner and declare no consumes`,
      );
    }
    const executionConfigDigest = sha256Canonical({
      v: 1,
      templateDigest,
      templateNodeKey: nodeKey,
      ...(check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE
        ? { authoredProviderConfig: Object.fromEntries(['type', 'message', 'instructions', 'invocation', 'invocation_digest', 'result_schema', 'profile', ...(check.ai ? ['ai'] : [])].filter(key => (check as Record<string, unknown>)[key] !== undefined).map(key => [key, (check as Record<string, unknown>)[key]])) }
        : { resolvedCheck: check }),
    });
    nodesByKey[nodeKey] = Object.freeze({
      templateNodeKey: nodeKey,
      check,
      emissions: Object.freeze([...(check.emits || [])]),
      consumptions: consumptionsByNode[nodeKey],
      dependencyNodeKeys: dependencies[nodeKey],
      executionConfigDigest,
      ...(waitForExpansion ? { waitForExpansion } : {}),
    });
  }

  return Object.freeze({
    name,
    input,
    templateDigest,
    templateNodeKeys: Object.freeze(nodeKeys),
    topology,
    reverseTopology: Object.freeze([...topology].reverse()),
    sourceNodeKeys: Object.freeze(nodeKeys.filter(node => dependencies[node].length === 0)),
    nodesByKey: frozenRecord(nodesByKey),
    emitterByClaim: frozenRecord(emitterByClaim),
    dependentsByNode: frozenRecord(dependentsByNode),
  });
}

function resolvedRootChecks(checks: Record<string, CheckConfig>): Readonly<Record<string, CheckConfig>> {
  const resolved: Record<string, CheckConfig> = {};
  for (const checkId of Object.keys(checks).sort()) {
    resolved[checkId] = immutableCanonicalValue({
      ...checks[checkId],
      type: checks[checkId].type || 'ai',
    });
  }
  return frozenRecord(resolved);
}

/** Compile all dynamic-instance authority once, before any provider can launch. */
export function compileExpansionPlan(
  config: Partial<VisorConfig>,
  authority: ExpansionCompileAuthority
): ExpansionPlan {
  const checks = config.checks || config.steps || {};
  const subgraphs = config.subgraphs;
  const owners = Object.entries(checks).filter(([, check]) => hasOwn(check, 'expand'));
  const hasSubgraphs = hasOwn(config, 'subgraphs');
  const rootWaiter = Object.entries(checks).find(([, check]) => hasOwn(check, 'wait_for_expansion'));
  if (rootWaiter) {
    throw new InstancePlanError(
      'INVALID_WAIT_FOR_EXPANSION',
      `Root check "${rootWaiter[0]}" cannot declare wait_for_expansion; barriers belong to subgraph templates`,
    );
  }
  if (!hasSubgraphs && owners.length === 0) {
    return Object.freeze({
      active: false,
      graphSemanticDigest: sha256Canonical({ v: 1, active: false }),
      byOwner: frozenRecord<CompiledExpansion>({}),
      byNestedOwner: frozenRecord<CompiledExpansion>({}),
      templatesByName: frozenRecord<CompiledSubgraphTemplate>({}),
    });
  }
  if (
    !subgraphs ||
    typeof subgraphs !== 'object' ||
    Array.isArray(subgraphs) ||
    Object.keys(subgraphs).length === 0 ||
    owners.length === 0
  ) {
    throw new InstancePlanError(
      'INCOMPLETE_EXPANSION_CONFIG',
      'Graph v2 C2 requires both a non-empty subgraphs map and a check-local expand block'
    );
  }

  const templatesByName: Record<string, CompiledSubgraphTemplate> = {};
  for (const name of Object.keys(subgraphs).sort()) {
    requireNonEmptyString(name, 'subgraph name');
    templatesByName[name] = compileTemplate(name, subgraphs[name], authority);
  }

  const precompiled: Array<{
    owner: string;
    expansion: ExpansionConfig;
    template: CompiledSubgraphTemplate;
    itemsPointer: CompiledJsonPointer;
    keyPointer: CompiledJsonPointer;
    coverage?: CompiledExpansion['coverage'];
    expansionSpecDigest: string;
  }> = [];
  for (const [owner, check] of owners.sort(([a], [b]) => a.localeCompare(b))) {
    const expansion = check.expand;
    if (!expansion || typeof expansion !== 'object' || Array.isArray(expansion)) {
      throw new InstancePlanError(
        'INVALID_EXPANSION_CONFIG',
        `Check "${owner}" expand must be an object`
      );
    }
    const catalogClaim = requireNonEmptyString(expansion.claim, `checks.${owner}.expand.claim`);
    if (!CLAIM_REF_PATTERN.test(catalogClaim) || !authority.validatorsByClaim[catalogClaim]) {
      throw new InstancePlanError(
        'UNKNOWN_EXPANSION_CLAIM',
        `Check "${owner}" expands undeclared catalog claim "${catalogClaim}"`
      );
    }
    const matchingEmissions = (check.emits || []).filter(emission => emission.claim === catalogClaim);
    if (matchingEmissions.length !== 1 || authority.rootEmitterByClaim[catalogClaim] !== owner) {
      throw new InstancePlanError(
        'INVALID_EXPANSION_OWNER',
        `Check "${owner}" must be the sole emitter of expanded claim "${catalogClaim}"`
      );
    }
    const itemClaim = requireNonEmptyString(
      expansion.item_claim,
      `checks.${owner}.expand.item_claim`
    );
    if (!CLAIM_REF_PATTERN.test(itemClaim) || !authority.validatorsByClaim[itemClaim]) {
      throw new InstancePlanError(
        'UNKNOWN_ITEM_CLAIM',
        `Check "${owner}" references undeclared item claim "${itemClaim}"`
      );
    }
    if (authority.rootEmitterByClaim[itemClaim]) {
      throw new InstancePlanError(
        'FORGED_CONTROLLER_ITEM_CLAIM',
        `Item claim "${itemClaim}" is controller-owned and cannot have a root emitter`
      );
    }
    const templateName = requireNonEmptyString(
      expansion.template,
      `checks.${owner}.expand.template`
    );
    const template = templatesByName[templateName];
    if (!template) {
      throw new InstancePlanError(
        'UNKNOWN_SUBGRAPH_TEMPLATE',
        `Check "${owner}" references unknown subgraph template "${templateName}"`
      );
    }
    if (template.input.claim !== itemClaim) {
      throw new InstancePlanError(
        'ITEM_CLAIM_MISMATCH',
        `Check "${owner}" item claim "${itemClaim}" does not match template input "${template.input.claim}"`
      );
    }
    const itemsPointer = compileJsonPointer(
      expansion.items_pointer,
      `checks.${owner}.expand.items_pointer`
    );
    const keyPointer = compileJsonPointer(
      expansion.key_pointer,
      `checks.${owner}.expand.key_pointer`
    );
    let coverage: CompiledExpansion['coverage'];
    if (expansion.coverage !== undefined) {
      if (!expansion.coverage || typeof expansion.coverage !== 'object' || Array.isArray(expansion.coverage)) {
        throw new InstancePlanError('INVALID_COVERAGE_CONFIG', `Check "${owner}" coverage must be an object`);
      }
      const outcomeClaimRef = requireNonEmptyString(
        expansion.coverage.outcome_claim,
        `checks.${owner}.expand.coverage.outcome_claim`
      );
      if (
        !CLAIM_REF_PATTERN.test(outcomeClaimRef) ||
        !authority.validatorsByClaim[outcomeClaimRef] ||
        outcomeClaimRef === catalogClaim ||
        outcomeClaimRef === itemClaim ||
        outcomeClaimRef === template.input.claim
      ) {
        throw new InstancePlanError(
          'INVALID_COVERAGE_OUTCOME_CLAIM',
          `Check "${owner}" coverage outcome must be a distinct declared template claim`
        );
      }
      const emitterNodeKey = template.emitterByClaim[outcomeClaimRef];
      if (!emitterNodeKey || template.dependentsByNode[emitterNodeKey].length !== 0) {
        throw new InstancePlanError(
          'INVALID_COVERAGE_OUTCOME_EMITTER',
          `Check "${owner}" coverage outcome must have exactly one sink emitter`
        );
      }
      coverage = Object.freeze({
        outcomeClaimRef,
        emitterNodeKey,
        classPointer: compileJsonPointer(
          expansion.coverage.class_pointer,
          `checks.${owner}.expand.coverage.class_pointer`
        ),
      });
    }
    const expansionSpecDigest = sha256Canonical({
      v: 1,
      expansionOwnerCheck: owner,
      catalogClaimRef: catalogClaim,
      templateName,
      templateDigest: template.templateDigest,
      itemsPointer: itemsPointer.source,
      keyPointer: keyPointer.source,
      itemClaimRef: itemClaim,
      ...(coverage
        ? {
            coverage: {
              outcomeClaimRef: coverage.outcomeClaimRef,
              classPointer: coverage.classPointer.source,
              emitterNodeKey: coverage.emitterNodeKey,
            },
          }
        : {}),
    });
    precompiled.push({
      owner,
      expansion,
      template,
      itemsPointer,
      keyPointer,
      coverage,
      expansionSpecDigest,
    });
  }

  const graphSemanticDigest = sha256Canonical({
    v: 1,
    claimTypes: authority.claimTypes,
    checks: resolvedRootChecks(checks),
    subgraphs: Object.fromEntries(
      Object.entries(templatesByName).map(([name, template]) => [
        name,
        {
          input: template.input,
          checks: Object.fromEntries(
            template.templateNodeKeys.map(node => [node, template.nodesByKey[node].check])
          ),
        },
      ])
    ),
  });
  const byOwner: Record<string, CompiledExpansion> = {};
  for (const compiled of precompiled) {
    const expansion = compiled.expansion;
    byOwner[compiled.owner] = Object.freeze({
      expansionOwnerCheck: compiled.owner,
      depth: 1,
      parentTemplateName: null,
      parentTemplateNodeKey: null,
      catalogClaimRef: expansion.claim,
      catalogValidator: authority.validatorsByClaim[expansion.claim],
      templateName: expansion.template,
      templateDigest: compiled.template.templateDigest,
      expansionSpecDigest: compiled.expansionSpecDigest,
      itemsPointer: compiled.itemsPointer,
      keyPointer: compiled.keyPointer,
      itemClaimRef: expansion.item_claim,
      itemValidator: authority.validatorsByClaim[expansion.item_claim],
      template: compiled.template,
      ...(compiled.coverage ? { coverage: compiled.coverage } : {}),
      graphSemanticDigest,
    });
  }

  const nestedDeclarations = Object.values(templatesByName).flatMap(template =>
    template.templateNodeKeys
      .filter(nodeKey => hasOwn(template.nodesByKey[nodeKey].check, 'expand'))
      .map(nodeKey => ({ template, nodeKey, check: template.nodesByKey[nodeKey].check }))
  );
  if (nestedDeclarations.length > 1) {
    throw new InstancePlanError(
      'NESTED_EXPANSION_AMBIGUOUS',
      'Graph v2 C4 admits exactly one generated expansion owner'
    );
  }

  const byNestedOwner: Record<string, CompiledExpansion> = {};
  if (nestedDeclarations.length === 1) {
    const { template: parentTemplate, nodeKey, check } = nestedDeclarations[0];
    if (!precompiled.some(candidate => candidate.template.name === parentTemplate.name)) {
      throw new InstancePlanError(
        'UNREACHABLE_NESTED_EXPANSION',
        `Nested expansion owner "${parentTemplate.name}.${nodeKey}" is not in a root-expanded template`
      );
    }
    const expansion = check.expand;
    if (!expansion || typeof expansion !== 'object' || Array.isArray(expansion)) {
      throw new InstancePlanError(
        'INVALID_EXPANSION_CONFIG',
        `Template check "${parentTemplate.name}.${nodeKey}" expand must be an object`
      );
    }
    const ownerAddress = qualifiedNestedExpansionOwner(parentTemplate.name, nodeKey);
    const catalogClaim = requireNonEmptyString(
      expansion.claim,
      `subgraphs.${parentTemplate.name}.checks.${nodeKey}.expand.claim`
    );
    if (!CLAIM_REF_PATTERN.test(catalogClaim) || !authority.validatorsByClaim[catalogClaim]) {
      throw new InstancePlanError(
        'UNKNOWN_EXPANSION_CLAIM',
        `Template check "${parentTemplate.name}.${nodeKey}" expands undeclared catalog claim "${catalogClaim}"`
      );
    }
    const matchingEmissions = (check.emits || []).filter(
      emission => emission.claim === catalogClaim
    );
    if (
      matchingEmissions.length !== 1 ||
      parentTemplate.emitterByClaim[catalogClaim] !== nodeKey
    ) {
      throw new InstancePlanError(
        'INVALID_EXPANSION_OWNER',
        `Template check "${parentTemplate.name}.${nodeKey}" must be the sole template emitter of expanded claim "${catalogClaim}"`
      );
    }
    const itemClaim = requireNonEmptyString(
      expansion.item_claim,
      `subgraphs.${parentTemplate.name}.checks.${nodeKey}.expand.item_claim`
    );
    if (!CLAIM_REF_PATTERN.test(itemClaim) || !authority.validatorsByClaim[itemClaim]) {
      throw new InstancePlanError(
        'UNKNOWN_ITEM_CLAIM',
        `Template check "${parentTemplate.name}.${nodeKey}" references undeclared item claim "${itemClaim}"`
      );
    }
    if (
      authority.rootEmitterByClaim[itemClaim] ||
      Object.values(templatesByName).some(candidate => candidate.emitterByClaim[itemClaim])
    ) {
      throw new InstancePlanError(
        'FORGED_CONTROLLER_ITEM_CLAIM',
        `Nested item claim "${itemClaim}" is controller-owned and cannot have an emitter`
      );
    }
    const templateName = requireNonEmptyString(
      expansion.template,
      `subgraphs.${parentTemplate.name}.checks.${nodeKey}.expand.template`
    );
    const childTemplate = templatesByName[templateName];
    if (!childTemplate) {
      throw new InstancePlanError(
        'UNKNOWN_SUBGRAPH_TEMPLATE',
        `Template check "${parentTemplate.name}.${nodeKey}" references unknown subgraph template "${templateName}"`
      );
    }
    if (
      childTemplate.name === parentTemplate.name ||
      childTemplate.templateNodeKeys.some(childNodeKey =>
        hasOwn(childTemplate.nodesByKey[childNodeKey].check, 'expand')
      )
    ) {
      throw new InstancePlanError(
        'NESTED_EXPANSION_DEPTH_EXCEEDED',
        'Graph v2 C4 rejects recursive, cyclic, or depth-three expansion'
      );
    }
    if (childTemplate.input.claim !== itemClaim) {
      throw new InstancePlanError(
        'ITEM_CLAIM_MISMATCH',
        `Nested item claim "${itemClaim}" does not match template input "${childTemplate.input.claim}"`
      );
    }
    const itemsPointer = compileJsonPointer(
      expansion.items_pointer,
      `subgraphs.${parentTemplate.name}.checks.${nodeKey}.expand.items_pointer`
    );
    const keyPointer = compileJsonPointer(
      expansion.key_pointer,
      `subgraphs.${parentTemplate.name}.checks.${nodeKey}.expand.key_pointer`
    );
    const expansionSpecDigest = sha256Canonical({
      v: 1,
      expansionOwnerCheck: ownerAddress,
      parentTemplateName: parentTemplate.name,
      parentTemplateNodeKey: nodeKey,
      catalogClaimRef: catalogClaim,
      templateName,
      templateDigest: childTemplate.templateDigest,
      itemsPointer: itemsPointer.source,
      keyPointer: keyPointer.source,
      itemClaimRef: itemClaim,
    });
    byNestedOwner[ownerAddress] = Object.freeze({
      expansionOwnerCheck: ownerAddress,
      depth: 2,
      parentTemplateName: parentTemplate.name,
      parentTemplateNodeKey: nodeKey,
      catalogClaimRef: catalogClaim,
      catalogValidator: authority.validatorsByClaim[catalogClaim],
      templateName,
      templateDigest: childTemplate.templateDigest,
      expansionSpecDigest,
      itemsPointer,
      keyPointer,
      itemClaimRef: itemClaim,
      itemValidator: authority.validatorsByClaim[itemClaim],
      template: childTemplate,
      graphSemanticDigest,
    });
  }

  // A wait barrier is intentionally a narrow binding: it can only observe
  // the one already-compiled depth-2 expansion owned by a sibling in this
  // exact parent template, and its terminal node must be a child-template
  // node. This keeps readiness in the existing graph authority rather than
  // introducing a second fan-in topology.
  const waitOwnerByTemplate = new Set<string>();
  for (const template of Object.values(templatesByName)) {
    for (const nodeKey of template.templateNodeKeys) {
      const wait = template.nodesByKey[nodeKey].waitForExpansion;
      if (!wait) continue;
      const nested = byNestedOwner[qualifiedNestedExpansionOwner(template.name, wait.owner)];
      if (!nested) {
        throw new InstancePlanError(
          'INVALID_WAIT_FOR_EXPANSION',
          `Template check "${template.name}.${nodeKey}" wait_for_expansion.owner must own the compiled depth-2 expansion`
        );
      }
      if (!nested.template.nodesByKey[wait.terminal_node]) {
        throw new InstancePlanError(
          'INVALID_WAIT_FOR_EXPANSION',
          `Template check "${template.name}.${nodeKey}" wait_for_expansion.terminal_node must exist in child template "${nested.template.name}"`
        );
      }
      if (nested.template.dependentsByNode[wait.terminal_node].length !== 0) {
        throw new InstancePlanError(
          'INVALID_WAIT_FOR_EXPANSION',
          `Template check "${template.name}.${nodeKey}" wait_for_expansion.terminal_node must be a child-template sink`
        );
      }
      const ownerKey = qualifiedNestedExpansionOwner(template.name, wait.owner);
      if (waitOwnerByTemplate.has(ownerKey)) {
        throw new InstancePlanError(
          'INVALID_WAIT_FOR_EXPANSION',
          `Template "${template.name}" may define only one wait_for_expansion node for owner "${wait.owner}"`
        );
      }
      waitOwnerByTemplate.add(ownerKey);
    }
  }

  return Object.freeze({
    active: true,
    graphSemanticDigest,
    byOwner: frozenRecord(byOwner),
    byNestedOwner: frozenRecord(byNestedOwner),
    templatesByName: frozenRecord(templatesByName),
  });
}
