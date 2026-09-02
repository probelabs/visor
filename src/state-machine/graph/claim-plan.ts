import type {
  CheckConfig,
  ClaimConsumptionConfig,
  ClaimEmissionConfig,
  ClaimTypeConfig,
  VisorConfig,
} from '../../types/config';
import {
  compileClaimSchema,
  immutableCanonicalValue,
  type ClaimSchemaValidator,
} from './claim-kernel';
import {
  compileExpansionPlan,
  PROOF_ADMITTED_CATALOG_PROVIDER_TYPE,
  GOVERNED_PROOF_INSPECT_PROVIDER_TYPE,
  PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE,
  PROOF_ADMIT_PROVIDER_TYPE,
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_CATALOG_REVALIDATION_CLAIM,
  PROOF_CANDIDATE_CLAIM,
  type ExpansionPlan,
} from './instance-plan';

export const CLAIM_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[1-9][0-9]*$/;

export class ClaimPlanError extends Error {
  readonly code: string;

  constructor(message: string, code = 'INVALID_CLAIM_PLAN') {
    super(message);
    this.name = 'ClaimPlanError';
    this.code = code;
  }
}

export interface ClaimPlan {
  readonly active: boolean;
  readonly expansionPlan: ExpansionPlan;
  readonly claimTypes: Readonly<Record<string, ClaimTypeConfig>>;
  readonly validatorsByClaim: Readonly<Record<string, ClaimSchemaValidator>>;
  readonly emitterByClaim: Readonly<Record<string, string>>;
  readonly emissionsByCheck: Readonly<Record<string, readonly ClaimEmissionConfig[]>>;
  readonly consumptionsByCheck: Readonly<Record<string, readonly ClaimConsumptionConfig[]>>;
  readonly effectiveDependenciesByCheck: Readonly<Record<string, readonly string[]>>;
}

function freezeRecord<T>(record: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(record);
}

function dependencyTokens(check: CheckConfig): string[] {
  const raw = check.depends_on;
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap(token =>
    token.includes('|')
      ? token
          .split('|')
          .map(value => value.trim())
          .filter(Boolean)
      : [token]
  );
}

function authoredDependencyTokens(check: CheckConfig): string[] {
  const raw = check.depends_on;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertAcyclic(dependencies: Record<string, readonly string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const trail: string[] = [];

  const visit = (checkId: string): void => {
    if (visited.has(checkId)) return;
    if (visiting.has(checkId)) {
      const start = trail.indexOf(checkId);
      const cycle = [...trail.slice(Math.max(0, start)), checkId].join(' -> ');
      throw new ClaimPlanError(`Claim dependency cycle detected: ${cycle}`);
    }
    visiting.add(checkId);
    trail.push(checkId);
    for (const dependency of dependencies[checkId] || []) {
      if (Object.prototype.hasOwnProperty.call(dependencies, dependency)) visit(dependency);
    }
    trail.pop();
    visiting.delete(checkId);
    visited.add(checkId);
  };

  for (const checkId of Object.keys(dependencies).sort()) visit(checkId);
}

/**
 * Compile authored claim declarations into immutable exact data bindings and
 * effective terminal dependencies. The authored configuration is never mutated.
 */
export function compileClaimPlan(config: Partial<VisorConfig>): ClaimPlan {
  const checks = config.checks || config.steps || {};
  const claimTypes = config.claim_types || {};
  let hasClaimDeclarations = false;
  for (const [checkId, check] of Object.entries(checks)) {
    for (const field of ['emits', 'consumes'] as const) {
      if (!hasOwn(check, field)) continue;
      hasClaimDeclarations = true;
      const declarations = check[field];
      if (!Array.isArray(declarations) || declarations.length === 0) {
        throw new ClaimPlanError(
          `Check "${checkId}" declares ${field}, which must be a non-empty array`,
          'EMPTY_CLAIM_DECLARATION'
        );
      }
    }
  }

  // The reserved admission profile is template-only. Check this before the
  // inactive-plan fast path so a root provider type cannot bypass policy by
  // omitting claim_types (and so reserved root claims cannot become controller
  // inputs or root emissions).
  for (const [checkId, check] of Object.entries(checks)) {
    if (
      check.type === PROOF_ADMIT_PROVIDER_TYPE ||
      check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE ||
      check.type === PROOF_ADMITTED_CATALOG_PROVIDER_TYPE ||
      check.type === PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE
    ) {
      throw new ClaimPlanError(
        `Root check "${checkId}" cannot use a reserved Proof admission provider`,
        'RESERVED_PROOF_ADMISSION_ROOT'
      );
    }
    for (const field of ['emits', 'consumes'] as const) {
      if ((check[field] || []).some(declaration =>
        declaration.claim === PROOF_CANDIDATE_CLAIM ||
        declaration.claim === PROOF_ADMITTED_RECEIPT_CLAIM ||
        declaration.claim === PROOF_CATALOG_REVALIDATION_CLAIM
      )) {
        throw new ClaimPlanError(
          `Root check "${checkId}" cannot declare reserved Proof admission claim`,
          'RESERVED_PROOF_ADMISSION_ROOT'
        );
      }
    }
    const expansion = check.expand;
    if (
      expansion &&
      (expansion.claim === PROOF_CANDIDATE_CLAIM ||
        expansion.claim === PROOF_ADMITTED_RECEIPT_CLAIM ||
        expansion.claim === PROOF_CATALOG_REVALIDATION_CLAIM ||
        expansion.item_claim === PROOF_CANDIDATE_CLAIM ||
        expansion.item_claim === PROOF_ADMITTED_RECEIPT_CLAIM ||
        expansion.item_claim === PROOF_CATALOG_REVALIDATION_CLAIM)
    ) {
      throw new ClaimPlanError(
        `Root check "${checkId}" cannot route a reserved proof admission claim through expansion`,
        'RESERVED_PROOF_ADMISSION_ROOT'
      );
    }
  }

  const active = Object.keys(claimTypes).length > 0;

  if (!active && hasClaimDeclarations) {
    throw new ClaimPlanError('Claim declarations require a non-empty top-level claim_types map');
  }
  if (!active) {
    const effective: Record<string, readonly string[]> = {};
    for (const [checkId, check] of Object.entries(checks)) {
      effective[checkId] = Object.freeze(dependencyTokens(check));
    }
    const expansionPlan = compileExpansionPlan(config, {
      claimTypes: {},
      validatorsByClaim: {},
      rootEmitterByClaim: {},
    });
    return Object.freeze({
      active: false,
      expansionPlan,
      claimTypes: freezeRecord<ClaimTypeConfig>({}),
      validatorsByClaim: freezeRecord<ClaimSchemaValidator>({}),
      emitterByClaim: freezeRecord<string>({}),
      emissionsByCheck: freezeRecord<readonly ClaimEmissionConfig[]>({}),
      consumptionsByCheck: freezeRecord<readonly ClaimConsumptionConfig[]>({}),
      effectiveDependenciesByCheck: freezeRecord(effective),
    });
  }

  const immutableClaimTypes: Record<string, ClaimTypeConfig> = {};
  const validatorsByClaim: Record<string, ClaimSchemaValidator> = {};
  for (const [claim, definition] of Object.entries(claimTypes)) {
    if (!CLAIM_REF_PATTERN.test(claim)) {
      throw new ClaimPlanError(
        `Invalid claim reference "${claim}"; expected <name>@<positive-integer-version>`
      );
    }
    if (
      !definition ||
      typeof definition !== 'object' ||
      !definition.schema ||
      typeof definition.schema !== 'object' ||
      Array.isArray(definition.schema)
    ) {
      throw new ClaimPlanError(`Claim type "${claim}" requires a JSON Schema`);
    }
    const schema = immutableCanonicalValue(definition.schema);
    immutableClaimTypes[claim] = Object.freeze({ schema });
    validatorsByClaim[claim] = compileClaimSchema(schema);
  }

  const emitterByClaim: Record<string, string> = {};
  const emissionsByCheck: Record<string, readonly ClaimEmissionConfig[]> = {};
  const consumptionsByCheck: Record<string, readonly ClaimConsumptionConfig[]> = {};

  for (const [checkId, check] of Object.entries(checks)) {
    const emissions = check.emits || [];
    const consumptions = check.consumes || [];
    if (emissions.length === 0 && consumptions.length === 0) continue;
    if (check.forEach || check.type === 'workflow') {
      throw new ClaimPlanError(
        `Graph v2 C1 claim declarations are root-scope only; check "${checkId}" cannot use forEach or workflow`
      );
    }
    if (emissions.length > 0) {
      emissionsByCheck[checkId] = Object.freeze(
        emissions.map(emission => Object.freeze({ ...emission }))
      );
    }
    if (consumptions.length > 0) {
      consumptionsByCheck[checkId] = Object.freeze(
        consumptions.map(consumption => Object.freeze({ ...consumption }))
      );
    }

    for (const emission of emissions) {
      if (!CLAIM_REF_PATTERN.test(emission.claim)) {
        throw new ClaimPlanError(`Invalid emitted claim reference "${emission.claim}"`);
      }
      if (!Object.prototype.hasOwnProperty.call(claimTypes, emission.claim)) {
        throw new ClaimPlanError(
          `Check "${checkId}" emits undeclared claim "${emission.claim}"`
        );
      }
      if (emission.from !== 'output') {
        throw new ClaimPlanError(
          `Check "${checkId}" uses unsupported claim source "${String(emission.from)}"`
        );
      }
      const existing = emitterByClaim[emission.claim];
      if (existing) {
        throw new ClaimPlanError(
          `Claim "${emission.claim}" has duplicate emitters "${existing}" and "${checkId}"`
        );
      }
      emitterByClaim[emission.claim] = checkId;
    }

    const seenConsumes = new Set<string>();
    for (const consumption of consumptions) {
      if (!CLAIM_REF_PATTERN.test(consumption.claim)) {
        throw new ClaimPlanError(`Invalid consumed claim reference "${consumption.claim}"`);
      }
      if (!Object.prototype.hasOwnProperty.call(claimTypes, consumption.claim)) {
        throw new ClaimPlanError(
          `Check "${checkId}" consumes undeclared claim "${consumption.claim}"`
        );
      }
      if (consumption.cardinality !== 'one') {
        throw new ClaimPlanError(
          `Check "${checkId}" uses unsupported claim cardinality "${String(consumption.cardinality)}"`
        );
      }
      if (seenConsumes.has(consumption.claim)) {
        throw new ClaimPlanError(
          `Check "${checkId}" consumes claim "${consumption.claim}" more than once`
        );
      }
      seenConsumes.add(consumption.claim);
    }
  }

  for (const [checkId, check] of Object.entries(checks)) {
    const orToken = authoredDependencyTokens(check).find(token => token.includes('|'));
    if (orToken) {
      throw new ClaimPlanError(
        `Graph v2 C1 does not support OR dependency token "${orToken}" on check "${checkId}"`,
        'UNSUPPORTED_CLAIM_OR_DEPENDENCY'
      );
    }
  }

  const effectiveDependenciesByCheck: Record<string, readonly string[]> = {};
  for (const [checkId, check] of Object.entries(checks)) {
    const effective = new Set(dependencyTokens(check));
    for (const consumption of consumptionsByCheck[checkId] || []) {
      const emitter = emitterByClaim[consumption.claim];
      if (!emitter) {
        throw new ClaimPlanError(
          `Claim "${consumption.claim}" consumed by "${checkId}" has no emitter`
        );
      }
      effective.add(emitter);
    }
    effectiveDependenciesByCheck[checkId] = Object.freeze([...effective]);
  }

  assertAcyclic(effectiveDependenciesByCheck);

  const expansionPlan = compileExpansionPlan(config, {
    claimTypes: immutableClaimTypes,
    validatorsByClaim,
    rootEmitterByClaim: emitterByClaim,
  });

  return Object.freeze({
    active: true,
    expansionPlan,
    claimTypes: freezeRecord(immutableClaimTypes),
    validatorsByClaim: freezeRecord(validatorsByClaim),
    emitterByClaim: freezeRecord(emitterByClaim),
    emissionsByCheck: freezeRecord(emissionsByCheck),
    consumptionsByCheck: freezeRecord(consumptionsByCheck),
    effectiveDependenciesByCheck: freezeRecord(effectiveDependenciesByCheck),
  });
}
