import {
  CheckProvider,
  init_check_provider_interface
} from "./chunk-326JA6WQ.mjs";
import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-J7LXIPZS.mjs";

// src/state-machine/graph/claim-kernel.ts
import { createHash } from "crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
function assertJsonValue(value, seen) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ClaimKernelError("NON_CANONICAL_JSON", "Non-finite numbers are not canonical JSON");
    }
    return JSON.stringify(value);
  }
  if (value === void 0 || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new ClaimKernelError(
      "NON_CANONICAL_JSON",
      `Unsupported canonical JSON value: ${typeof value}`
    );
  }
  if (typeof value !== "object") {
    throw new ClaimKernelError("NON_CANONICAL_JSON", "Unsupported canonical JSON value");
  }
  if (seen.has(value)) {
    throw new ClaimKernelError("NON_CANONICAL_JSON", "Cyclic values are not canonical JSON");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => assertJsonValue(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ClaimKernelError(
        "NON_CANONICAL_JSON",
        "Only plain objects are canonical JSON objects"
      );
    }
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${assertJsonValue(record[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
function canonicalJson(value) {
  return assertJsonValue(value, /* @__PURE__ */ new Set());
}
function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function freezeJson(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function immutableCanonicalValue(value) {
  return freezeJson(JSON.parse(canonicalJson(value)));
}
function immutableRuntimeEvent(event) {
  return immutableCanonicalValue(event);
}
function attemptProjectionKey(sessionId, checkId, scope) {
  return sha256Canonical({ sessionId, checkId, scope });
}
function createInitialClaimProjection() {
  return immutableCanonicalValue({
    lastEventId: 0,
    attempts: {},
    claims: {},
    activeClaimIdsByRef: {},
    scheduled: []
  });
}
function cloneScope(scope) {
  return scope.map((part) => ({ ...part }));
}
function requireActivePlan(plan) {
  if (!plan.active) {
    throw new ClaimKernelError("CLAIM_MODE_INACTIVE", "Runtime claim events require claim mode");
  }
}
function requireRootScope(scope) {
  if (scope.length !== 0) {
    throw new ClaimKernelError("UNSUPPORTED_CLAIM_SCOPE", "Graph v2 C1 supports root scope only");
  }
}
function requireCurrentAttempt(projection, event) {
  const key = attemptProjectionKey(event.sessionId, event.checkId, event.scope);
  const current = projection.attempts[key];
  if (!current || current.status !== "started" || current.attemptId !== event.attemptId || current.fence !== event.fence) {
    throw new ClaimKernelError(
      "STALE_FENCE",
      `Attempt ${event.attemptId} fence ${event.fence} is not current for ${event.checkId}`
    );
  }
  return current;
}
function sameIds(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
function exactActiveClaimIds(plan, projection, checkId) {
  requireActivePlan(plan);
  if (!Object.prototype.hasOwnProperty.call(plan.effectiveDependenciesByCheck, checkId)) {
    throw new ClaimKernelError("UNKNOWN_CHECK", `Unknown claim-mode check ${checkId}`);
  }
  const ids = (plan.consumptionsByCheck[checkId] || []).map((consumption) => {
    const claimId = projection.activeClaimIdsByRef[consumption.claim];
    const claim2 = claimId ? projection.claims[claimId] : void 0;
    if (!claim2 || claim2.claim !== consumption.claim) {
      throw new ClaimKernelError(
        "CLAIM_NOT_READY",
        `Check ${checkId} requires active claim ${consumption.claim}`
      );
    }
    return claimId;
  });
  return Object.freeze(ids);
}
function exactScheduledParentIds(plan, projection, event) {
  const scheduled = projection.scheduled.find(
    (candidate) => candidate.sessionId === event.sessionId && candidate.checkId === event.checkId && candidate.attemptId === event.attemptId && candidate.fence === event.fence && canonicalJson(candidate.scope) === canonicalJson(event.scope)
  );
  if (!scheduled) {
    throw new ClaimKernelError(
      "ATTEMPT_NOT_SCHEDULED",
      `Attempt ${event.attemptId} was not scheduled before terminal processing`
    );
  }
  const active = exactActiveClaimIds(plan, projection, event.checkId);
  if (!sameIds(scheduled.claimIds, active)) {
    throw new ClaimKernelError(
      "INACTIVE_PARENT_CLAIM",
      `Attempt ${event.attemptId} no longer has its exact active parent claims`
    );
  }
  return scheduled.claimIds;
}
function requireDeclaredPublication(plan, projection, event) {
  const emissions = plan.emissionsByCheck[event.checkId] || [];
  if (plan.emitterByClaim[event.claim] !== event.checkId || event.producerCheckId !== event.checkId || !emissions.some((emission) => emission.claim === event.claim)) {
    throw new ClaimKernelError(
      "UNDECLARED_CLAIM_PUBLICATION",
      `Check ${event.checkId} is not the declared emitter of ${event.claim}`
    );
  }
  const parentClaimIds = exactScheduledParentIds(plan, projection, event);
  if (!sameIds(event.parentClaimIds, parentClaimIds)) {
    throw new ClaimKernelError(
      "INVALID_PARENT_CLAIMS",
      `Published claim ${event.claim} does not carry the attempt's exact parent claims`
    );
  }
  plan.validatorsByClaim[event.claim](event.payload);
  const payloadFingerprint = sha256Canonical(event.payload);
  if (event.payloadFingerprint !== payloadFingerprint) {
    throw new ClaimKernelError(
      "INVALID_PAYLOAD_FINGERPRINT",
      `Published claim ${event.claim} has an invalid payload fingerprint`
    );
  }
  const expectedClaimId = sha256Canonical({
    claim: event.claim,
    payloadFingerprint,
    producerCheckId: event.checkId,
    scope: event.scope,
    attemptId: event.attemptId,
    fence: event.fence,
    parentClaimIds: [...parentClaimIds].sort()
  });
  if (event.claimId !== expectedClaimId) {
    throw new ClaimKernelError(
      "INVALID_CLAIM_ID",
      `Published claim ${event.claim} has an invalid claim ID`
    );
  }
}
function requireAllDeclaredEmissions(plan, projection, event) {
  for (const emission of plan.emissionsByCheck[event.checkId] || []) {
    const claimId = projection.activeClaimIdsByRef[emission.claim];
    const claim2 = claimId ? projection.claims[claimId] : void 0;
    if (!claim2 || claim2.producerCheckId !== event.checkId || claim2.attemptId !== event.attemptId || claim2.fence !== event.fence) {
      throw new ClaimKernelError(
        "INCOMPLETE_CLAIM_PUBLICATION",
        `Attempt ${event.attemptId} did not publish every declared claim`
      );
    }
  }
}
function hasPublishedClaimForAttempt(projection, event) {
  return Object.values(projection.claims).some(
    (claim2) => claim2.producerCheckId === event.checkId && claim2.attemptId === event.attemptId && claim2.fence === event.fence
  );
}
function reduceClaimEvent(projection, event, plan) {
  requireActivePlan(plan);
  requireRootScope(event.scope);
  if (event.version !== 1) {
    throw new ClaimKernelError("UNSUPPORTED_EVENT_VERSION", "Unsupported event version");
  }
  if (!Number.isSafeInteger(event.eventId) || event.eventId <= projection.lastEventId) {
    throw new ClaimKernelError(
      "NON_MONOTONIC_EVENT",
      `Claim event ${event.eventId} must advance beyond ${projection.lastEventId}`
    );
  }
  if (!Object.prototype.hasOwnProperty.call(plan.effectiveDependenciesByCheck, event.checkId)) {
    throw new ClaimKernelError("UNKNOWN_CHECK", `Unknown claim-mode check ${event.checkId}`);
  }
  const next = {
    lastEventId: event.eventId,
    attempts: { ...projection.attempts },
    claims: { ...projection.claims },
    activeClaimIdsByRef: { ...projection.activeClaimIdsByRef },
    scheduled: [...projection.scheduled]
  };
  const attemptKey = attemptProjectionKey(event.sessionId, event.checkId, event.scope);
  switch (event.type) {
    case "AttemptStarted": {
      const current = projection.attempts[attemptKey];
      if (current && event.fence <= current.fence) {
        throw new ClaimKernelError("STALE_FENCE", "Attempt fence must advance monotonically");
      }
      if (Object.values(projection.attempts).some((attempt) => attempt.attemptId === event.attemptId)) {
        throw new ClaimKernelError("DUPLICATE_ATTEMPT", `Attempt ${event.attemptId} already exists`);
      }
      next.attempts[attemptKey] = {
        sessionId: event.sessionId,
        checkId: event.checkId,
        scope: cloneScope(event.scope),
        attemptId: event.attemptId,
        fence: event.fence,
        status: "started"
      };
      break;
    }
    case "ClaimPublished": {
      requireCurrentAttempt(projection, event);
      requireDeclaredPublication(plan, projection, event);
      if (projection.claims[event.claimId]) {
        throw new ClaimKernelError("DUPLICATE_CLAIM", `Claim ${event.claimId} already exists`);
      }
      const claim2 = {
        claimId: event.claimId,
        claim: event.claim,
        payload: immutableCanonicalValue(event.payload),
        payloadFingerprint: event.payloadFingerprint,
        producerCheckId: event.producerCheckId,
        scope: cloneScope(event.scope),
        attemptId: event.attemptId,
        fence: event.fence,
        parentClaimIds: [...event.parentClaimIds]
      };
      next.claims[event.claimId] = claim2;
      next.activeClaimIdsByRef[event.claim] = event.claimId;
      break;
    }
    case "CheckScheduled": {
      requireCurrentAttempt(projection, event);
      const expected = exactActiveClaimIds(plan, projection, event.checkId);
      if (new Set(event.claimIds).size !== event.claimIds.length || !sameIds(event.claimIds, expected)) {
        throw new ClaimKernelError(
          "INVALID_SCHEDULED_CLAIMS",
          `Check ${event.checkId} was not scheduled with its exact declared active claims`
        );
      }
      next.scheduled.push(event);
      break;
    }
    case "AttemptCompleted": {
      const current = requireCurrentAttempt(projection, event);
      exactScheduledParentIds(plan, projection, event);
      requireAllDeclaredEmissions(plan, projection, event);
      next.attempts[attemptKey] = { ...current, status: "completed" };
      break;
    }
    case "AttemptFailed": {
      const current = requireCurrentAttempt(projection, event);
      if (hasPublishedClaimForAttempt(projection, event)) {
        throw new ClaimKernelError(
          "PARTIAL_CLAIM_PUBLICATION",
          `Failed attempt ${event.attemptId} cannot retain published claims`
        );
      }
      next.attempts[attemptKey] = { ...current, status: "failed", reason: event.reason };
      break;
    }
  }
  return immutableCanonicalValue(next);
}
function replayClaimEvents(events, plan) {
  return events.reduce(
    (projection, event) => reduceClaimEvent(projection, event, plan),
    createInitialClaimProjection()
  );
}
function formatValidationErrors(validate) {
  return (validate.errors || []).map((error) => {
    const additionalProperty = error.keyword === "additionalProperties" && typeof error.params?.additionalProperty === "string" ? error.params.additionalProperty : void 0;
    const propertyDetail = additionalProperty === void 0 ? "" : ` (additional property ${JSON.stringify(additionalProperty)})`;
    return `${error.instancePath || "/"} ${error.message || "is invalid"}${propertyDetail}`;
  }).join("; ");
}
function compileClaimSchema(schema) {
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  });
  addFormats(ajv);
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new ClaimKernelError(
      "INVALID_CLAIM_SCHEMA",
      `Invalid claim schema: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return Object.freeze((payload) => {
    canonicalJson(payload);
    if (!validate(payload)) {
      const detail = formatValidationErrors(validate);
      throw new ClaimKernelError(
        "CLAIM_SCHEMA_INVALID",
        `Candidate claim payload failed schema validation${detail ? `: ${detail}` : ""}`
      );
    }
  });
}
function buildClaimPublishedEvent(input) {
  requireCurrentAttempt(input.projection, {
    version: 1,
    eventId: input.eventId,
    sessionId: input.sessionId,
    checkId: input.checkId,
    scope: input.scope,
    attemptId: input.attemptId,
    fence: input.fence
  });
  const validator = input.plan.validatorsByClaim[input.claim];
  if (!validator) {
    throw new ClaimKernelError("UNDECLARED_CLAIM_PUBLICATION", `Unknown claim ${input.claim}`);
  }
  validator(input.payload);
  const payload = immutableCanonicalValue(input.payload);
  const payloadFingerprint = sha256Canonical(payload);
  const parentClaimIds = [...input.parentClaimIds];
  const claimId = sha256Canonical({
    claim: input.claim,
    payloadFingerprint,
    producerCheckId: input.checkId,
    scope: input.scope,
    attemptId: input.attemptId,
    fence: input.fence,
    parentClaimIds: [...parentClaimIds].sort()
  });
  return {
    version: 1,
    type: "ClaimPublished",
    eventId: input.eventId,
    sessionId: input.sessionId,
    checkId: input.checkId,
    producerCheckId: input.checkId,
    scope: cloneScope(input.scope),
    attemptId: input.attemptId,
    fence: input.fence,
    claimId,
    claim: input.claim,
    payload,
    payloadFingerprint,
    parentClaimIds
  };
}
var ClaimKernelError;
var init_claim_kernel = __esm({
  "src/state-machine/graph/claim-kernel.ts"() {
    "use strict";
    ClaimKernelError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.name = "ClaimKernelError";
        this.code = code;
      }
    };
  }
});

// src/providers/proof-wire.ts
import { createHash as createHash2 } from "crypto";
function governedWireModeFromEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "generic";
  const role = value.role;
  if (!role || typeof role !== "object" || Array.isArray(role)) return "generic";
  const invocation = role.invocation;
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return "generic";
  return invocation.output_schema_id === PROOF_CANDIDATE_OUTPUT_SCHEMA_ID ? "proof" : "generic";
}
function governedWireModeFromInvocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "generic";
  return value.output_schema_id === PROOF_CANDIDATE_OUTPUT_SCHEMA_ID ? "proof" : "generic";
}
function proofJSON(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not JSON");
    if (Object.is(value, -0)) return "-0";
  }
  if (typeof value === "string" && !validUnicode(value)) throw new Error("unpaired UTF-16 surrogate is not JSON");
  const encoded = JSON.stringify(value);
  if (encoded === void 0) throw new Error("value is not JSON");
  return encoded.replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function validUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 56320 || next > 57343) return false;
      index++;
    } else if (code >= 56320 && code <= 57343) return false;
  }
  return true;
}
function proofCanonicalJson(value) {
  const active = /* @__PURE__ */ new Set();
  const encode = (current) => {
    if (current === null || typeof current === "boolean" || typeof current === "number" || typeof current === "string") return proofJSON(current);
    if (Array.isArray(current)) {
      if (active.has(current)) throw new Error("value is cyclic");
      if (Reflect.ownKeys(current).some((key) => typeof key !== "string" || key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) || Array.from({ length: current.length }, (_, index) => index).some((index) => !Object.prototype.hasOwnProperty.call(current, String(index)))) throw new Error("array is not a dense JSON array");
      active.add(current);
      try {
        return `[${current.map((item) => encode(item)).join(",")}]`;
      } finally {
        active.delete(current);
      }
    }
    if (!current || typeof current !== "object" || Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null || Reflect.ownKeys(current).some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(current, key))) throw new Error("value is not a JSON object");
    if (active.has(current)) throw new Error("value is cyclic");
    active.add(current);
    try {
      const record = current;
      const keys = Object.keys(record).sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
      return `{${keys.map((key) => `${proofJSON(key)}:${encode(record[key])}`).join(",")}}`;
    } finally {
      active.delete(current);
    }
  };
  return encode(value);
}
function proofTopLevelJson(fields) {
  return `{${Object.keys(fields).sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))).map((key) => `${proofJSON(key)}:${fields[key]}`).join(",")}}`;
}
function immutableProofCanonicalValue(value) {
  const parsed = JSON.parse(proofCanonicalJson(value));
  const freeze2 = (current) => {
    if (current && typeof current === "object") {
      for (const child of Object.values(current)) freeze2(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze2(parsed);
}
function proofGovernedResultDigest(value) {
  const bytes = Buffer.from(proofCanonicalJson(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash2("sha256").update("probe.governed-result-identity/data/v1").update(Buffer.from([0])).update(length).update(bytes).digest("hex")}`;
}
function proofPayloadFingerprint(value) {
  return createHash2("sha256").update(proofCanonicalJson(value), "utf8").digest("hex");
}
function governedCanonicalJson(value, mode) {
  return mode === "proof" ? proofCanonicalJson(value) : canonicalJson(value);
}
function governedPayloadFingerprint(value, mode) {
  return mode === "proof" ? proofPayloadFingerprint(value) : sha256Canonical(value);
}
function governedResultDigest(value, mode) {
  if (mode === "proof") return proofGovernedResultDigest(value);
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash2("sha256").update("probe.governed-result-identity/data/v1").update(Buffer.from([0])).update(length).update(bytes).digest("hex")}`;
}
function immutableGovernedValue(value, mode) {
  return mode === "proof" ? immutableProofCanonicalValue(value) : immutableCanonicalValue(value);
}
function isProofComponentEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value.role;
  if (!role || typeof role !== "object" || Array.isArray(role)) return false;
  const invocation = role.invocation;
  return !!invocation && typeof invocation === "object" && !Array.isArray(invocation) && Object.prototype.hasOwnProperty.call(invocation, "component_authority");
}
function governedProofCandidateEvidenceJson(value) {
  return isProofComponentEvidence(value) ? proofCanonicalJson(value) : canonicalJson(value);
}
function immutableProofCandidateEvidence(value) {
  return isProofComponentEvidence(value) ? immutableProofCanonicalValue(value) : immutableCanonicalValue(value);
}
function proofCandidateEvidenceFingerprint(value) {
  if (!isProofComponentEvidence(value)) return sha256Canonical(value);
  return createHash2("sha256").update(proofCanonicalJson(value), "utf8").digest("hex");
}
var PROOF_CANDIDATE_OUTPUT_SCHEMA_ID;
var init_proof_wire = __esm({
  "src/providers/proof-wire.ts"() {
    "use strict";
    init_claim_kernel();
    PROOF_CANDIDATE_OUTPUT_SCHEMA_ID = "proof.component-catalog-candidate@1";
  }
});

// src/providers/governed-probe-runner.ts
import { AsyncLocalStorage } from "async_hooks";
import { createHash as createHash3 } from "crypto";
import { isAbsolute, resolve } from "path";
import { realpathSync, statSync } from "fs";
import {
  ProbeAgent
} from "@probelabs/probe";
function ownDataValue(value, key, enumerable = true) {
  if (!value || typeof value !== "object" && typeof value !== "function") return void 0;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && (!enumerable || descriptor.enumerable) ? descriptor.value : void 0;
  } catch {
    return void 0;
  }
}
function closedDataObject(value, keys) {
  if (!value || typeof value !== "object") return null;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}
function nonnegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function candidateBoundary(value, text2, version) {
  const boundary = closedDataObject(value, GOVERNED_CANDIDATE_BOUNDARY_KEYS);
  if (!boundary || typeof text2 !== "string") return null;
  const selectedOrigin = enumValue(boundary.selectedOrigin, GOVERNED_CANDIDATE_ORIGINS);
  const countKeys = GOVERNED_CANDIDATE_BOUNDARY_KEYS.slice(1);
  if (!selectedOrigin || countKeys.some((key) => !nonnegativeSafeInteger(boundary[key]))) return null;
  const selectedChunkCount = boundary.selectedChunkCount;
  const selectedBytes = boundary.selectedBytes;
  const resultTextItemCount = boundary.resultTextItemCount;
  const resultTextBytes = boundary.resultTextBytes;
  const rawFinalMessageCount = boundary.rawFinalMessageCount;
  const rawFinalPartCount = boundary.rawFinalPartCount;
  const rawFinalBytes = boundary.rawFinalBytes;
  const textBytes = Buffer.byteLength(text2, "utf8");
  if (selectedBytes !== textBytes || (textBytes === 0 ? selectedChunkCount !== 0 : selectedChunkCount === 0)) return null;
  if (selectedOrigin === "none" && (selectedChunkCount !== 0 || selectedBytes !== 0 || text2.length !== 0)) return null;
  return Object.freeze({
    version,
    text: text2,
    boundary: Object.freeze({
      selectedOrigin,
      selectedChunkCount,
      selectedBytes,
      resultTextItemCount,
      resultTextBytes,
      rawFinalMessageCount,
      rawFinalPartCount,
      rawFinalBytes
    })
  });
}
function governedCandidateShape(text2) {
  if (text2.length === 0) return enumValue("empty", GOVERNED_CANDIDATE_SHAPES);
  try {
    JSON.parse(text2);
    return enumValue("valid_json", GOVERNED_CANDIDATE_SHAPES);
  } catch {
    const trimmed = text2.trim();
    if (trimmed.length === 0) return enumValue("non_json", GOVERNED_CANDIDATE_SHAPES);
    const firstNonWhitespace = trimmed[0];
    if (firstNonWhitespace !== "{" && firstNonWhitespace !== "[") return enumValue("non_json", GOVERNED_CANDIDATE_SHAPES);
    return enumValue("malformed_json", GOVERNED_CANDIDATE_SHAPES);
  }
}
function observeGovernedCandidate(payload) {
  const envelope = closedDataObject(payload, GOVERNED_CANDIDATE_KEYS);
  if (!envelope || typeof envelope.version !== "string" || !GOVERNED_CANDIDATE_VERSIONS.includes(envelope.version) || typeof envelope.text !== "string") return null;
  return candidateBoundary(envelope.boundary, envelope.text, envelope.version);
}
function enumValue(value, values) {
  return typeof value === "string" && values.includes(value) ? value : null;
}
function governedCodexExecEventFields(value) {
  if (!Array.isArray(value) || value.length > GOVERNED_CODEX_EXEC_EVENT_MAX_FIELDS) return null;
  const fields = [];
  let previous;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const ownKeys = Reflect.ownKeys(item);
    const hasSize = ownKeys.includes("size");
    const field = closedDataObject(item, hasSize ? ["name", "type", "size"] : ["name", "type"]);
    if (!field || typeof field.name !== "string" || field.name !== "<unsafe>" && !GOVERNED_CODEX_EXEC_EVENT_FIELD_NAME.test(field.name) || !enumValue(field.type, GOVERNED_CODEX_EXEC_EVENT_TYPES) || hasSize && (!Number.isSafeInteger(field.size) || field.size < 0)) return null;
    const normalized = Object.freeze({
      name: field.name,
      type: enumValue(field.type, GOVERNED_CODEX_EXEC_EVENT_TYPES),
      ...hasSize ? { size: field.size } : {}
    });
    if ((normalized.type === "string" || normalized.type === "array") !== hasSize) return null;
    if (previous && (previous.name > normalized.name || previous.name === normalized.name && previous.type > normalized.type || previous.name === normalized.name && previous.type === normalized.type && (previous.size ?? -1) > (normalized.size ?? -1))) return null;
    previous = normalized;
    fields.push(normalized);
  }
  return Object.freeze(fields);
}
function governedCodexExecItemEvent(value) {
  if (!value || typeof value !== "object") return null;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const hasItemStatus = keys.includes("itemStatus");
  const event = closedDataObject(value, hasItemStatus ? ["source", "predicate", "eventType", "itemType", "itemStatus", "eventFields", "itemFields"] : ["source", "predicate", "eventType", "itemType", "eventFields", "itemFields"]);
  const predicate = event && enumValue(event.predicate, GOVERNED_CODEX_EXEC_EVENT_PREDICATES);
  if (!event || event.source !== GOVERNED_CODEX_EXEC_EVENT_VERSION || !predicate || !enumValue(event.eventType, ["item.started", "item.completed"]) || !enumValue(event.itemType, ["agent_message", "reasoning", "mcp_tool_call", "command_execution", "file_change"])) return null;
  if (hasItemStatus && predicate !== "item_status") return null;
  const itemStatus = hasItemStatus ? enumValue(event.itemStatus, ["failed", "declined"]) : null;
  if (hasItemStatus && !itemStatus) return null;
  const eventFields = governedCodexExecEventFields(event.eventFields);
  const itemFields = governedCodexExecEventFields(event.itemFields);
  if (!eventFields || !itemFields) return null;
  return Object.freeze({
    source: GOVERNED_CODEX_EXEC_EVENT_VERSION,
    predicate,
    eventType: enumValue(event.eventType, ["item.started", "item.completed"]),
    itemType: enumValue(event.itemType, ["agent_message", "reasoning", "mcp_tool_call", "command_execution", "file_change"]),
    ...itemStatus ? { itemStatus } : {},
    eventFields,
    itemFields
  });
}
function governedCodexExecFailureEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const hasProviderError = keys.includes("providerError");
  const event = closedDataObject(value, hasProviderError ? ["source", "category", "eventType", "eventFields", "providerError"] : ["source", "category", "eventType", "eventFields"]);
  const eventType = event && enumValue(event.eventType, GOVERNED_CODEX_EXEC_FAILURE_EVENT_TYPES);
  const eventFields = event && governedCodexExecEventFields(event.eventFields);
  if (!event || event.source !== GOVERNED_CODEX_EXEC_FAILURE_EVENT_VERSION || event.category !== "failure" || !eventType || !eventFields) return null;
  let providerError;
  if (hasProviderError) {
    const candidate = closedDataObject(event.providerError, ["type", "status", "code", "param", "schemaKeyword"]);
    if (!candidate || candidate.type !== GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR.type || candidate.status !== GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR.status || candidate.code !== GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR.code || candidate.param !== GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR.param || candidate.schemaKeyword !== GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR.schemaKeyword) return null;
    providerError = GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR;
  }
  return Object.freeze({
    source: GOVERNED_CODEX_EXEC_FAILURE_EVENT_VERSION,
    category: "failure",
    eventType,
    eventFields,
    ...providerError ? { providerError } : {}
  });
}
function governedCodexExecEvent(value) {
  return governedCodexExecItemEvent(value) ?? governedCodexExecFailureEvent(value);
}
function governedCodexExecDiagnostic(value) {
  if (!value || typeof value !== "object") return null;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const hasStderr = keys.includes("stderr");
  const hasEvent = keys.includes("event");
  const diagnostic = closedDataObject(value, hasStderr ? hasEvent ? ["version", "code", "stderr", "event"] : ["version", "code", "stderr"] : hasEvent ? ["version", "code", "event"] : ["version", "code"]);
  if (!diagnostic || diagnostic.version !== GOVERNED_CODEX_EXEC_FAILURE_DIAGNOSTIC_VERSION) return null;
  const code = enumValue(diagnostic.code, GOVERNED_CODEX_EXEC_FAILURE_CODES);
  if (!code) return null;
  const event = hasEvent ? governedCodexExecEvent(diagnostic.event) : null;
  if (hasEvent && !event) return null;
  if (!hasStderr) return Object.freeze({ version: GOVERNED_CODEX_EXEC_FAILURE_DIAGNOSTIC_VERSION, code, ...event ? { event } : {} });
  const stderrValue = diagnostic.stderr;
  if (!stderrValue || typeof stderrValue !== "object") return null;
  let stderrKeys;
  try {
    stderrKeys = Reflect.ownKeys(stderrValue);
  } catch {
    return null;
  }
  const hasSafeMessage = stderrKeys.includes("safeMessage");
  const stderr = closedDataObject(stderrValue, hasSafeMessage ? ["source", "bytes", "digest", "safeMessage"] : ["source", "bytes", "digest"]);
  if (!stderr || stderr.source !== GOVERNED_CODEX_EXEC_STDERR_VERSION || typeof stderr.bytes !== "number" || !Number.isSafeInteger(stderr.bytes) || stderr.bytes < 1 || stderr.bytes > GOVERNED_CODEX_EXEC_STDERR_MAX_BYTES || typeof stderr.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(stderr.digest)) return null;
  const safeMessage = hasSafeMessage ? enumValue(stderr.safeMessage, GOVERNED_CODEX_EXEC_SAFE_MESSAGES) : null;
  if (hasSafeMessage && !safeMessage) return null;
  return Object.freeze({
    version: GOVERNED_CODEX_EXEC_FAILURE_DIAGNOSTIC_VERSION,
    code,
    stderr: Object.freeze({
      source: GOVERNED_CODEX_EXEC_STDERR_VERSION,
      bytes: stderr.bytes,
      digest: stderr.digest,
      ...safeMessage ? { safeMessage } : {}
    }),
    ...event ? { event } : {}
  });
}
function sanitizeGovernedAnswerFailure(error) {
  const name = ownDataValue(error, "name", false);
  if (name !== "GovernedAnswerFailure") return Object.freeze({ answerFailureStage: "unknown" });
  const stage = enumValue(ownDataValue(error, "answerFailureStage"), ANSWER_FAILURE_STAGES) ?? "unknown";
  const output = { answerFailureStage: stage };
  if (stage === "provider_engine") {
    output.providerEngineFailureBoundary = enumValue(ownDataValue(error, "providerEngineFailureBoundary"), PROVIDER_ENGINE_FAILURE_BOUNDARIES);
    const diagnostic = governedCodexExecDiagnostic(ownDataValue(error, "providerEngineDiagnostic"));
    if (diagnostic) output.providerEngineDiagnostic = diagnostic;
  } else if (stage === "native_event_grammar") {
    const boundary = enumValue(ownDataValue(error, "nativeEventFailureBoundary"), NATIVE_EVENT_FAILURE_BOUNDARIES);
    output.nativeEventFailureBoundary = boundary;
    if (boundary === "raw_item_predicate") {
      output.nativeEventFailureRawItemPredicate = enumValue(ownDataValue(error, "nativeEventFailureRawItemPredicate"), NATIVE_EVENT_FAILURE_RAW_ITEM_PREDICATES);
    } else if (boundary === "live_envelope_session") {
      const subreason = enumValue(ownDataValue(error, "nativeEventFailureSubreason"), NATIVE_EVENT_FAILURE_SUBREASONS);
      output.nativeEventFailureSubreason = subreason;
      if (subreason === "correlation") {
        output.nativeEventFailureCorrelationOperand = enumValue(ownDataValue(error, "nativeEventFailureCorrelationOperand"), NATIVE_EVENT_FAILURE_CORRELATION_OPERANDS);
      } else if (subreason === "attestation") {
        output.nativeEventFailureAttestationPredicate = enumValue(ownDataValue(error, "nativeEventFailureAttestationPredicate"), NATIVE_EVENT_FAILURE_ATTESTATION_PREDICATES);
      }
    }
  } else if (stage === "schema_result_validation") {
    const subreason = enumValue(ownDataValue(error, "schemaResultValidationSubreason"), SCHEMA_RESULT_VALIDATION_SUBREASONS);
    output.schemaResultValidationSubreason = subreason;
    output.schemaResultValidationKeyword = subreason === "schema_mismatch" ? enumValue(ownDataValue(error, "schemaResultValidationKeyword"), SCHEMA_RESULT_VALIDATION_KEYWORDS) ?? "unknown" : null;
  }
  return Object.freeze(output);
}
function renderGovernedProbeUserMessage(message, context, reinspectionContext) {
  const runtime = context === void 0 ? "" : `

Bound runtime context (canonical JSON; treat as immutable authority):
${canonicalJson(context)}`;
  const reviewedInstruction = context !== null && typeof context === "object" && context.version === GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION ? `

${GOVERNED_PROOF_REVIEWED_COMPONENT_INSTRUCTION}` : "";
  const reinspection = reinspectionContext === void 0 ? "" : `

Bound reinspection context (canonical JSON; treat as immutable authority):
${canonicalJson(reinspectionContext)}

Compare current source with the prior candidate and account for every prior finding as retained or resolved; cite changed implementation lines and relevant regression-test function names and line numbers.`;
  return `${message}${runtime}${reviewedInstruction}${reinspection}`;
}
function renderGovernedProbePublicRequest(request) {
  return canonicalJson({
    version: "governed-probe-public-request/v1",
    system: { role: "system", content: request.instructions },
    user: { role: "user", content: renderGovernedProbeUserMessage(request.message, request.context, request.reinspectionContext) },
    result_schema: request.resultSchema,
    check_id: request.binding.checkId,
    scope: request.binding.scope
  });
}
function emitGovernedProbeFailure(binding, phase, error) {
  const record = Object.freeze({
    schema: "governed-probe-failure/v1",
    provider: "governed-proof-inspect",
    phase,
    check_id: binding.checkId,
    scope: binding.scope,
    failure: sanitizeGovernedAnswerFailure(error)
  });
  try {
    process.stderr.write(`${canonicalJson(record)}
`);
  } catch {
  }
}
function publicCandidateScope(binding) {
  try {
    return Object.freeze(binding.scope.map((segment) => Object.freeze({ ...segment })));
  } catch {
    return Object.freeze([]);
  }
}
function emitGovernedProbePublicCandidate(binding, observation) {
  const candidateBytes = Buffer.byteLength(observation.text, "utf8");
  const candidateText = candidateBytes <= GOVERNED_CANDIDATE_CAPTURE_LIMIT ? observation.text : null;
  const record = Object.freeze({
    schema: "governed-probe-public-candidate/v1",
    provider: "governed-proof-inspect",
    phase: "answer",
    check_id: binding.checkId,
    scope: publicCandidateScope(binding),
    selectedOrigin: observation.boundary.selectedOrigin,
    candidateChunkCount: observation.boundary.selectedChunkCount,
    candidateBytes,
    candidateSha256: `sha256:${createHash3("sha256").update(observation.text, "utf8").digest("hex")}`,
    candidateShape: governedCandidateShape(observation.text),
    captureTruncated: candidateText === null,
    candidateText,
    resultTextItemCount: observation.boundary.resultTextItemCount,
    resultTextBytes: observation.boundary.resultTextBytes,
    rawFinalMessageCount: observation.boundary.rawFinalMessageCount,
    rawFinalPartCount: observation.boundary.rawFinalPartCount,
    rawFinalBytes: observation.boundary.rawFinalBytes
  });
  try {
    process.stderr.write(`${canonicalJson(record)}
`);
  } catch {
  }
}
function controllerRoot(value) {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error("GOVERNED_PROOF_INVALID: workingDirectory must be absolute");
  }
  const resolved = resolve(value);
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new Error("GOVERNED_PROOF_INVALID: workingDirectory is not a directory");
    }
    return realpathSync(resolved);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GOVERNED_PROOF_INVALID:")) {
      throw error;
    }
    throw new Error("GOVERNED_PROOF_INVALID: workingDirectory is unavailable");
  }
}
function profileFor(root) {
  return {
    version: "probe.governed-codex-profile/v1",
    profileId: "luna-xhigh-readonly-v1",
    engine: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    sandbox: "read-only",
    approvalPolicy: "never",
    cwd: root,
    probeTools: PROBE_TOOLS,
    fallback: false,
    retries: 0
  };
}
function createGovernedProbeRunner(request) {
  const budget = governedProbeRunnerBudget.getStore();
  if (budget) {
    if (budget.consumed >= budget.limit) throw new Error("GOVERNED_PROOF_BUDGET_EXCEEDED");
    budget.consumed += 1;
  }
  return new GovernedProbeAgentRunner(request);
}
var GOVERNED_PROOF_ROLE_MESSAGE, GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION, GOVERNED_PROOF_REVIEWED_COMPONENT_INSTRUCTION, ANSWER_FAILURE_STAGES, PROVIDER_ENGINE_FAILURE_BOUNDARIES, NATIVE_EVENT_FAILURE_BOUNDARIES, NATIVE_EVENT_FAILURE_RAW_ITEM_PREDICATES, NATIVE_EVENT_FAILURE_SUBREASONS, NATIVE_EVENT_FAILURE_CORRELATION_OPERANDS, NATIVE_EVENT_FAILURE_ATTESTATION_PREDICATES, SCHEMA_RESULT_VALIDATION_SUBREASONS, SCHEMA_RESULT_VALIDATION_KEYWORDS, GOVERNED_CANDIDATE_VERSIONS, GOVERNED_CANDIDATE_ORIGINS, GOVERNED_CANDIDATE_SHAPES, GOVERNED_CANDIDATE_CAPTURE_LIMIT, GOVERNED_CODEX_EXEC_FAILURE_CODES, GOVERNED_CODEX_EXEC_FAILURE_DIAGNOSTIC_VERSION, GOVERNED_CODEX_EXEC_STDERR_VERSION, GOVERNED_CODEX_EXEC_SAFE_MESSAGES, GOVERNED_CODEX_EXEC_STDERR_MAX_BYTES, GOVERNED_CODEX_EXEC_EVENT_VERSION, GOVERNED_CODEX_EXEC_FAILURE_EVENT_VERSION, GOVERNED_CODEX_EXEC_FAILURE_EVENT_TYPES, GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR, GOVERNED_CODEX_EXEC_EVENT_PREDICATES, GOVERNED_CODEX_EXEC_EVENT_TYPES, GOVERNED_CODEX_EXEC_EVENT_FIELD_NAME, GOVERNED_CODEX_EXEC_EVENT_MAX_FIELDS, GOVERNED_CANDIDATE_BOUNDARY_KEYS, GOVERNED_CANDIDATE_KEYS, PROBE_TOOLS, governedProbeRunnerBudget, GovernedProbeAgentRunner;
var init_governed_probe_runner = __esm({
  "src/providers/governed-probe-runner.ts"() {
    "use strict";
    init_claim_kernel();
    init_proof_wire();
    GOVERNED_PROOF_ROLE_MESSAGE = [
      "Execute the bound Proof role and return only the required JSON.",
      "",
      "For component reviews, treat the supplied dependency closure as the exclusive citation scope: do not cite files outside it, and review every owned path.",
      "For each finding, state the causal chain from input and validation through control flow to the resulting effect, with precise file and line citations.",
      "For reinspection, cite changed implementation lines and the relevant regression-test function names and line numbers."
    ].join("\n");
    GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION = "visor.proof-reviewed-component-context/v1";
    GOVERNED_PROOF_REVIEWED_COMPONENT_INSTRUCTION = "Controller instruction: independent packet findings are fallible candidates. Verify each against current Proof and source, preserve unsupported or unresolved status, and never infer approval from packet or aggregate completion.";
    ANSWER_FAILURE_STAGES = ["native_event_grammar", "provider_engine", "schema_result_validation", "internal_contract", "unknown"];
    PROVIDER_ENGINE_FAILURE_BOUNDARIES = ["acquire", "query", "close"];
    NATIVE_EVENT_FAILURE_BOUNDARIES = ["raw_item_predicate", "live_envelope_session"];
    NATIVE_EVENT_FAILURE_RAW_ITEM_PREDICATES = [
      "shape",
      "type",
      "id",
      "duplicate",
      "phase",
      "content",
      "passthrough",
      "tool_name_or_allow",
      "status",
      "input",
      "call_output_pairing",
      "event_limit",
      "tool_event_limit",
      "tool_call_limit",
      "message_content_array",
      "message_content_empty",
      "message_content_limit",
      "message_content_kind",
      "message_content_text_type",
      "message_content_text_limit",
      "reasoning_summary_array",
      "reasoning_summary_nonempty",
      "reasoning_encrypted_content_type",
      "reasoning_encrypted_content_limit",
      "tool_output_array",
      "tool_output_limit",
      "tool_output_kind",
      "tool_output_text_type",
      "tool_output_text_limit",
      "final_answer_cardinality"
    ];
    NATIVE_EVENT_FAILURE_SUBREASONS = ["session_sequence", "envelope_shape", "correlation", "attestation"];
    NATIVE_EVENT_FAILURE_CORRELATION_OPERANDS = ["thread_id", "response_id"];
    NATIVE_EVENT_FAILURE_ATTESTATION_PREDICATES = [
      "event_shape",
      "jsonrpc",
      "params_shape",
      "response_id",
      "meta_shape",
      "session_shape",
      "session_identity",
      "model",
      "model_provider",
      "approval_policy",
      "approvals_reviewer",
      "reasoning_effort",
      "rollout_path",
      "cwd",
      "permission_shape",
      "session_type",
      "permission_type",
      "network",
      "filesystem_shape",
      "filesystem_type",
      "entries",
      "entry",
      "access",
      "path_shape",
      "path_type",
      "value_shape",
      "kind",
      "native_tool_evidence",
      "internal_contract",
      "invocation_attestation",
      "native_capability_aggregate"
    ];
    SCHEMA_RESULT_VALIDATION_SUBREASONS = ["response_json", "schema_definition", "schema_mismatch", "result_identity"];
    SCHEMA_RESULT_VALIDATION_KEYWORDS = ["required", "additionalProperties", "type", "pattern", "enum", "minItems", "maxItems", "multiple", "unknown"];
    GOVERNED_CANDIDATE_VERSIONS = ["probe.governed-answer-candidate/v1"];
    GOVERNED_CANDIDATE_ORIGINS = ["result_content", "raw_final", "none"];
    GOVERNED_CANDIDATE_SHAPES = ["empty", "non_json", "malformed_json", "valid_json"];
    GOVERNED_CANDIDATE_CAPTURE_LIMIT = 131072;
    GOVERNED_CODEX_EXEC_FAILURE_CODES = [
      "GOVERNED_CODEX_EXEC_ANSWER_CARDINALITY",
      "GOVERNED_CODEX_EXEC_CANCELLED",
      "GOVERNED_CODEX_EXEC_CANONICAL",
      "GOVERNED_CODEX_EXEC_CLEANUP",
      "GOVERNED_CODEX_EXEC_CONFIG",
      "GOVERNED_CODEX_EXEC_DUPLICATE",
      "GOVERNED_CODEX_EXEC_EVENT",
      "GOVERNED_CODEX_EXEC_EVENT_CATEGORY",
      "GOVERNED_CODEX_EXEC_EVENT_LIMIT",
      "GOVERNED_CODEX_EXEC_EVENT_ORDER",
      "GOVERNED_CODEX_EXEC_EXIT",
      "GOVERNED_CODEX_EXEC_INCOMPLETE",
      "GOVERNED_CODEX_EXEC_INCOMPLETE_ITEM",
      "GOVERNED_CODEX_EXEC_ITEM",
      "GOVERNED_CODEX_EXEC_ITEM_ORDER",
      "GOVERNED_CODEX_EXEC_ITEM_STATUS",
      "GOVERNED_CODEX_EXEC_JSONL",
      "GOVERNED_CODEX_EXEC_MCP",
      "GOVERNED_CODEX_EXEC_MCP_EVIDENCE",
      "GOVERNED_CODEX_EXEC_ONE_QUERY",
      "GOVERNED_CODEX_EXEC_OUTPUT_OVERFLOW",
      "GOVERNED_CODEX_EXEC_SETUP",
      "GOVERNED_CODEX_EXEC_SPAWN",
      "GOVERNED_CODEX_EXEC_TIMEOUT",
      "GOVERNED_CODEX_EXEC_TOOL_POLICY",
      "GOVERNED_CODEX_EXEC_USAGE",
      "GOVERNED_CODEX_EXEC_VERSION"
    ];
    GOVERNED_CODEX_EXEC_FAILURE_DIAGNOSTIC_VERSION = "probe.governed-codex-exec-failure/v1";
    GOVERNED_CODEX_EXEC_STDERR_VERSION = "codex-exec-stderr/v1";
    GOVERNED_CODEX_EXEC_SAFE_MESSAGES = ["access_token_refresh_revoked"];
    GOVERNED_CODEX_EXEC_STDERR_MAX_BYTES = 1024 * 1024;
    GOVERNED_CODEX_EXEC_EVENT_VERSION = "codex-exec-rejected-item/v1";
    GOVERNED_CODEX_EXEC_FAILURE_EVENT_VERSION = "codex-exec-rejected-failure/v1";
    GOVERNED_CODEX_EXEC_FAILURE_EVENT_TYPES = ["error", "turn.failed"];
    GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR = Object.freeze({
      type: "invalid_request_error",
      status: 400,
      code: "invalid_json_schema",
      param: "text.format.schema",
      schemaKeyword: "uniqueItems"
    });
    GOVERNED_CODEX_EXEC_EVENT_PREDICATES = [
      "item_keys",
      "item_id",
      "item_text",
      "item_phase",
      "item_summary",
      "item_server",
      "item_command",
      "item_aggregated_output",
      "item_exit_code",
      "item_status",
      "item_error",
      "item_started_payload",
      "item_changes",
      "tool_id"
    ];
    GOVERNED_CODEX_EXEC_EVENT_TYPES = ["null", "array", "object", "string", "number", "boolean"];
    GOVERNED_CODEX_EXEC_EVENT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
    GOVERNED_CODEX_EXEC_EVENT_MAX_FIELDS = 32;
    GOVERNED_CANDIDATE_BOUNDARY_KEYS = [
      "selectedOrigin",
      "selectedChunkCount",
      "selectedBytes",
      "resultTextItemCount",
      "resultTextBytes",
      "rawFinalMessageCount",
      "rawFinalPartCount",
      "rawFinalBytes"
    ];
    GOVERNED_CANDIDATE_KEYS = ["version", "text", "boundary"];
    PROBE_TOOLS = [
      "search",
      "extract",
      "listFiles"
    ];
    governedProbeRunnerBudget = new AsyncLocalStorage();
    GovernedProbeAgentRunner = class {
      agent;
      resultSchema;
      invocationDigest;
      userMessage;
      binding;
      failureEmitted = false;
      initializePromise;
      cancelled = false;
      closed = false;
      closePromise;
      candidateObservation;
      candidateFailureEmitted = false;
      constructor(request) {
        const root = controllerRoot(request.workingDirectory);
        this.resultSchema = request.resultSchema;
        this.invocationDigest = request.invocationDigest;
        this.binding = request.binding;
        if (typeof request.message !== "string" || request.message.length === 0 || Buffer.byteLength(request.message, "utf8") > 32768) {
          throw new Error("GOVERNED_PROOF_INVALID: message is invalid");
        }
        this.userMessage = renderGovernedProbeUserMessage(request.message, request.context, request.reinspectionContext);
        const governedCodexProfile = profileFor(root);
        const options = {
          provider: "codex",
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
          hooks: {
            // This is the sole hook installed by the governed runner. Probe emits
            // the frozen candidate immediately before JSON validation; this sync
            // callback copies only its closed primitive observation.
            "message:assistant": (payload) => this.captureCandidate(payload)
          }
        };
        if (request.governedCodexTransport !== void 0) {
          if (request.governedCodexTransport !== "exec-jsonl-default-auth-v1" || typeof request.codexSha256 !== "string" || !/^(?:[0-9a-f]{64}|sha256:[0-9a-f]{64})$/.test(request.codexSha256) || typeof request.codexBin !== "string" || !isAbsolute(request.codexBin)) {
            throw new Error("GOVERNED_PROOF_INVALID: governed Codex executable identity is invalid");
          }
          options.governedCodexTransport = request.governedCodexTransport;
          options.codexBin = request.codexBin;
          options.codexSha256 = request.codexSha256;
        } else if (request.codexBin !== void 0 || request.codexSha256 !== void 0) {
          throw new Error("GOVERNED_PROOF_INVALID: governed Codex executable requires an explicit transport");
        }
        this.agent = new ProbeAgent(options);
      }
      captureCandidate(payload) {
        if (this.candidateObservation) return;
        const observation = observeGovernedCandidate(payload);
        if (observation) this.candidateObservation = observation;
      }
      async preview(_request) {
        if (this.cancelled) throw new Error("GOVERNED_PROOF_INVALID: runner is cancelled");
        if (this.closed) throw new Error("GOVERNED_PROOF_INVALID: runner is closed");
        try {
          return await this.agent.previewGovernedAnswerDispatch(this.userMessage, { schema: this.resultSchema });
        } catch (error) {
          this.reportFailure("preview", error);
          throw error;
        }
      }
      async answer(_request) {
        if (this.cancelled) throw new Error("GOVERNED_PROOF_INVALID: runner is cancelled");
        if (this.closed) throw new Error("GOVERNED_PROOF_INVALID: runner is closed");
        try {
          if (!this.initializePromise) this.initializePromise = this.agent.initialize();
          await this.initializePromise;
        } catch (error) {
          this.reportFailure("initialize", error);
          throw error;
        }
        if (this.cancelled) throw new Error("GOVERNED_PROOF_INVALID: runner is cancelled");
        if (this.closed) throw new Error("GOVERNED_PROOF_INVALID: runner is closed");
        const options = {
          schema: this.resultSchema,
          invocationDigest: this.invocationDigest,
          resultIdentity: "probe.governed-result-identity/v1"
        };
        this.candidateObservation = void 0;
        this.candidateFailureEmitted = false;
        let identified;
        try {
          identified = await this.agent.answerGoverned(this.userMessage, options);
        } catch (error) {
          this.reportFailure("answer", error);
          throw error;
        }
        const wireMode = governedWireModeFromInvocation(_request.invocation);
        if (wireMode === "proof") {
          const data = immutableGovernedValue(identified.data, wireMode);
          const canonical = Buffer.from(governedCanonicalJson(data, wireMode), "utf8");
          this.candidateObservation = void 0;
          return Object.freeze({
            ...identified,
            data,
            resultIdentity: Object.freeze({
              ...identified.resultIdentity,
              resultDigest: governedResultDigest(data, wireMode),
              canonicalBytes: canonical.length
            })
          });
        }
        this.candidateObservation = void 0;
        return identified;
      }
      reportFailure(phase, error) {
        const failure = sanitizeGovernedAnswerFailure(error);
        const isSchemaResultFailure = phase === "answer" && failure.answerFailureStage === "schema_result_validation";
        if (isSchemaResultFailure && this.candidateObservation && !this.candidateFailureEmitted) {
          this.candidateFailureEmitted = true;
          emitGovernedProbePublicCandidate(this.binding, this.candidateObservation);
          this.candidateObservation = void 0;
        }
        if (isSchemaResultFailure) this.candidateObservation = void 0;
        if (this.failureEmitted) return;
        this.failureEmitted = true;
        emitGovernedProbeFailure(this.binding, phase, error);
      }
      cancel(_reason) {
        if (this.cancelled || this.closed) return;
        this.cancelled = true;
        this.agent.cancel();
      }
      async close() {
        if (!this.closePromise) {
          this.closed = true;
          this.closePromise = this.agent.close();
        }
        await this.closePromise;
      }
    };
  }
});

// src/providers/proof-admission-cli-child.ts
var proof_admission_cli_child_exports = {};
__export(proof_admission_cli_child_exports, {
  PROOF_ADMISSION_CLEANUP_FAILED: () => PROOF_ADMISSION_CLEANUP_FAILED,
  PROOF_ADMISSION_OUTPUT_MAX_BYTES: () => PROOF_ADMISSION_OUTPUT_MAX_BYTES,
  PROOF_ADMISSION_REQUEST_MAX_BYTES: () => PROOF_ADMISSION_REQUEST_MAX_BYTES,
  PROOF_ADMISSION_UNAVAILABLE: () => PROOF_ADMISSION_UNAVAILABLE,
  PROOF_ADMISSION_WIRE_FIELD: () => PROOF_ADMISSION_WIRE_FIELD,
  PROOF_C0_LEGACY_REQUEST_MAX_BYTES: () => PROOF_C0_LEGACY_REQUEST_MAX_BYTES,
  PROOF_C0_REQUEST_MAX_BYTES: () => PROOF_C0_REQUEST_MAX_BYTES,
  PROOF_C0_RESPONSE_MAX_BYTES: () => PROOF_C0_RESPONSE_MAX_BYTES,
  PROOF_ONBOARDING_STAGE_CONTEXT_VERSION: () => PROOF_ONBOARDING_STAGE_CONTEXT_VERSION,
  PROOF_ONBOARDING_STAGE_MAX_BYTES: () => PROOF_ONBOARDING_STAGE_MAX_BYTES,
  PROOF_ONBOARDING_STAGE_SPEC_REVIEW: () => PROOF_ONBOARDING_STAGE_SPEC_REVIEW,
  createProofAdmissionCapability: () => createProofAdmissionCapability,
  createProofAdmissionCliChildForFocusedTest: () => createProofAdmissionCliChildForFocusedTest,
  extractProofAdmissionCandidate: () => extractProofAdmissionCandidate,
  goCompatibleProofJson: () => goCompatibleProofJson,
  immutableProofCanonicalValue: () => immutableProofCanonicalValue,
  proofAdmissionCapabilityValid: () => proofAdmissionCapabilityValid,
  proofCandidateAdmissionRequestJson: () => proofCandidateAdmissionRequestJson,
  proofCanonicalJson: () => proofCanonicalJson,
  proofCatalogRevalidationReceiptIdentityJson: () => proofCatalogRevalidationReceiptIdentityJson,
  proofComponentCandidateEnvelopeJson: () => proofComponentCandidateEnvelopeJson,
  proofExecutableAvailable: () => proofExecutableAvailable,
  proofGovernedResultDigest: () => proofGovernedResultDigest,
  proofOnboardingStageContextJson: () => proofOnboardingStageContextJson,
  proofPayloadFingerprint: () => proofPayloadFingerprint,
  proofTopLevelJson: () => proofTopLevelJson,
  proofV1AdmissionReceiptID: () => proofV1AdmissionReceiptID,
  proofV1DecisionJson: () => proofV1DecisionJson,
  resolveProofRoleInvocation: () => resolveProofRoleInvocation,
  startProofAdmissionCliChild: () => startProofAdmissionCliChild,
  startProofManagedCliChild: () => startProofManagedCliChild,
  validateOnboardingStageContext: () => validateOnboardingStageContext,
  validateProofComponentAdmissionOutcome: () => validateProofComponentAdmissionOutcome
});
import { spawn } from "child_process";
import { createHash as createHash4 } from "crypto";
import { readFileSync, realpathSync as realpathSync2, statSync as statSync2 } from "fs";
import { TextDecoder as TextDecoder2 } from "util";
function fail(detail) {
  throw new Error(`PROOF_ADMISSION_INVALID: ${detail}`);
}
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key, index) => typeof key === "string" && key === keys[index]);
}
function exactUnordered(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}
function json(value) {
  const encoded = JSON.stringify(value);
  if (encoded === void 0) fail("value is not JSON");
  return encoded.replace(/[<>&\u2028\u2029]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}
function jsonValueEnd(source, start) {
  let index = start;
  const first = source[index];
  if (first === '"') {
    index++;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index++] === '"') return index;
    }
    return -1;
  }
  if (first !== "{" && first !== "[") {
    while (index < source.length && source[index] !== "," && source[index] !== "}" && source[index] !== "]") index++;
    return index;
  }
  const stack = [];
  let quoted = false;
  for (; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === stack[stack.length - 1] && stack.pop() && stack.length === 0) return index + 1;
  }
  return -1;
}
function rawObjectField(source, wanted) {
  let index = 0;
  while (/\s/.test(source[index] ?? "")) index++;
  if (source[index++] !== "{") return void 0;
  for (; ; ) {
    while (/\s/.test(source[index] ?? "")) index++;
    if (source[index] === "}") return void 0;
    const keyStart = index;
    const keyEnd = jsonValueEnd(source, keyStart);
    if (keyEnd < 0) return void 0;
    let key;
    try {
      key = JSON.parse(source.slice(keyStart, keyEnd));
    } catch {
      return void 0;
    }
    index = keyEnd;
    while (/\s/.test(source[index] ?? "")) index++;
    if (source[index++] !== ":") return void 0;
    while (/\s/.test(source[index] ?? "")) index++;
    const valueStart = index;
    const valueEnd = jsonValueEnd(source, valueStart);
    if (valueEnd < 0) return void 0;
    if (key === wanted) return source.slice(valueStart, valueEnd);
    index = valueEnd;
    while (/\s/.test(source[index] ?? "")) index++;
    if (source[index++] !== ",") return void 0;
  }
}
function proofStructJson(fields) {
  return `{${Object.entries(fields).map(([key, value]) => `${json(key)}:${value}`).join(",")}}`;
}
function onboardingStageArtifactJson(value, name) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (!plain(parsed)) fail(`${name} must be a JSON object`);
    } catch {
      fail(`${name} must be a JSON object`);
    }
    try {
      new TextDecoder2("utf-8", { fatal: true }).decode(Buffer.from(value));
    } catch {
      fail(`${name} is not valid UTF-8`);
    }
    return value;
  }
  if (!plain(value) || !validUnicode2(value)) fail(`${name} must be a JSON object`);
  const candidate = name === "prior_candidate" && plain(value.Invocation) && Object.prototype.hasOwnProperty.call(value, "Publication") ? proofComponentCandidateEnvelopeJson(value) : name === "prior_admission" && Object.prototype.hasOwnProperty.call(value, "receipt") ? proofV1DecisionJson(value) : proofCanonicalJson(value);
  if (candidate === "") fail(`${name} cannot be encoded`);
  return candidate;
}
function validateOnboardingStageContext(value) {
  if (!exactUnordered(value, ONBOARDING_STAGE_KEYS) || !validUnicode2(value)) fail("onboarding stage context wire shape is invalid");
  const stage = value;
  if (stage.version !== PROOF_ONBOARDING_STAGE_CONTEXT_VERSION || stage.stage_id !== PROOF_ONBOARDING_STAGE_SPEC_REVIEW || typeof stage.prior_admission_claim_id !== "string" || !/^[0-9a-f]{64}$/.test(stage.prior_admission_claim_id) || typeof stage.prior_admission_payload_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(stage.prior_admission_payload_fingerprint)) {
    fail("onboarding stage context identity is invalid");
  }
  const candidate = onboardingStageArtifactJson(stage.prior_candidate, "prior_candidate");
  const admission = onboardingStageArtifactJson(stage.prior_admission, "prior_admission");
  if (Buffer.byteLength(candidate) + Buffer.byteLength(admission) > PROOF_ONBOARDING_STAGE_MAX_BYTES) fail("onboarding stage evidence exceeds limit");
  return Object.freeze({
    version: PROOF_ONBOARDING_STAGE_CONTEXT_VERSION,
    stage_id: PROOF_ONBOARDING_STAGE_SPEC_REVIEW,
    prior_candidate: stage.prior_candidate,
    prior_admission: stage.prior_admission,
    prior_admission_claim_id: stage.prior_admission_claim_id,
    prior_admission_payload_fingerprint: stage.prior_admission_payload_fingerprint
  });
}
function proofOnboardingStageContextJson(value) {
  const stage = validateOnboardingStageContext(value);
  return proofStructJson({
    version: json(stage.version),
    stage_id: json(stage.stage_id),
    prior_candidate: onboardingStageArtifactJson(stage.prior_candidate, "prior_candidate"),
    prior_admission: onboardingStageArtifactJson(stage.prior_admission, "prior_admission"),
    prior_admission_claim_id: json(stage.prior_admission_claim_id),
    prior_admission_payload_fingerprint: json(stage.prior_admission_payload_fingerprint)
  });
}
function goComponentSubjectJson(value) {
  return proofStructJson({
    version: json(value.version),
    project_id: json(value.project_id),
    component_id: json(value.component_id),
    sorted_owned_paths: json(value.sorted_owned_paths),
    sorted_dependency_closure: json(value.sorted_dependency_closure),
    fingerprint: json(value.fingerprint)
  });
}
function goComponentAuthorityComponentJson(value) {
  const subject = value.subject;
  if (!plain(subject)) return "";
  return proofStructJson({
    component_id: json(value.component_id),
    work_item_digest: json(value.work_item_digest),
    subject: goComponentSubjectJson(subject)
  });
}
function goComponentPathMappingJson(value) {
  if (!plain(value)) return "";
  const fields = {
    paths: json(value.paths),
    risk_tier: json(value.risk_tier),
    enforcement: json(value.enforcement)
  };
  if (value.repo !== void 0 && value.repo !== "") fields.repo = json(value.repo);
  if (Array.isArray(value.components) && value.components.length > 0) fields.components = json(value.components);
  if (Array.isArray(value.interfaces) && value.interfaces.length > 0) fields.interfaces = json(value.interfaces);
  if (Array.isArray(value.requirements) && value.requirements.length > 0) fields.requirements = json(value.requirements);
  if (Array.isArray(value.required_tests) && value.required_tests.length > 0) fields.required_tests = json(value.required_tests);
  const ordered = {};
  for (const key of ["repo", "paths", "components", "interfaces", "requirements", "required_tests", "owner", "risk_tier", "enforcement"]) {
    if (key === "owner" && value.owner !== void 0 && value.owner !== "") ordered[key] = json(value.owner);
    else if (fields[key] !== void 0) ordered[key] = fields[key];
  }
  return proofStructJson(ordered);
}
function goComponentInputStateJson(value) {
  if (!Array.isArray(value)) return "";
  const rows = value.map((row) => {
    if (!plain(row)) return "";
    return proofStructJson({
      owner_kind: json(row.owner_kind),
      owner_id: json(row.owner_id),
      input_kind: json(row.input_kind),
      path: json(row.path),
      file_hash: json(row.file_hash)
    });
  });
  return rows.some((row) => row === "") ? "" : `[${rows.join(",")}]`;
}
function goComponentWorkItemJson(value) {
  if (!plain(value) || !plain(value.proof_path_mapping) || !plain(value.proof_component_subject)) return "";
  const mapping = goComponentPathMappingJson(value.proof_path_mapping);
  const inputState = goComponentInputStateJson(value.proof_input_state);
  if (mapping === "" || inputState === "") return "";
  return proofStructJson({
    version: json(value.version),
    project_id: json(value.project_id),
    component_id: json(value.component_id),
    sorted_owned_paths: json(value.sorted_owned_paths),
    sorted_dependency_closure: json(value.sorted_dependency_closure),
    proof_path_mapping: mapping,
    proof_input_state: inputState,
    proof_component_subject: goComponentSubjectJson(value.proof_component_subject)
  });
}
function goComponentReceiptJson(value) {
  const rawAuthorities = value.component_authorities;
  if (!Array.isArray(rawAuthorities)) return "";
  const authorities = `[${rawAuthorities.map((raw) => plain(raw) ? goComponentAuthorityComponentJson(raw) : "").join(",")}]`;
  if (rawAuthorities.some((raw) => !plain(raw) || goComponentAuthorityComponentJson(raw) === "")) return "";
  const fields = {
    version: json(value.version),
    decision: json(value.decision),
    project_id: json(value.project_id),
    project_fingerprint: json(value.project_fingerprint),
    boundary_fingerprint: json(value.boundary_fingerprint),
    inventory_claim_id: json(value.inventory_claim_id),
    catalog_claim_id: json(value.catalog_claim_id),
    admission_candidate_id: json(value.admission_candidate_id),
    admission_result_digest: json(value.admission_result_digest),
    admission_receipt_id: json(value.admission_receipt_id),
    component_authorities: authorities,
    receipt_id: json(value.receipt_id)
  };
  if (value.version !== "proof.catalog-revalidation-receipt/v2") return proofStructJson(fields);
  const lineage = value.project_lineage;
  fields.project_lineage = json(lineage === null ? null : (() => {
    if (!plain(lineage)) return lineage;
    return {
      version: lineage.version,
      fingerprint: lineage.fingerprint,
      object_format: lineage.object_format,
      baseline_revision: lineage.baseline_revision
    };
  })());
  return proofTopLevelJson(fields);
}
function proofCatalogRevalidationReceiptIdentityJson(value) {
  if (!plain(value) || !exactUnordered(value, value.version === "proof.catalog-revalidation-receipt/v2" ? CATALOG_REVALIDATION_RECEIPT_V2_KEYS : CATALOG_REVALIDATION_RECEIPT_V1_KEYS)) {
    fail("catalog revalidation receipt identity value is not a closed receipt");
  }
  const receipt = value;
  if (receipt.version !== "proof.catalog-revalidation-receipt/v1" && receipt.version !== "proof.catalog-revalidation-receipt/v2" || receipt.decision !== "accepted" || typeof receipt.project_id !== "string" || receipt.project_id.length === 0 || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.project_fingerprint)) || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.boundary_fingerprint)) || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.inventory_claim_id)) || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.catalog_claim_id)) || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.admission_candidate_id)) || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.admission_result_digest)) || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.admission_receipt_id)) || !(receipt.receipt_id === "" || /^sha256:[0-9a-f]{64}$/.test(String(receipt.receipt_id))) || !Array.isArray(receipt.component_authorities) || receipt.component_authorities.length === 0) {
    fail("catalog revalidation receipt identity fields are invalid");
  }
  for (const [index, authority] of receipt.component_authorities.entries()) {
    if (!plain(authority) || !exactUnordered(authority, ["component_id", "work_item_digest", "subject"]) || typeof authority.component_id !== "string" || authority.component_id.length === 0 || typeof authority.work_item_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(authority.work_item_digest) || !plain(authority.subject) || !exactUnordered(authority.subject, ["version", "project_id", "component_id", "sorted_owned_paths", "sorted_dependency_closure", "fingerprint"]) || authority.subject.version !== "proof.component-subject/v1" || typeof authority.subject.project_id !== "string" || authority.subject.project_id.length === 0 || typeof authority.subject.component_id !== "string" || authority.subject.component_id.length === 0 || !Array.isArray(authority.subject.sorted_owned_paths) || authority.subject.sorted_owned_paths.length === 0 || authority.subject.sorted_owned_paths.some((path) => typeof path !== "string" || path.length === 0) || !Array.isArray(authority.subject.sorted_dependency_closure) || authority.subject.sorted_dependency_closure.length === 0 || authority.subject.sorted_dependency_closure.some((path) => typeof path !== "string" || path.length === 0) || typeof authority.subject.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(authority.subject.fingerprint) || authority.subject.component_id !== authority.component_id) {
      fail(`catalog revalidation receipt authority ${index} is invalid`);
    }
  }
  if (receipt.version === "proof.catalog-revalidation-receipt/v2") {
    const lineage = receipt.project_lineage;
    if (lineage !== null && (!plain(lineage) || !exactUnordered(lineage, ["version", "fingerprint", "object_format", "baseline_revision"]) || lineage.version !== "proof.git-project-lineage-binding/v1" || typeof lineage.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(lineage.fingerprint) || lineage.object_format !== "sha1" && lineage.object_format !== "sha256" || typeof lineage.baseline_revision !== "string" || (lineage.object_format === "sha1" ? !/^sha1:[0-9a-f]{40}$/.test(lineage.baseline_revision) : !/^sha256:[0-9a-f]{64}$/.test(lineage.baseline_revision)))) {
      fail("catalog revalidation receipt lineage is invalid");
    }
  }
  const encoded = goComponentReceiptJson(receipt);
  if (encoded === "") fail("catalog revalidation receipt identity cannot be encoded");
  return encoded;
}
function goComponentAuthorityJson(value) {
  const subject = value.subject;
  const receipt = value.catalog_revalidation_receipt;
  if (!plain(subject) || !plain(receipt)) return "";
  const workItem = goComponentWorkItemJson(value.work_item);
  if (workItem === "") return "";
  return proofStructJson({
    work_item_digest: json(value.work_item_digest),
    subject: goComponentSubjectJson(subject),
    // Candidate and admission are Proof-owned RawMessage bytes. Re-encode
    // them with the Proof serializer so -0 and UTF-8 identity survive the
    // JS object boundary exactly as they do in Go.
    candidate: proofCanonicalJson(value.candidate),
    admission: proofCanonicalJson(value.admission),
    work_item: workItem,
    catalog_revalidation_receipt: goComponentReceiptJson(receipt)
  });
}
function goRoleSubjectJson(value) {
  return proofStructJson({ kind: json(value.kind), id: json(value.id), fingerprint: json(value.fingerprint) });
}
function componentResolvedRoleInvocationJson(value, rawAuthority, rawStage) {
  const subject = value.subject;
  const authority = value.component_authority;
  if (!plain(subject) || !plain(authority)) return "";
  const fields = {
    version: json(value.version),
    role_id: json(value.role_id),
    role_source: json(value.role_source),
    stance: json(value.stance),
    subject: goRoleSubjectJson(subject),
    component_authority: rawAuthority ?? goComponentAuthorityJson(authority)
  };
  if (Object.prototype.hasOwnProperty.call(value, "onboarding_stage")) fields.onboarding_stage = rawStage ?? proofOnboardingStageContextJson(value.onboarding_stage);
  return proofStructJson({
    ...fields,
    authority: json(value.authority),
    output_schema_id: json(value.output_schema_id),
    output_schema: json(value.output_schema),
    output_schema_digest: json(value.output_schema_digest),
    instructions: json(value.instructions),
    role_text_digest: json(value.role_text_digest),
    invocation_digest: json(value.invocation_digest)
  });
}
function componentRoleInvocationJson(value, rawAuthority, rawStage) {
  const subject = value.subject;
  const authority = value.component_authority;
  const authorityJson = rawAuthority ?? goComponentAuthorityJson(authority);
  if (authorityJson === "") return "";
  const fields = {
    role_id: json(value.role_id),
    stance: json(value.stance),
    subject: goRoleSubjectJson(subject),
    component_authority: authorityJson
  };
  if (Object.prototype.hasOwnProperty.call(value, "onboarding_stage")) fields.onboarding_stage = rawStage ?? proofOnboardingStageContextJson(value.onboarding_stage);
  return proofStructJson({
    ...fields,
    output_schema_id: json(value.output_schema_id),
    output_schema: json(value.output_schema)
  });
}
function proofComponentCandidateEnvelopeJsonWithRaw(value, rawAuthority, rawStage) {
  const invocation = value.Invocation;
  if (!plain(invocation) || !Object.prototype.hasOwnProperty.call(invocation, "component_authority")) return json(value);
  const fields = {};
  for (const key of CANDIDATE_ENVELOPE_KEYS) {
    if (key === "Invocation") fields[key] = componentRoleInvocationJson(invocation, rawAuthority, rawStage);
    else fields[key] = json(value[key]);
  }
  return proofStructJson(fields);
}
function proofComponentCandidateEnvelopeJson(value) {
  return proofComponentCandidateEnvelopeJsonWithRaw(value);
}
function proofCandidateAdmissionRequestJson(value) {
  const candidate = value.candidate;
  if (!plain(candidate)) return json(value);
  return proofStructJson({
    version: json(value.version),
    candidate: proofComponentCandidateEnvelopeJson(candidate)
  });
}
function validUnicode2(value) {
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 55296 && code <= 56319) {
        const next = value.charCodeAt(i + 1);
        if (next < 56320 || next > 57343) return false;
        i++;
      } else if (code >= 56320 && code <= 57343) return false;
    }
    return true;
  }
  if (Array.isArray(value)) return value.every(validUnicode2);
  if (plain(value)) return Object.values(value).every(validUnicode2);
  return value === null || typeof value === "boolean" || typeof value === "number";
}
function digest(domain, bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash4("sha256").update(domain).update(Buffer.from([0])).update(length).update(bytes).digest("hex")}`;
}
function parseRequest(request) {
  const raw = Buffer.from(request, "utf8");
  if (raw.length > REQUEST_LIMIT) fail("request exceeds bounded wire limit");
  try {
    new TextDecoder2("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail("request UTF-8 is invalid");
  }
  let outer;
  try {
    outer = JSON.parse(request);
  } catch {
    fail("request is not JSON");
  }
  if (!exact(outer, ["version", "candidate"]) || outer.version !== "proof.role-result-candidate-cli-request/v1") fail("request envelope is invalid");
  if (typeof outer.candidate !== "object" || outer.candidate === null) fail("candidate is not an object");
  const candidate = outer.candidate;
  const candidateKeys = ["Version", "Invocation", "InvocationDigest", "RoleID", "Stance", "Subject", "AttestationVersion", "ExecutionSource", "ProbeInvocationDigest", "IdentityVersion", "IdentitySource", "ResultDigest", "CanonicalBytes", "ProbeResultBytes", "VisorPayloadBytes", "Publication", "Binding", "Termination"];
  if (!exact(candidate, candidateKeys) || !validUnicode2(candidate)) fail("candidate wire keys or Unicode are invalid");
  const wireMode = governedWireModeFromInvocation(candidate.Invocation);
  validateCandidateShape(candidate, wireMode);
  const marker = request.indexOf('"candidate":');
  const start = marker + '"candidate":'.length;
  const end = jsonValueEnd(request, start);
  const rawCandidate = end < 0 ? "" : request.slice(start, end);
  const rawInvocation = rawObjectField(rawCandidate, "Invocation");
  const encoded = proofComponentCandidateEnvelopeJsonWithRaw(
    candidate,
    rawInvocation ? rawObjectField(rawInvocation, "component_authority") : void 0,
    rawInvocation ? rawObjectField(rawInvocation, "onboarding_stage") : void 0
  );
  if (marker < 0 || rawCandidate !== encoded || request.slice(end) !== "}") fail("candidate wire is not canonical");
  const byteStart = Buffer.byteLength(request.slice(0, start), "utf8");
  const byteLength = Buffer.byteLength(rawCandidate, "utf8");
  return { raw, candidate, candidateRaw: raw.subarray(byteStart, byteStart + byteLength), wireMode };
}
function extractProofAdmissionCandidate(request) {
  const parsed = parseRequest(request);
  return Object.freeze({
    candidate: parsed.candidate,
    candidateRaw: Buffer.from(parsed.candidateRaw),
    wireMode: parsed.wireMode
  });
}
function b64(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.from(value, "base64").toString("base64") !== value) fail("wire bytes are invalid");
  return Buffer.from(value, "base64");
}
function validateCandidateShape(candidate, wireMode) {
  const invocation = candidate.Invocation;
  const hasAuthority = Object.prototype.hasOwnProperty.call(invocation, "component_authority");
  const staged = Object.prototype.hasOwnProperty.call(invocation, "onboarding_stage");
  const invocationKeys = staged ? ["role_id", "stance", "subject", "component_authority", "onboarding_stage", "output_schema_id", "output_schema"] : hasAuthority ? ["role_id", "stance", "subject", "component_authority", "output_schema_id", "output_schema"] : ["role_id", "stance", "subject", "output_schema_id", "output_schema"];
  if (!exact(invocation, invocationKeys) || !exact(invocation.subject, ["kind", "id", "fingerprint"]) || !exact(candidate.Subject, ["kind", "id", "fingerprint"]) || !equalCanonicalJson(invocation.subject, candidate.Subject) || staged && (!hasAuthority || invocation.role_id !== "spec-review" || invocation.subject.kind !== "component")) fail("invocation wire shape is invalid");
  if (hasAuthority && goComponentAuthorityJson(invocation.component_authority) === "") fail("component authority wire shape is invalid");
  if (staged) {
    try {
      validateOnboardingStageContext(invocation.onboarding_stage);
    } catch {
      fail("onboarding stage wire shape is invalid");
    }
  }
  const expectedCheck = staged ? STAGED_CANDIDATE_CHECK : "inspect";
  const expectedClaim = staged ? STAGED_CANDIDATE_CLAIM : "proof.candidate@1";
  const scope = (value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some((part) => !exact(part, ["Kind", "ExpansionOwnerCheck", "Key", "SubgraphInstanceID"]))) fail("scope wire shape is invalid");
  };
  const publication = candidate.Publication;
  if (!exact(publication, ["Version", "Type", "SessionID", "CheckID", "Scope", "NodeInstanceID", "NodeGenerationID", "AttemptID", "Fence", "ClaimID", "Claim", "PayloadFingerprint", "ProducerCheckID", "Payload", "ParentClaimIDs"])) fail("publication wire shape is invalid");
  if (publication.CheckID !== expectedCheck || publication.Claim !== expectedClaim || publication.ProducerCheckID !== expectedCheck) fail("candidate publication protocol is invalid");
  scope(publication.Scope);
  const binding = candidate.Binding;
  if (!exact(binding, ["ManagedRunID", "SessionID", "CheckID", "Scope", "NodeInstanceID", "NodeGenerationID", "AttemptID", "Fence"])) fail("binding wire shape is invalid");
  if (binding.CheckID !== expectedCheck) fail("candidate binding protocol is invalid");
  scope(binding.Scope);
  const termination = candidate.Termination;
  if (!exact(termination, ["Version", "Type", "SessionID", "Scope", "Binding", "CleanupStatus", "ControllerDecision", "FailureCode"]) || termination.FailureCode !== null) fail("termination wire shape is invalid");
  scope(termination.Scope);
  const terminationBinding = termination.Binding;
  if (!exact(terminationBinding, ["ManagedRunID", "SessionID", "CheckID", "Scope", "NodeInstanceID", "NodeGenerationID", "AttemptID", "Fence"])) fail("termination binding wire shape is invalid");
  if (terminationBinding.CheckID !== expectedCheck) fail("candidate termination protocol is invalid");
  const parents = publication.ParentClaimIDs;
  if (!Array.isArray(parents) || parents.some((id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) || parents.some((id, index) => index > 0 && parents[index - 1] >= id)) fail("candidate parents are invalid");
  if (staged) validateStagedCandidateLineage(candidate, invocation.onboarding_stage);
  scope(terminationBinding.Scope);
  const probe = b64(candidate.ProbeResultBytes);
  if (candidate.CanonicalBytes !== probe.length || candidate.ProbeResultBytes !== candidate.VisorPayloadBytes || candidate.ProbeResultBytes !== publication.Payload) fail("candidate bytes are not bound");
  try {
    const payloadText = new TextDecoder2("utf-8", { fatal: true }).decode(probe);
    const payload = JSON.parse(payloadText);
    if (!validUnicode2(payload) || governedCanonicalJson(payload, wireMode) !== payloadText) fail("candidate payload is not canonical");
  } catch {
    fail("candidate payload is not valid UTF-8 JSON");
  }
}
function validateStagedCandidateLineage(candidate, stage) {
  const priorRaw = stage.prior_candidate;
  const priorText = typeof priorRaw === "string" ? priorRaw : plain(priorRaw) ? proofComponentCandidateEnvelopeJson(priorRaw) : "";
  let prior;
  let admission;
  try {
    prior = JSON.parse(priorText);
    admission = JSON.parse(typeof stage.prior_admission === "string" ? stage.prior_admission : json(stage.prior_admission));
  } catch {
    fail("staged candidate predecessor evidence is invalid");
  }
  const priorInvocation = prior.Invocation;
  const priorPublication = prior.Publication;
  const currentPublication = candidate.Publication;
  const currentBinding = candidate.Binding;
  const priorBinding = prior.Binding;
  const parentClaimIDs = currentPublication.ParentClaimIDs;
  if (!plain(admission) || admission.status !== "ADMITTED" || !plain(admission.receipt) || !plain(priorInvocation) || Object.prototype.hasOwnProperty.call(priorInvocation, "onboarding_stage") || priorInvocation.role_id !== "onboard" || !plain(priorPublication) || !plain(priorBinding) || priorPublication.CheckID !== "inspect" || priorPublication.Claim !== "proof.candidate@1" || !equalCanonicalJson(prior.Subject, candidate.Subject) || !equalCanonicalJson(priorInvocation.subject, candidate.Subject) || !equalCanonicalJson(priorBinding.Scope, currentBinding.Scope) || !equalCanonicalJson(priorPublication.Scope, currentPublication.Scope) || priorBinding.SessionID !== currentBinding.SessionID || currentBinding.ManagedRunID === priorBinding.ManagedRunID || currentBinding.NodeInstanceID === priorBinding.NodeInstanceID || currentBinding.NodeGenerationID === priorBinding.NodeGenerationID || currentBinding.AttemptID === priorBinding.AttemptID || currentPublication.ClaimID === priorPublication.ClaimID || typeof priorPublication.ClaimID !== "string" || !/^[0-9a-f]{64}$/.test(priorPublication.ClaimID) || typeof stage.prior_admission_claim_id !== "string" || stage.prior_admission_claim_id === priorPublication.ClaimID || !parentClaimIDs?.includes(priorPublication.ClaimID) || !parentClaimIDs?.includes(stage.prior_admission_claim_id)) {
    fail("staged candidate predecessor lineage is invalid");
  }
}
function equalJson(left, right) {
  return json(left) === json(right);
}
function equalCanonicalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function proofScope(value) {
  const scope = value;
  return scope.map((segment) => ({
    Kind: segment.Kind,
    ExpansionOwnerCheck: segment.ExpansionOwnerCheck,
    Key: segment.Key,
    SubgraphInstanceID: segment.SubgraphInstanceID
  }));
}
function proofBinding(value) {
  const binding = value;
  return {
    ManagedRunID: binding.ManagedRunID,
    SessionID: binding.SessionID,
    CheckID: binding.CheckID,
    Scope: proofScope(binding.Scope),
    NodeInstanceID: binding.NodeInstanceID,
    NodeGenerationID: binding.NodeGenerationID,
    AttemptID: binding.AttemptID,
    Fence: binding.Fence
  };
}
function proofTermination(value) {
  const termination = value;
  return {
    Version: termination.Version,
    Type: termination.Type,
    SessionID: termination.SessionID,
    Scope: proofScope(termination.Scope),
    Binding: proofBinding(termination.Binding),
    CleanupStatus: termination.CleanupStatus,
    ControllerDecision: termination.ControllerDecision,
    FailureCode: termination.FailureCode
  };
}
function proofV1DecisionJson(value) {
  const receipt = value.receipt;
  const receiptJson = receipt === null ? "null" : (() => {
    if (!plain(receipt)) return "";
    const typed = receipt;
    const subject = typed.Subject;
    if (!plain(subject) || !plain(typed.Binding) || !plain(typed.Termination)) return "";
    return proofStructJson({
      Version: json(typed.Version),
      Status: json(typed.Status),
      CandidateID: json(typed.CandidateID),
      ProbeResultDigest: json(typed.ProbeResultDigest),
      ProbeCanonicalBytes: json(typed.ProbeCanonicalBytes),
      ClaimID: json(typed.ClaimID),
      Claim: json(typed.Claim),
      PayloadFingerprint: json(typed.PayloadFingerprint),
      InvocationDigest: json(typed.InvocationDigest),
      RoleID: json(typed.RoleID),
      Stance: json(typed.Stance),
      Subject: json({ kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint }),
      ProducerCheckID: json(typed.ProducerCheckID),
      ParentClaimIDs: json(typed.ParentClaimIDs),
      Binding: json(proofBinding(typed.Binding)),
      Termination: json(proofTermination(typed.Termination)),
      receipt_id: json(typed.receipt_id)
    });
  })();
  if (receipt !== null && receiptJson === "") return "";
  return proofStructJson({
    version: json(value.version),
    status: json(value.status),
    receipt: receiptJson,
    reject_code: json(value.reject_code)
  });
}
function proofV1AdmissionReceiptID(receipt) {
  const subject = receipt.Subject;
  if (!plain(subject) || !plain(receipt.Binding) || !plain(receipt.Termination)) return "";
  const unsigned = proofStructJson({
    Version: json(receipt.Version),
    Status: json(receipt.Status),
    CandidateID: json(receipt.CandidateID),
    ProbeResultDigest: json(receipt.ProbeResultDigest),
    ProbeCanonicalBytes: json(receipt.ProbeCanonicalBytes),
    ClaimID: json(receipt.ClaimID),
    Claim: json(receipt.Claim),
    PayloadFingerprint: json(receipt.PayloadFingerprint),
    InvocationDigest: json(receipt.InvocationDigest),
    RoleID: json(receipt.RoleID),
    Stance: json(receipt.Stance),
    Subject: json({ kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint }),
    ProducerCheckID: json(receipt.ProducerCheckID),
    ParentClaimIDs: json(receipt.ParentClaimIDs),
    Binding: json(proofBinding(receipt.Binding)),
    Termination: json(proofTermination(receipt.Termination))
  });
  return digest(RECEIPT_ID_DOMAIN_V1, Buffer.from(unsigned, "utf8"));
}
function acceptedAdmissionDecisionWire(value, decoded) {
  if (!plain(value)) return false;
  const decision = value;
  const receipt = decision.receipt;
  const version = decision.status === "ADMITTED" && plain(receipt) ? receipt.Version : RECEIPT_VERSION_V1;
  if (version === RECEIPT_VERSION_V2) return proofCanonicalJson(value) === decoded;
  if (version !== RECEIPT_VERSION_V1) return false;
  return proofCanonicalJson(value) === decoded || proofV1DecisionJson(decision) === decoded;
}
function validateReceipt(decision, candidate, rawCandidate, wireMode) {
  if (!exactUnordered(decision, ["version", "status", "receipt", "reject_code"]) || decision.version !== DECISION_VERSION) fail("decision envelope is invalid");
  const publication = candidate.Publication;
  const binding = candidate.Binding;
  const termination = candidate.Termination;
  if (decision.status === "REJECTED") {
    if (decision.receipt !== null || decision.reject_code !== "CANDIDATE_INVALID") fail("rejection decision is invalid");
    return;
  }
  if (decision.status !== "ADMITTED" || decision.reject_code !== null || !plain(decision.receipt)) fail("admission decision is invalid");
  const receipt = decision.receipt;
  const expectedVersion = candidate.Subject.kind === "project" ? RECEIPT_VERSION_V2 : RECEIPT_VERSION_V1;
  const receiptKeys = expectedVersion === RECEIPT_VERSION_V2 ? RECEIPT_V2_KEYS : RECEIPT_COMMON_KEYS;
  if (!exactUnordered(receipt, receiptKeys) || receipt.Version !== expectedVersion) fail("admission version or fields are invalid");
  if (wireMode === "proof" && expectedVersion !== RECEIPT_VERSION_V2) fail("Proof candidate requires project admission");
  if (wireMode === "generic" && expectedVersion === RECEIPT_VERSION_V2 && candidate.Subject.kind !== "project") fail("generic project admission is inconsistent");
  const lineage = receipt.ProjectLineage;
  if (expectedVersion === RECEIPT_VERSION_V2 && lineage !== null && (!plain(lineage) || !exactUnordered(lineage, ["version", "fingerprint", "object_format", "baseline_revision"]) || lineage.version !== "proof.git-project-lineage-binding/v1" || typeof lineage.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(lineage.fingerprint) || lineage.object_format !== "sha1" && lineage.object_format !== "sha256" || (lineage.object_format === "sha1" ? !/^sha1:[0-9a-f]{40}$/.test(String(lineage.baseline_revision)) : !/^sha256:[0-9a-f]{64}$/.test(String(lineage.baseline_revision))))) fail("admission project lineage is invalid");
  if (receipt.Status !== "ADMITTED" || receipt.CandidateID !== digest(CANDIDATE_ID_DOMAIN, rawCandidate) || receipt.ProbeResultDigest !== candidate.ResultDigest || receipt.ProbeCanonicalBytes !== candidate.CanonicalBytes || receipt.ClaimID !== publication.ClaimID || receipt.Claim !== publication.Claim || receipt.PayloadFingerprint !== publication.PayloadFingerprint || receipt.InvocationDigest !== candidate.InvocationDigest || receipt.RoleID !== candidate.RoleID || receipt.Stance !== candidate.Stance || !exactUnordered(receipt.Subject, ["kind", "id", "fingerprint"]) || !equalCanonicalJson(receipt.Subject, candidate.Subject) || receipt.ProducerCheckID !== publication.ProducerCheckID || !equalCanonicalJson(receipt.ParentClaimIDs, publication.ParentClaimIDs) || !equalCanonicalJson(receipt.Binding, binding) || !exactUnordered(receipt.Binding, ["ManagedRunID", "SessionID", "CheckID", "Scope", "NodeInstanceID", "NodeGenerationID", "AttemptID", "Fence"]) || !equalCanonicalJson(receipt.Termination, termination) || !exactUnordered(receipt.Termination, ["Version", "Type", "SessionID", "Scope", "Binding", "CleanupStatus", "ControllerDecision", "FailureCode"]) || typeof receipt.receipt_id !== "string") fail("admission receipt identity is invalid");
  const subject = receipt.Subject;
  const unsignedFields = {
    Version: json(receipt.Version),
    Status: json(receipt.Status),
    CandidateID: json(receipt.CandidateID),
    ProbeResultDigest: json(receipt.ProbeResultDigest),
    ProbeCanonicalBytes: json(receipt.ProbeCanonicalBytes),
    ClaimID: json(receipt.ClaimID),
    Claim: json(receipt.Claim),
    PayloadFingerprint: json(receipt.PayloadFingerprint),
    InvocationDigest: json(receipt.InvocationDigest),
    RoleID: json(receipt.RoleID),
    Stance: json(receipt.Stance),
    Subject: json({ kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint }),
    ProducerCheckID: json(receipt.ProducerCheckID),
    ParentClaimIDs: json(receipt.ParentClaimIDs),
    Binding: json(proofBinding(receipt.Binding)),
    Termination: json(proofTermination(receipt.Termination))
  };
  if (expectedVersion === RECEIPT_VERSION_V2) {
    unsignedFields.ProjectLineage = json(lineage === null ? null : (() => {
      const projectLineage = lineage;
      return {
        version: projectLineage.version,
        fingerprint: projectLineage.fingerprint,
        object_format: projectLineage.object_format,
        baseline_revision: projectLineage.baseline_revision
      };
    })());
  }
  const unsigned = expectedVersion === RECEIPT_VERSION_V2 ? proofTopLevelJson(unsignedFields) : proofStructJson(unsignedFields);
  const receiptDomain = expectedVersion === RECEIPT_VERSION_V2 ? RECEIPT_ID_DOMAIN_V2 : RECEIPT_ID_DOMAIN_V1;
  if (receipt.receipt_id !== digest(receiptDomain, Buffer.from(unsigned, "utf8"))) fail("admission receipt ID is invalid");
}
function decodeProofWire(value, label) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) fail(`${label} type is invalid`);
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  let decoded;
  try {
    decoded = new TextDecoder2("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`${label} UTF-8 is invalid`);
  }
  if (typeof value === "string" && decoded !== value) fail(`${label} UTF-8 is invalid`);
  return decoded;
}
function validateProofComponentAdmissionOutcome(candidateWire, admissionWire) {
  const candidateText = decodeProofWire(candidateWire, "candidate");
  const admissionText = decodeProofWire(admissionWire, "admission");
  const parsed = parseRequest(`{"version":"proof.role-result-candidate-cli-request/v1","candidate":${candidateText}}`);
  const subject = parsed.candidate.Subject;
  if (!plain(subject) || subject.kind !== "component" || typeof subject.id !== "string" || subject.id.length === 0 || typeof subject.fingerprint !== "string" || subject.fingerprint.length === 0) {
    fail("component candidate subject is invalid");
  }
  let decision;
  try {
    decision = JSON.parse(admissionText);
  } catch {
    fail("admission is not JSON");
  }
  if (!acceptedAdmissionDecisionWire(decision, admissionText)) fail("admission decision wire is not canonical");
  validateReceipt(decision, parsed.candidate, parsed.candidateRaw, parsed.wireMode);
  if (!plain(decision) || decision.status !== "ADMITTED" || !plain(decision.receipt) || decision.receipt.Version !== RECEIPT_VERSION_V1) {
    fail("component admission is not an admitted v1 receipt");
  }
  const receipt = decision.receipt;
  const binding = receipt.Binding;
  if (!plain(binding) || !Array.isArray(binding.Scope) || binding.Scope.length === 0) fail("component admission binding scope is invalid");
  const terminal = binding.Scope[binding.Scope.length - 1];
  if (!plain(terminal) || terminal.Kind !== "keyed" || terminal.Key !== subject.id) fail("component admission binding scope is not terminal for the component");
  const scope = binding.Scope.map((segment, index) => {
    if (!plain(segment) || typeof segment.Kind !== "string" || typeof segment.ExpansionOwnerCheck !== "string" || typeof segment.Key !== "string" || typeof segment.SubgraphInstanceID !== "string") {
      fail(`component admission binding scope segment ${index} is invalid`);
    }
    return {
      kind: segment.Kind,
      expansion_owner_check: segment.ExpansionOwnerCheck,
      key: segment.Key,
      subgraph_instance_id: segment.SubgraphInstanceID
    };
  });
  if (typeof receipt.CandidateID !== "string" || typeof receipt.ProbeResultDigest !== "string" || typeof receipt.receipt_id !== "string") {
    fail("component admission receipt identity has invalid types");
  }
  return freeze({
    candidateId: receipt.CandidateID,
    resultDigest: receipt.ProbeResultDigest,
    subject: {
      kind: subject.kind,
      id: subject.id,
      fingerprint: subject.fingerprint
    },
    scope,
    receiptId: receipt.receipt_id
  });
}
function executableStat(path) {
  try {
    if (!path.startsWith("/")) return void 0;
    const realpath = realpathSync2(path);
    const stat = statSync2(realpath);
    if (!stat.isFile() || (stat.mode & 73) === 0) return void 0;
    const bytes = readFileSync(realpath);
    return Object.freeze({ realpath, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, digest: createHash4("sha256").update(bytes).digest("hex") });
  } catch {
    return void 0;
  }
}
function sameExecutable(left, right) {
  return !!right && left.realpath === right.realpath && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.digest === right.digest;
}
function executableCapability(path) {
  const identity = executableStat(path);
  if (!identity) return void 0;
  const capability = Object.freeze({});
  executableCapabilities.set(capability, identity);
  return capability;
}
function capabilityIdentity(value) {
  return value && typeof value === "object" ? executableCapabilities.get(value) : void 0;
}
function proofAdmissionCapabilityValid(value) {
  const identity = capabilityIdentity(value);
  return !!identity && sameExecutable(identity, executableStat(identity.realpath));
}
function groupAbsent(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function runBoundedProofCommand(executable, args, input, workingDirectory, stdoutLimit) {
  let cancelCommand = () => void 0;
  const result = new Promise((resolve2, reject) => {
    let child, pid, status = null, signal = null, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), stdoutEnded = false, stderrEnded = false, closeSeen = false, settled = false, terminationRequested = false, termSent = false, killSent = false, inputWritten = false, timedOut = false;
    let deadlineTimer, killTimer, reapTimer, reapDeadline = 0;
    const clearTimers = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      deadlineTimer = void 0;
      killTimer = void 0;
      reapTimer = void 0;
    };
    const closeStreams = () => {
      if (typeof child?.stdin?.destroy === "function") child.stdin.destroy();
      if (typeof child?.stdout?.destroy === "function") child.stdout.destroy();
      if (typeof child?.stderr?.destroy === "function") child.stderr.destroy();
      stdoutEnded = true;
      stderrEnded = true;
    };
    const clearListeners = () => {
      for (const value of [child, child?.stdin, child?.stdout, child?.stderr]) if (value && typeof value.removeAllListeners === "function") value.removeAllListeners();
    };
    const rejectUnavailable = (cleanupFailed = false) => {
      if (settled) return;
      settled = true;
      clearTimers();
      closeStreams();
      clearListeners();
      reject(new Error(cleanupFailed ? PROOF_ADMISSION_CLEANUP_FAILED : PROOF_ADMISSION_UNAVAILABLE));
    };
    const proveGroupGone = () => !pid || groupAbsent(pid);
    const reapOrReject = () => {
      if (settled || !pid) return;
      if (proveGroupGone() && closeSeen && stdoutEnded && stderrEnded) {
        settle();
        return;
      }
      if (!reapDeadline) reapDeadline = Date.now() + 2e3;
      if (!reapTimer) reapTimer = setTimeout(() => {
        reapTimer = void 0;
        if (proveGroupGone() && closeSeen && stdoutEnded && stderrEnded) settle();
        else if (Date.now() >= reapDeadline) rejectUnavailable(true);
        else reapOrReject();
      }, 10);
    };
    const settle = () => {
      if (settled || !closeSeen || !stdoutEnded || !stderrEnded || !pid) return;
      if (!proveGroupGone()) return reapOrReject();
      settled = true;
      clearTimers();
      closeStreams();
      if (timedOut || !inputWritten) {
        reject(new Error(PROOF_ADMISSION_UNAVAILABLE));
        return;
      }
      resolve2(Object.freeze({ status, signal, stdout, stderr }));
    };
    const forceStop = () => {
      terminationRequested = true;
      timedOut = true;
      closeStreams();
      if (!pid) {
        rejectUnavailable();
        return;
      }
      if (!proveGroupGone() && !termSent) {
        termSent = true;
        try {
          signalGroup(pid, "SIGTERM");
        } catch {
          rejectUnavailable(true);
          return;
        }
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          killTimer = void 0;
          if (pid && !proveGroupGone() && !killSent) {
            killSent = true;
            try {
              signalGroup(pid, "SIGKILL");
            } catch {
              rejectUnavailable(true);
            }
          }
          reapOrReject();
        }, 250);
      }
      reapOrReject();
    };
    cancelCommand = forceStop;
    const append = (current, chunk, limit) => {
      const remaining = limit - current.length;
      if (remaining <= 0) return { value: current, overflow: chunk.length > 0 };
      return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), overflow: chunk.length > remaining };
    };
    try {
      child = spawn(executable.realpath, [...args], {
        cwd: workingDirectory,
        env: PROOF_CHILD_ENV,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      pid = child.pid;
      child.stdout?.on("data", (chunk) => {
        const appended = append(stdout, chunk, stdoutLimit);
        stdout = appended.value;
        if (appended.overflow) forceStop();
      });
      child.stderr?.on("data", (chunk) => {
        const appended = append(stderr, chunk, STDERR_LIMIT);
        stderr = appended.value;
        if (appended.overflow) forceStop();
      });
      child.stdout?.on("end", () => {
        stdoutEnded = true;
        settle();
      });
      child.stderr?.on("end", () => {
        stderrEnded = true;
        settle();
      });
      child.once("spawn", () => {
        pid = child?.pid;
        if (!pid || terminationRequested || !sameExecutable(executable, executableStat(executable.realpath))) {
          forceStop();
          return;
        }
        child?.stdin?.once("error", forceStop);
        child?.stdin?.end(input, "utf8", () => {
          inputWritten = true;
          settle();
        });
      });
      child.once("error", forceStop);
      child.once("exit", (code, exitedSignal) => {
        status = code;
        signal = exitedSignal;
        settle();
      });
      child.once("close", () => {
        closeSeen = true;
        if (!pid) rejectUnavailable();
        else if (!proveGroupGone()) forceStop();
        else settle();
      });
      deadlineTimer = setTimeout(forceStop, COMMAND_TIMEOUT_MS);
    } catch {
      rejectUnavailable();
    }
  });
  return Object.freeze({ result, cancel: () => cancelCommand() });
}
function goCompatibleProofJson(value) {
  return json(value);
}
function proofExecutableAvailable(path) {
  return process.platform !== "win32" && typeof path === "string" && executableStat(path) !== void 0;
}
function createProofAdmissionCapability(path) {
  const capability = executableCapability(path);
  if (!capability) fail(PROOF_ADMISSION_UNAVAILABLE);
  return capability;
}
function createProofAdmissionCliChildForFocusedTest(path) {
  return createProofAdmissionCapability(path);
}
async function resolveProofRoleInvocation(capability, request, workingDirectory, signal) {
  const executable = capabilityIdentity(capability);
  const component = plain(request) && Object.prototype.hasOwnProperty.call(request, "component_authority");
  const staged = component && Object.prototype.hasOwnProperty.call(request, "onboarding_stage");
  const requestKeys = staged ? C0_STAGED_COMPONENT_REQUEST_KEYS : component ? C0_COMPONENT_REQUEST_KEYS : C0_REQUEST_KEYS;
  if (process.platform === "win32" || !executable || !workingDirectory.startsWith("/") || !exact(request, requestKeys)) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  if (!sameExecutable(executable, executableStat(executable.realpath))) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  if (staged) {
    try {
      validateOnboardingStageContext(request.onboarding_stage);
    } catch {
      throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    }
  }
  const input = component ? componentRoleInvocationJson(request) : json(request);
  const inputLimit = staged ? PROOF_C0_REQUEST_MAX_BYTES : PROOF_C0_LEGACY_REQUEST_MAX_BYTES;
  if (Buffer.byteLength(input, "utf8") > inputLimit || !validUnicode2(request)) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let normalizedInput;
  if (component) {
    try {
      normalizedInput = JSON.parse(input);
    } catch {
      throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    }
  }
  if (signal?.aborted) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const command = runBoundedProofCommand(executable, ["resolve-role-invocation"], input, workingDirectory, PROOF_C0_RESPONSE_MAX_BYTES);
  const cancel = () => command.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  let result;
  try {
    result = await command.result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (!sameExecutable(executable, executableStat(executable.realpath)) || result.status !== 0 || result.signal || result.stderr.length !== 0 || result.stdout.length === 0 || result.stdout[result.stdout.length - 1] !== 10) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let stdout;
  try {
    stdout = new TextDecoder2("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }
  const output = stdout.slice(0, -1);
  if (output.includes("\n") || output.includes("\r")) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }
  const responseKeys = staged ? C0_STAGED_COMPONENT_RESPONSE_KEYS : component ? ["version", "role_id", "role_source", "stance", "subject", "component_authority", "authority", "output_schema_id", "output_schema", "output_schema_digest", "instructions", "role_text_digest", "invocation_digest"] : C0_KEYS;
  let stagedMismatch = false;
  let returnedAuthorityWire;
  let returnedStageWire;
  if (staged) {
    try {
      validateOnboardingStageContext(value.onboarding_stage);
    } catch {
      stagedMismatch = true;
    }
    const requestedStageWire = rawObjectField(input, "onboarding_stage");
    returnedStageWire = rawObjectField(output, "onboarding_stage");
    const requestedAuthorityWire = rawObjectField(input, "component_authority");
    returnedAuthorityWire = rawObjectField(output, "component_authority");
    stagedMismatch = stagedMismatch || requestedStageWire === void 0 || returnedStageWire === void 0 || returnedStageWire !== requestedStageWire || requestedAuthorityWire === void 0 || returnedAuthorityWire === void 0 || returnedAuthorityWire !== requestedAuthorityWire;
  }
  if (!exact(value, responseKeys) || (staged ? returnedAuthorityWire === void 0 || returnedStageWire === void 0 || componentResolvedRoleInvocationJson(value, returnedAuthorityWire, returnedStageWire) !== output : component ? componentResolvedRoleInvocationJson(value) !== output : json(value) !== output) || value.version !== "proof.role-invocation/v1" || value.role_id !== request.role_id || value.stance !== request.stance || !equalJson(value.subject, request.subject) || component && (!normalizedInput || proofCanonicalJson(value.component_authority) !== proofCanonicalJson(normalizedInput.component_authority)) || stagedMismatch || value.output_schema_id !== request.output_schema_id || value.output_schema !== request.output_schema || typeof value.instructions !== "string" || value.instructions.length === 0) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  return Object.freeze(value);
}
function validProofManagedCommand(value) {
  return Array.isArray(value) && (value.length === 1 && value[0] === "admit-candidate" || value.length === 2 && value[0] === "onboarding" && (value[1] === "inventory" || value[1] === "revalidate" || value[1] === "work-items" || value[1] === "reconcile"));
}
function startProofManagedCliChild(request, executablePath) {
  if (process.platform === "win32" || !request.workingDirectory || !validProofManagedCommand(request.command) || typeof request.input !== "string" || !Number.isSafeInteger(request.inputLimit) || request.inputLimit < 0 || !Number.isSafeInteger(request.outputLimit) || request.outputLimit < 2 || typeof request.outputCanonical !== "boolean") {
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }
  if (Buffer.byteLength(request.input, "utf8") > request.inputLimit) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const binding = request.binding;
  const executable = capabilityIdentity(executablePath);
  if (!executable) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let child;
  let pid;
  let exitCode;
  let signal;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  let stdoutBytes = 0, stderrBytes = 0;
  let stdoutEnd = false, stderrEnd = false, closeSeen = false, writeDone = false;
  let cleaned = false;
  let failed;
  let failureLogged = false;
  let output;
  let accepted = false;
  let terminationRequested = false;
  let termSent = false, killSent = false, timer, reapTimer;
  let cleanupFailed = false;
  let reapDeadline = 0;
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve2, reject) => {
    resolveStarted = resolve2;
    rejectStarted = reject;
  });
  let resolveOutcome;
  let rejectCleanup;
  let resolveCleanup;
  const outcome = new Promise((resolve2) => {
    resolveOutcome = resolve2;
  });
  const cleanup = new Promise((resolve2, reject) => {
    resolveCleanup = resolve2;
    rejectCleanup = reject;
  });
  const failOnce = (reason) => {
    if (!failed) failed = reason;
  };
  const emitFailureLog = (failureStage, reason) => {
    if (failureLogged) return;
    failureLogged = true;
    const stdoutLog = stdout.subarray(0, FAILED_LOG_STREAM_LIMIT);
    const stderrLog = stderr.subarray(0, FAILED_LOG_STREAM_LIMIT);
    const record = {
      event: "proof_managed_cli_failed",
      command: [...request.command],
      binding: {
        managedRunId: binding.managedRunId,
        checkId: binding.checkId,
        attemptId: binding.attemptId
      },
      failure_stage: failureStage,
      reason,
      exit_code: exitCode ?? null,
      signal: signal ?? null,
      stdout: stdoutLog.toString("utf8"),
      stderr: stderrLog.toString("utf8"),
      stdout_original_bytes: stdoutBytes,
      stderr_original_bytes: stderrBytes,
      stdout_truncated: stdoutBytes > stdoutLog.length,
      stderr_truncated: stderrBytes > stderrLog.length
    };
    try {
      logger.error(JSON.stringify(record));
    } catch {
    }
  };
  const resolveFailed = (failureStage, reason) => {
    emitFailureLog(failureStage, reason);
    resolveOutcome(Object.freeze({ version: 1, kind: "failed", binding }));
  };
  const closeStreams = () => {
    for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
      if (stream && typeof stream.destroy === "function") stream.destroy();
    }
    stdoutEnd = true;
    stderrEnd = true;
  };
  const settleBeforePid = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer) {
      clearTimeout(timer);
      timer = void 0;
    }
    if (reapTimer) {
      clearTimeout(reapTimer);
      reapTimer = void 0;
    }
    closeStreams();
    child?.removeAllListeners();
    child?.stdin?.removeAllListeners();
    child?.stdout?.removeAllListeners();
    child?.stderr?.removeAllListeners();
    resolveFailed("spawn", failed || "child unavailable");
    resolveCleanup(Object.freeze({ version: 1, kind: "cleanup", binding, status: "clean", activeChildren: 0, activeResources: 0 }));
  };
  const reapOrSettle = () => {
    if (cleaned || !pid) return;
    if (groupAbsent(pid)) {
      settle();
      return;
    }
    if (!reapDeadline) reapDeadline = Date.now() + 2e3;
    if (!reapTimer) reapTimer = setTimeout(() => {
      reapTimer = void 0;
      if (pid && groupAbsent(pid)) settle();
      else if (Date.now() >= reapDeadline) {
        cleanupFailed = true;
        failOnce("process group reap timed out");
        cleaned = true;
        if (timer) {
          clearTimeout(timer);
          timer = void 0;
        }
        closeStreams();
        child?.removeAllListeners();
        child?.stdin?.removeAllListeners();
        child?.stdout?.removeAllListeners();
        child?.stderr?.removeAllListeners();
        resolveFailed("cleanup", failed || "process group reap timed out");
        rejectCleanup(new Error(PROOF_ADMISSION_CLEANUP_FAILED));
      } else reapOrSettle();
    }, 10);
  };
  const killIfNeeded = () => {
    if (!pid || groupAbsent(pid)) return;
    closeStreams();
    if (!termSent) {
      termSent = true;
      try {
        signalGroup(pid, "SIGTERM");
      } catch {
        cleanupFailed = true;
        failOnce("termination failed");
      }
    }
    if (!timer) timer = setTimeout(() => {
      timer = void 0;
      if (pid && !groupAbsent(pid) && !killSent) {
        killSent = true;
        try {
          signalGroup(pid, "SIGKILL");
        } catch {
          cleanupFailed = true;
          failOnce("termination failed");
        }
      }
      reapOrSettle();
    }, 250);
    reapOrSettle();
  };
  const settle = () => {
    if (!closeSeen || !stdoutEnd || !stderrEnd || !pid || !groupAbsent(pid)) return;
    if (cleaned) return;
    cleaned = true;
    if (timer) {
      clearTimeout(timer);
      timer = void 0;
    }
    if (reapTimer) {
      clearTimeout(reapTimer);
      reapTimer = void 0;
    }
    child?.removeAllListeners();
    child?.stdin?.removeAllListeners();
    child?.stdout?.removeAllListeners();
    child?.stderr?.removeAllListeners();
    if (cleanupFailed) {
      resolveFailed("cleanup", failed || PROOF_ADMISSION_CLEANUP_FAILED);
      rejectCleanup(new Error(PROOF_ADMISSION_CLEANUP_FAILED));
      return;
    }
    if (!failed && accepted && writeDone && exitCode === 0 && signal === null && stderr.length === 0 && output !== void 0) {
      resolveOutcome(Object.freeze({ version: 1, kind: "succeeded", binding, summary: Object.freeze({ issues: [], output }) }));
    } else {
      resolveFailed("outcome", failed || (signal ? "child terminated by signal" : exitCode !== 0 ? "child exited nonzero" : "managed outcome invalid"));
    }
    resolveCleanup(Object.freeze({ version: 1, kind: "cleanup", binding, status: "clean", activeChildren: 0, activeResources: 0 }));
  };
  const inspectStdout = () => {
    if (failed || stdout.length > request.outputLimit || stdout.length < 2 || stdout[stdout.length - 1] !== 10) return;
    const raw = stdout.subarray(0, stdout.length - 1);
    if (request.outputCanonical && raw.includes(10)) {
      failOnce("decision framing invalid");
      return;
    }
    let decoded;
    try {
      decoded = new TextDecoder2("utf-8", { fatal: true }).decode(raw);
    } catch {
      failOnce("decision UTF-8 invalid");
      return;
    }
    try {
      const parsedOutput = JSON.parse(decoded);
      if (request.outputCanonical && !acceptedAdmissionDecisionWire(parsedOutput, decoded)) failOnce("decision is not canonical");
      else {
        output = freeze(request.projectOutput(parsedOutput, decoded));
        accepted = true;
      }
    } catch {
      failOnce("decision protocol invalid");
    }
  };
  const attach = (proc) => {
    proc.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      const remaining = request.outputLimit - stdout.length;
      const append = Math.min(chunk.length, remaining);
      if (append > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, append)]);
      if (chunk.length > remaining) {
        failOnce("stdout limit exceeded");
        killIfNeeded();
      }
    });
    proc.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      const remaining = STDERR_LIMIT - stderr.length;
      const append = Math.min(chunk.length, remaining);
      if (append > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, append)]);
      if (chunk.length > remaining) {
        failOnce("stderr limit exceeded");
        killIfNeeded();
      }
    });
    proc.stdout?.on("end", () => {
      stdoutEnd = true;
      inspectStdout();
      settle();
    });
    proc.stderr?.on("end", () => {
      stderrEnd = true;
      settle();
    });
    proc.on("error", () => {
      failOnce("child process failed");
      rejectStarted(new Error(PROOF_ADMISSION_UNAVAILABLE));
      closeSeen = true;
      stdoutEnd = true;
      stderrEnd = true;
      if (!pid) settleBeforePid();
      else {
        killIfNeeded();
        settle();
      }
    });
    proc.on("exit", (code, exitedSignal) => {
      exitCode = code;
      signal = exitedSignal;
      settle();
    });
    proc.on("close", () => {
      closeSeen = true;
      if (pid && !groupAbsent(pid)) {
        failOnce("detached process group survived parent");
        killIfNeeded();
      }
      settle();
    });
  };
  if (!sameExecutable(executable, executableStat(executable.realpath))) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  try {
    child = spawn(executable.realpath, [...request.command], { cwd: request.workingDirectory, env: PROOF_CHILD_ENV, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    attach(child);
    child.once("spawn", () => {
      pid = child?.pid;
      if (!pid) {
        failOnce("child process did not expose a pid");
        rejectStarted(new Error(PROOF_ADMISSION_UNAVAILABLE));
        settleBeforePid();
        return;
      }
      resolveStarted(Object.freeze({ version: 1, kind: "started", binding }));
      if (terminationRequested) {
        killIfNeeded();
        return;
      }
      if (!sameExecutable(executable, executableStat(executable.realpath))) {
        failOnce("executable changed before write");
        killIfNeeded();
        return;
      }
      if (request.input.length === 0) {
        writeDone = true;
        child?.stdin?.destroy();
        settle();
      } else {
        child?.stdin?.once("error", () => {
          failOnce("request write failed");
          killIfNeeded();
        });
        child?.stdin?.end(request.input, "utf8", () => {
          writeDone = true;
          settle();
        });
      }
    });
  } catch {
    failOnce("child acquisition failed");
    rejectStarted(new Error(PROOF_ADMISSION_UNAVAILABLE));
    if (pid) {
      killIfNeeded();
    } else {
      closeSeen = true;
      stdoutEnd = true;
      stderrEnd = true;
      settleBeforePid();
    }
  }
  const terminate = async () => {
    if (!cleaned) {
      terminationRequested = true;
      if (pid) killIfNeeded();
    }
    await cleanup;
    return { version: 1, kind: "cancelled", binding, reason: "deadline" };
  };
  return Object.freeze({
    binding,
    started,
    outcome,
    cancel: async (reason, fence) => {
      if (fence !== binding.fence) throw new Error("stale cancellation fence");
      return terminate();
    },
    close: async () => {
      if (!cleaned) {
        terminationRequested = true;
        if (pid) killIfNeeded();
      }
      return cleanup;
    }
  });
}
function startProofAdmissionCliChild(request, executablePath) {
  const parsed = parseRequest(request.proofAdmissionRequest);
  return startProofManagedCliChild({
    binding: request.binding,
    workingDirectory: request.workingDirectory,
    command: ["admit-candidate"],
    input: request.proofAdmissionRequest,
    inputLimit: REQUEST_LIMIT,
    outputLimit: STDOUT_LIMIT,
    outputCanonical: true,
    projectOutput: (value, raw) => {
      validateReceipt(value, parsed.candidate, parsed.candidateRaw, parsed.wireMode);
      const decision = value;
      if (decision.status !== "ADMITTED" || !plain(decision.receipt)) fail("candidate was not admitted");
      return { ...decision.receipt, [PROOF_ADMISSION_WIRE_FIELD]: raw };
    }
  }, executablePath);
}
var PROOF_ADMISSION_UNAVAILABLE, PROOF_ADMISSION_CLEANUP_FAILED, PROOF_ADMISSION_WIRE_FIELD, PROOF_ONBOARDING_STAGE_CONTEXT_VERSION, PROOF_ONBOARDING_STAGE_SPEC_REVIEW, PROOF_ADMISSION_OUTPUT_MAX_BYTES, PROOF_ONBOARDING_STAGE_MAX_BYTES, PROOF_C0_LEGACY_REQUEST_MAX_BYTES, PROOF_C0_REQUEST_MAX_BYTES, PROOF_C0_RESPONSE_MAX_BYTES, PROOF_ADMISSION_REQUEST_MAX_BYTES, REQUEST_LIMIT, STDOUT_LIMIT, STDERR_LIMIT, FAILED_LOG_STREAM_LIMIT, PROOF_CHILD_ENV, COMMAND_TIMEOUT_MS, DECISION_VERSION, RECEIPT_VERSION_V1, RECEIPT_VERSION_V2, CANDIDATE_ID_DOMAIN, RECEIPT_ID_DOMAIN_V1, RECEIPT_ID_DOMAIN_V2, C0_KEYS, C0_REQUEST_KEYS, C0_COMPONENT_REQUEST_KEYS, C0_STAGED_COMPONENT_REQUEST_KEYS, C0_STAGED_COMPONENT_RESPONSE_KEYS, ONBOARDING_STAGE_KEYS, RECEIPT_COMMON_KEYS, RECEIPT_V2_KEYS, CATALOG_REVALIDATION_RECEIPT_COMMON_KEYS, CATALOG_REVALIDATION_RECEIPT_V1_KEYS, CATALOG_REVALIDATION_RECEIPT_V2_KEYS, CANDIDATE_ENVELOPE_KEYS, STAGED_CANDIDATE_CHECK, STAGED_CANDIDATE_CLAIM, executableCapabilities;
var init_proof_admission_cli_child = __esm({
  "src/providers/proof-admission-cli-child.ts"() {
    "use strict";
    init_logger();
    init_claim_kernel();
    init_proof_wire();
    init_proof_wire();
    PROOF_ADMISSION_UNAVAILABLE = "PROOF_ADMISSION_UNAVAILABLE";
    PROOF_ADMISSION_CLEANUP_FAILED = "PROOF_ADMISSION_CLEANUP_FAILED";
    PROOF_ADMISSION_WIRE_FIELD = "__proof_admission_wire";
    PROOF_ONBOARDING_STAGE_CONTEXT_VERSION = "proof.onboarding-stage-context/v1";
    PROOF_ONBOARDING_STAGE_SPEC_REVIEW = "spec_review";
    PROOF_ADMISSION_OUTPUT_MAX_BYTES = 2097152;
    PROOF_ONBOARDING_STAGE_MAX_BYTES = PROOF_ADMISSION_OUTPUT_MAX_BYTES;
    PROOF_C0_LEGACY_REQUEST_MAX_BYTES = 1463640;
    PROOF_C0_REQUEST_MAX_BYTES = PROOF_C0_LEGACY_REQUEST_MAX_BYTES + PROOF_ONBOARDING_STAGE_MAX_BYTES;
    PROOF_C0_RESPONSE_MAX_BYTES = 8388608;
    PROOF_ADMISSION_REQUEST_MAX_BYTES = 2162688;
    REQUEST_LIMIT = PROOF_ADMISSION_REQUEST_MAX_BYTES;
    STDOUT_LIMIT = PROOF_ADMISSION_OUTPUT_MAX_BYTES;
    STDERR_LIMIT = 65536;
    FAILED_LOG_STREAM_LIMIT = 4096;
    PROOF_CHILD_ENV = Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" });
    COMMAND_TIMEOUT_MS = process.env.NODE_ENV === "test" && Number(process.env.VISOR_PROOF_C0_TIMEOUT_MS) > 0 ? Number(process.env.VISOR_PROOF_C0_TIMEOUT_MS) : 12e4;
    DECISION_VERSION = "proof.role-result-candidate-cli-decision/v1";
    RECEIPT_VERSION_V1 = "proof.role-result-candidate-admission/v1";
    RECEIPT_VERSION_V2 = "proof.role-result-candidate-admission/v2";
    CANDIDATE_ID_DOMAIN = "proof.role-result-candidate-envelope/id/v1";
    RECEIPT_ID_DOMAIN_V1 = "proof.role-result-candidate-receipt/id/v1";
    RECEIPT_ID_DOMAIN_V2 = "proof.role-result-candidate-receipt/id/v2";
    C0_KEYS = ["version", "role_id", "role_source", "stance", "subject", "authority", "output_schema_id", "output_schema", "output_schema_digest", "instructions", "role_text_digest", "invocation_digest"];
    C0_REQUEST_KEYS = ["role_id", "stance", "subject", "output_schema_id", "output_schema"];
    C0_COMPONENT_REQUEST_KEYS = ["role_id", "stance", "subject", "component_authority", "output_schema_id", "output_schema"];
    C0_STAGED_COMPONENT_REQUEST_KEYS = ["role_id", "stance", "subject", "component_authority", "onboarding_stage", "output_schema_id", "output_schema"];
    C0_STAGED_COMPONENT_RESPONSE_KEYS = ["version", "role_id", "role_source", "stance", "subject", "component_authority", "onboarding_stage", "authority", "output_schema_id", "output_schema", "output_schema_digest", "instructions", "role_text_digest", "invocation_digest"];
    ONBOARDING_STAGE_KEYS = ["version", "stage_id", "prior_candidate", "prior_admission", "prior_admission_claim_id", "prior_admission_payload_fingerprint"];
    RECEIPT_COMMON_KEYS = ["Version", "Status", "CandidateID", "ProbeResultDigest", "ProbeCanonicalBytes", "ClaimID", "Claim", "PayloadFingerprint", "InvocationDigest", "RoleID", "Stance", "Subject", "ProducerCheckID", "ParentClaimIDs", "Binding", "Termination", "receipt_id"];
    RECEIPT_V2_KEYS = [...RECEIPT_COMMON_KEYS.slice(0, 16), "ProjectLineage", "receipt_id"];
    CATALOG_REVALIDATION_RECEIPT_COMMON_KEYS = [
      "version",
      "decision",
      "project_id",
      "project_fingerprint",
      "boundary_fingerprint",
      "inventory_claim_id",
      "catalog_claim_id",
      "admission_candidate_id",
      "admission_result_digest",
      "admission_receipt_id",
      "component_authorities",
      "receipt_id"
    ];
    CATALOG_REVALIDATION_RECEIPT_V1_KEYS = CATALOG_REVALIDATION_RECEIPT_COMMON_KEYS;
    CATALOG_REVALIDATION_RECEIPT_V2_KEYS = [
      ...CATALOG_REVALIDATION_RECEIPT_COMMON_KEYS.slice(0, 11),
      "project_lineage",
      "receipt_id"
    ];
    CANDIDATE_ENVELOPE_KEYS = ["Version", "Invocation", "InvocationDigest", "RoleID", "Stance", "Subject", "AttestationVersion", "ExecutionSource", "ProbeInvocationDigest", "IdentityVersion", "IdentitySource", "ResultDigest", "CanonicalBytes", "ProbeResultBytes", "VisorPayloadBytes", "Publication", "Binding", "Termination"];
    STAGED_CANDIDATE_CHECK = "spec_review";
    STAGED_CANDIDATE_CLAIM = "proof.component_spec_review_candidate@1";
    executableCapabilities = /* @__PURE__ */ new WeakMap();
  }
});

// src/providers/proof-catalog-check-providers.ts
var proof_catalog_check_providers_exports = {};
__export(proof_catalog_check_providers_exports, {
  CATALOG_REVALIDATION_RECEIPT_VERSION: () => CATALOG_REVALIDATION_RECEIPT_VERSION,
  CATALOG_REVALIDATION_VERSION: () => CATALOG_REVALIDATION_VERSION,
  COMPONENT_CATALOG_CANDIDATE_VERSION: () => COMPONENT_CATALOG_CANDIDATE_VERSION,
  PROOF_CATALOG_INPUT_MAX_BYTES: () => PROOF_CATALOG_INPUT_MAX_BYTES,
  PROOF_INVENTORY_OUTPUT_MAX_BYTES: () => PROOF_INVENTORY_OUTPUT_MAX_BYTES,
  PROOF_REVALIDATION_OUTPUT_MAX_BYTES: () => PROOF_REVALIDATION_OUTPUT_MAX_BYTES,
  PROOF_REVALIDATION_REQUEST_MAX_BYTES: () => PROOF_REVALIDATION_REQUEST_MAX_BYTES,
  PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES: () => PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES,
  ProofCatalogRevalidationCheckProvider: () => ProofCatalogRevalidationCheckProvider,
  ProofStructuralInventoryCheckProvider: () => ProofStructuralInventoryCheckProvider,
  STRUCTURAL_INVENTORY_VERSION: () => STRUCTURAL_INVENTORY_VERSION,
  compareProofStrings: () => compareProofStrings,
  createProofCatalogRevalidationProviderFromCapability: () => createProofCatalogRevalidationProviderFromCapability,
  createProofStructuralInventoryProviderFromCapability: () => createProofStructuralInventoryProviderFromCapability,
  proofCatalogRevalidationReceiptIdentityJson: () => proofCatalogRevalidationReceiptIdentityJson,
  proofWorkItemDigestForReconciliation: () => proofWorkItemDigestForReconciliation,
  validateGovernedProofCandidateClaim: () => validateGovernedProofCandidateClaim,
  validateProofCandidateAdmissionBinding: () => validateProofCandidateAdmissionBinding,
  validateProofCatalogRevalidationProjection: () => validateProofCatalogRevalidationProjection,
  validateProofComponentCandidateAdmissionBinding: () => validateProofComponentCandidateAdmissionBinding,
  validateProofComponentCandidateClaim: () => validateProofComponentCandidateClaim,
  validateProofCurrentCatalogAuthorityBytes: () => validateProofCurrentCatalogAuthorityBytes,
  validateProofWorkItemsProjection: () => validateProofWorkItemsProjection,
  validateStructuralInventory: () => validateStructuralInventory
});
import { createHash as createHash5 } from "crypto";
function compareProofStrings(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
function proofSorted(values) {
  return [...values].sort(compareProofStrings);
}
function invalid(detail) {
  throw new Error(`PROOF_CATALOG_INVALID: ${detail}`);
}
function plain2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function snapshotData(value, label, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (!value || typeof value !== "object" || seen.has(value)) invalid(`${label} is not a finite acyclic JSON value`);
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const length = descriptors.length;
      if (!length || !("value" in length) || length.enumerable || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0 || keys.some((key) => typeof key !== "string" || key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value))) {
        invalid(`${label} contains an accessor, proxy field, or sparse array`);
      }
      const output2 = [];
      for (let index = 0; index < length.value; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(`${label} contains an accessor or sparse array`);
        output2.push(snapshotData(descriptor.value, `${label}[${index}]`, seen));
      }
      return output2;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${label} is not a plain object`);
    const output = /* @__PURE__ */ Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") invalid(`${label} contains a symbol key`);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(`${label} contains an accessor or proxy field`);
      output[key] = snapshotData(descriptor.value, `${label}.${key}`, seen);
    }
    return output;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PROOF_CATALOG_INVALID:")) throw error;
    invalid(`${label} cannot be snapshotted: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    seen.delete(value);
  }
}
function exact2(value, keys) {
  return plain2(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key) && (() => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  })());
}
function fingerprint(value) {
  return typeof value === "string" && DIGEST.test(value);
}
function domainDigestBytes(domain, encoded) {
  const bytes = Buffer.from(encoded, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash5("sha256").update(domain).update(Buffer.from([0])).update(length).update(bytes).digest("hex")}`;
}
function domainDigest(domain, value) {
  return domainDigestBytes(domain, goCompatibleProofJson(value));
}
function plainDigest(value) {
  return `sha256:${createHash5("sha256").update(goCompatibleProofJson(value), "utf8").digest("hex")}`;
}
function bounded(value, label, limit = PROOF_REVALIDATION_OUTPUT_MAX_BYTES, wireMode = "generic") {
  let encoded;
  try {
    encoded = governedCanonicalJson(value, wireMode);
  } catch {
    invalid(`${label} is not canonical JSON`);
  }
  if (Buffer.byteLength(encoded, "utf8") > limit) invalid(`${label} exceeds ${limit} bytes`);
  return immutableGovernedValue(value, wireMode);
}
function claimPayloadLimit(claimName) {
  if (claimName === PROOF_STRUCTURAL_INVENTORY_CLAIM) return PROOF_INVENTORY_OUTPUT_MAX_BYTES;
  if (claimName === PROOF_CATALOG_REVALIDATION_CLAIM) return PROOF_REVALIDATION_OUTPUT_MAX_BYTES;
  if (claimName === PROOF_CANDIDATE_CLAIM) return PROOF_CATALOG_INPUT_MAX_BYTES;
  return PROOF_INVENTORY_OUTPUT_MAX_BYTES;
}
function sortedStrings(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || !allowEmpty && value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    invalid(`${label} is invalid`);
  }
  const sorted = proofSorted(value);
  if (new Set(value).size !== value.length || proofCanonicalJson(value) !== proofCanonicalJson(sorted)) {
    invalid(`${label} must be unique and sorted`);
  }
  return value;
}
function claim(value, expectedClaim, label) {
  const candidateAuthority = expectedClaim === PROOF_CANDIDATE_CLAIM ? validateGovernedProofCandidateClaim(value, label) : void 0;
  const source = candidateAuthority?.snapshot ?? value;
  if (!plain2(source) || source.claim !== expectedClaim || typeof source.claimId !== "string" || !/^[0-9a-f]{64}$/.test(source.claimId) || typeof source.payloadFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(source.payloadFingerprint) || typeof source.producerCheckId !== "string" || !Array.isArray(source.scope) || !Array.isArray(source.parentClaimIds) || source.parentClaimIds.some((item) => typeof item !== "string" || !/^[0-9a-f]{64}$/.test(item))) {
    invalid(`${label} claim identity is invalid`);
  }
  if (expectedClaim !== PROOF_CANDIDATE_CLAIM && source.proofAdmission !== void 0) {
    invalid(`${label} proof admission evidence is reserved for governed candidates`);
  }
  const wireMode = candidateAuthority ? candidateAuthority.wireMode : source.wireMode === void 0 ? "generic" : source.wireMode;
  if (wireMode !== "generic" && wireMode !== "proof") invalid(`${label} wire mode is invalid`);
  const payload = immutableGovernedValue(source.payload, wireMode);
  const payloadFingerprint = governedPayloadFingerprint(source.payload, wireMode);
  const nonCanonical = wireMode === "generic" ? canonicalJson(source.payload) !== JSON.stringify(source.payload) : false;
  if (bounded(source.payload, `${label} payload`, claimPayloadLimit(expectedClaim), wireMode) && (nonCanonical || payloadFingerprint !== source.payloadFingerprint)) {
    invalid(`${label} payload is detached or noncanonical`);
  }
  if (canonicalJson(source.scope) !== JSON.stringify(source.scope) || canonicalJson(source.parentClaimIds) !== canonicalJson([...source.parentClaimIds].sort())) {
    invalid(`${label} scope or parents are noncanonical`);
  }
  const base = {
    claimId: source.claimId,
    claim: source.claim,
    payload,
    payloadFingerprint: source.payloadFingerprint,
    producerCheckId: source.producerCheckId,
    scope: immutableCanonicalValue(source.scope),
    parentClaimIds: immutableCanonicalValue(source.parentClaimIds),
    wireMode,
    ...candidateAuthority ? { proofAdmission: candidateAuthority.evidence } : {}
  };
  const project = (candidate) => {
    const projected = immutableCanonicalValue(candidate);
    return wireMode === "proof" ? Object.freeze({ ...projected, payload: immutableGovernedValue(source.payload, wireMode) }) : projected;
  };
  if (source.provenance === "controller" && typeof source.catalogClaimId === "string" && Number.isSafeInteger(source.incarnation)) {
    return project({ ...base, provenance: "controller", catalogClaimId: source.catalogClaimId, incarnation: source.incarnation });
  }
  if ((source.provenance === void 0 || source.provenance === "attempt") && typeof source.attemptId === "string" && Number.isSafeInteger(source.fence)) {
    return project({ ...base, provenance: "attempt", attemptId: source.attemptId, fence: source.fence });
  }
  invalid(`${label} provenance is invalid`);
}
function validateCandidateCore(value, label) {
  const candidate = snapshotData(value, label);
  if (!plain2(candidate) || candidate.proofAdmission === void 0) {
    invalid(`${label} proof admission evidence is missing`);
  }
  let evidence;
  try {
    evidence = validateProofCandidateEvidence(candidate.proofAdmission);
  } catch (error) {
    invalid(`${label} proof admission evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const derivedMode = governedWireModeFromEvidence(evidence);
  if (candidate.wireMode !== void 0 && candidate.wireMode !== derivedMode) {
    invalid(`${label} wire mode is detached from governed invocation`);
  }
  if (candidate.claim !== PROOF_CANDIDATE_CLAIM || candidate.provenance !== "attempt" || typeof candidate.claimId !== "string" || typeof candidate.producerCheckId !== "string" || !Array.isArray(candidate.parentClaimIds) || candidate.parentClaimIds.some((parent) => typeof parent !== "string") || typeof candidate.attemptId !== "string" || !Number.isSafeInteger(candidate.fence)) {
    invalid(`${label} generated claim provenance is invalid`);
  }
  if (typeof candidate.payloadFingerprint !== "string" || candidate.payloadFingerprint !== governedPayloadFingerprint(candidate.payload, derivedMode)) {
    invalid(`${label} payload fingerprint is detached from its governed payload`);
  }
  let expectedClaimId;
  try {
    expectedClaimId = sha256Canonical({
      claim: candidate.claim,
      payloadFingerprint: candidate.payloadFingerprint,
      producerCheckId: candidate.producerCheckId,
      scope: candidate.scope,
      attemptId: candidate.attemptId,
      fence: candidate.fence,
      parentClaimIds: [...candidate.parentClaimIds].sort(),
      proofCandidateEvidenceFingerprint: proofCandidateEvidenceFingerprint(evidence)
    });
  } catch (error) {
    invalid(`${label} generated claim identity is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (candidate.claimId !== expectedClaimId) {
    invalid(`${label} generated claim identity is detached from its evidence`);
  }
  try {
    const payloadWire = governedCanonicalJson(candidate.payload, derivedMode);
    const identity = evidence.probe.resultIdentity;
    if (identity.resultDigest !== governedResultDigest(candidate.payload, derivedMode) || identity.canonicalBytes !== Buffer.byteLength(payloadWire, "utf8")) {
      invalid(`${label} result identity is detached from candidate payload`);
    }
  } catch (error) {
    invalid(`${label} payload is not valid governed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const snapshot = Object.freeze({ ...candidate, proofAdmission: evidence });
  return { evidence, wireMode: derivedMode, snapshot };
}
function validateGovernedProofCandidateClaim(value, label = "candidate") {
  const result = validateCandidateCore(value, label);
  const invocation = result.evidence.role.invocation;
  if (result.wireMode !== "proof" || !exact2(invocation, ["role_id", "stance", "subject", "output_schema_id", "output_schema"]) || invocation.role_id !== "onboard" || invocation.stance !== "owner" || !plain2(invocation.subject) || !exact2(invocation.subject, ["kind", "id", "fingerprint"]) || invocation.subject.kind !== "project" || invocation.output_schema_id !== "proof.component-catalog-candidate@1") {
    invalid(`${label} invocation is not the governed catalog schema`);
  }
  return { ...result, wireMode: "proof" };
}
function validateProofComponentCandidateClaim(value, label = "component candidate") {
  const result = validateCandidateCore(value, label);
  const invocation = result.evidence.role.invocation;
  if (result.wireMode !== "generic" || !exact2(invocation, ["role_id", "stance", "subject", "component_authority", "output_schema_id", "output_schema"]) || invocation.role_id !== "onboard" || invocation.stance !== "owner" || !plain2(invocation.subject) || !exact2(invocation.subject, ["kind", "id", "fingerprint"]) || invocation.subject.kind !== "component" || invocation.output_schema_id !== "reqproof.component-onboarding/v1" || !("component_authority" in invocation)) {
    invalid(`${label} invocation is not the governed component schema`);
  }
  try {
    validateProofComponentInvocationAuthority(invocation.component_authority);
  } catch (error) {
    invalid(`${label} component authority is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...result, wireMode: "generic" };
}
function onlyClaims(value, aliases) {
  if (!exact2(value, aliases)) invalid(`expected claim aliases ${aliases.join(", ")}`);
  return value;
}
function sameScope(values) {
  return values.every((value) => canonicalJson(value.scope) === canonicalJson(values[0].scope));
}
function admissionScope(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every((part) => plain2(part) && exact2(part, ["Kind", "ExpansionOwnerCheck", "Key", "SubgraphInstanceID"]) && part.Kind === "keyed" && typeof part.ExpansionOwnerCheck === "string" && part.ExpansionOwnerCheck.length > 0 && typeof part.Key === "string" && part.Key.length > 0 && typeof part.SubgraphInstanceID === "string" && /^[0-9a-f]{64}$/.test(part.SubgraphInstanceID));
}
function admissionBinding(value) {
  return plain2(value) && exact2(value, ["ManagedRunID", "SessionID", "CheckID", "Scope", "NodeInstanceID", "NodeGenerationID", "AttemptID", "Fence"]) && typeof value.ManagedRunID === "string" && value.ManagedRunID.length > 0 && typeof value.SessionID === "string" && value.SessionID.length > 0 && typeof value.CheckID === "string" && value.CheckID.length > 0 && admissionScope(value.Scope) && typeof value.NodeInstanceID === "string" && value.NodeInstanceID.length > 0 && typeof value.NodeGenerationID === "string" && value.NodeGenerationID.length > 0 && typeof value.AttemptID === "string" && value.AttemptID.length > 0 && Number.isSafeInteger(value.Fence) && value.Fence > 0;
}
function admissionLineage(value) {
  if (value === null) return true;
  return plain2(value) && exact2(value, ["version", "fingerprint", "object_format", "baseline_revision"]) && value.version === "proof.git-project-lineage-binding/v1" && fingerprint(value.fingerprint) && (value.object_format === "sha1" || value.object_format === "sha256") && typeof value.baseline_revision === "string" && (value.object_format === "sha1" ? /^sha1:[0-9a-f]{40}$/.test(value.baseline_revision) : /^sha256:[0-9a-f]{64}$/.test(value.baseline_revision));
}
function proofScope2(value) {
  return value.map((segment) => ({
    Kind: segment.Kind,
    ExpansionOwnerCheck: segment.ExpansionOwnerCheck,
    Key: segment.Key,
    SubgraphInstanceID: segment.SubgraphInstanceID
  }));
}
function proofBinding2(value) {
  const binding = value;
  return {
    ManagedRunID: binding.ManagedRunID,
    SessionID: binding.SessionID,
    CheckID: binding.CheckID,
    Scope: proofScope2(binding.Scope),
    NodeInstanceID: binding.NodeInstanceID,
    NodeGenerationID: binding.NodeGenerationID,
    AttemptID: binding.AttemptID,
    Fence: binding.Fence
  };
}
function proofTermination2(value) {
  const termination = value;
  return {
    Version: termination.Version,
    Type: termination.Type,
    SessionID: termination.SessionID,
    Scope: proofScope2(termination.Scope),
    Binding: proofBinding2(termination.Binding),
    CleanupStatus: termination.CleanupStatus,
    ControllerDecision: termination.ControllerDecision,
    FailureCode: termination.FailureCode
  };
}
function admissionReceiptID(receipt) {
  const subject = receipt.Subject;
  const unsigned = proofTopLevelJson({
    Version: goCompatibleProofJson(receipt.Version),
    Status: goCompatibleProofJson(receipt.Status),
    CandidateID: goCompatibleProofJson(receipt.CandidateID),
    ProbeResultDigest: goCompatibleProofJson(receipt.ProbeResultDigest),
    ProbeCanonicalBytes: goCompatibleProofJson(receipt.ProbeCanonicalBytes),
    ClaimID: goCompatibleProofJson(receipt.ClaimID),
    Claim: goCompatibleProofJson(receipt.Claim),
    PayloadFingerprint: goCompatibleProofJson(receipt.PayloadFingerprint),
    InvocationDigest: goCompatibleProofJson(receipt.InvocationDigest),
    RoleID: goCompatibleProofJson(receipt.RoleID),
    Stance: goCompatibleProofJson(receipt.Stance),
    Subject: goCompatibleProofJson({ kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint }),
    ProducerCheckID: goCompatibleProofJson(receipt.ProducerCheckID),
    ParentClaimIDs: goCompatibleProofJson(receipt.ParentClaimIDs),
    Binding: goCompatibleProofJson(proofBinding2(receipt.Binding)),
    Termination: goCompatibleProofJson(proofTermination2(receipt.Termination)),
    ProjectLineage: goCompatibleProofJson(receipt.ProjectLineage === null ? null : (() => {
      const lineage = receipt.ProjectLineage;
      return {
        version: lineage.version,
        fingerprint: lineage.fingerprint,
        object_format: lineage.object_format,
        baseline_revision: lineage.baseline_revision
      };
    })())
  });
  return domainDigestBytes("proof.role-result-candidate-receipt/id/v2", unsigned);
}
function admissionTransport(value) {
  if (!plain2(value) || typeof value[PROOF_ADMISSION_WIRE_FIELD] !== "string") {
    invalid("admission does not carry the complete Proof decision wire");
  }
  const wire2 = value[PROOF_ADMISSION_WIRE_FIELD];
  let decision;
  try {
    decision = JSON.parse(wire2);
  } catch {
    invalid("admission decision wire is not JSON");
  }
  const receipt = plain2(decision) && plain2(decision.receipt) ? decision.receipt : void 0;
  if (!exact2(decision, ADMISSION_DECISION_KEYS) || decision.version !== "proof.role-result-candidate-cli-decision/v1" || decision.status !== "ADMITTED" || decision.reject_code !== null || !receipt || proofCanonicalJson(decision) !== wire2 || !exact2(receipt, ADMISSION_RECEIPT_KEYS) || receipt.Version !== "proof.role-result-candidate-admission/v2" || receipt.Status !== "ADMITTED" || !fingerprint(receipt.CandidateID) || !fingerprint(receipt.ProbeResultDigest) || !Number.isSafeInteger(receipt.ProbeCanonicalBytes) || receipt.ProbeCanonicalBytes <= 0 || typeof receipt.ClaimID !== "string" || !/^[0-9a-f]{64}$/.test(receipt.ClaimID) || receipt.Claim !== PROOF_CANDIDATE_CLAIM || typeof receipt.PayloadFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(receipt.PayloadFingerprint) || !fingerprint(receipt.InvocationDigest) || receipt.RoleID !== "onboard" || receipt.Stance !== "owner" || !plain2(receipt.Subject) || !exact2(receipt.Subject, ["kind", "id", "fingerprint"]) || receipt.Subject.kind !== "project" || typeof receipt.Subject.id !== "string" || receipt.Subject.id.length === 0 || !fingerprint(receipt.Subject.fingerprint) || receipt.ProducerCheckID !== "inspect" || !Array.isArray(receipt.ParentClaimIDs) || receipt.ParentClaimIDs.some((parent) => typeof parent !== "string" || !/^[0-9a-f]{64}$/.test(parent)) || !admissionBinding(receipt.Binding) || !plain2(receipt.Termination) || !exact2(receipt.Termination, ["Version", "Type", "SessionID", "Scope", "Binding", "CleanupStatus", "ControllerDecision", "FailureCode"]) || receipt.Termination.Version !== 1 || receipt.Termination.Type !== "ManagedRunTerminated" || receipt.Termination.SessionID !== receipt.Binding.SessionID || !admissionScope(receipt.Termination.Scope) || !admissionBinding(receipt.Termination.Binding) || canonicalJson(receipt.Termination.Binding) !== canonicalJson(receipt.Binding) || receipt.Termination.CleanupStatus !== "clean" || receipt.Termination.ControllerDecision !== "completed" || receipt.Termination.FailureCode !== null || !fingerprint(receipt.receipt_id) || !admissionLineage(receipt.ProjectLineage) || receipt.receipt_id !== admissionReceiptID(receipt) || proofCanonicalJson(receipt) !== proofCanonicalJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== PROOF_ADMISSION_WIRE_FIELD)))) {
    invalid("admission decision wire is incomplete or detached");
  }
  return { receipt, wire: wire2 };
}
function componentAdmissionTransport(value) {
  if (!plain2(value) || typeof value[PROOF_ADMISSION_WIRE_FIELD] !== "string") {
    invalid("component admission does not carry the complete Proof decision wire");
  }
  const wire2 = value[PROOF_ADMISSION_WIRE_FIELD];
  let decision;
  try {
    decision = JSON.parse(wire2);
  } catch {
    invalid("component admission decision wire is not JSON");
  }
  const receipt = plain2(decision) && plain2(decision.receipt) ? decision.receipt : void 0;
  if (!exact2(decision, ADMISSION_DECISION_KEYS) || decision.version !== "proof.role-result-candidate-cli-decision/v1" || decision.status !== "ADMITTED" || decision.reject_code !== null || !receipt || proofCanonicalJson(decision) !== wire2 && proofV1DecisionJson(decision) !== wire2 || !exact2(receipt, ADMISSION_RECEIPT_COMMON_KEYS) || receipt.Version !== "proof.role-result-candidate-admission/v1" || receipt.Status !== "ADMITTED" || !fingerprint(receipt.CandidateID) || !fingerprint(receipt.ProbeResultDigest) || !Number.isSafeInteger(receipt.ProbeCanonicalBytes) || receipt.ProbeCanonicalBytes <= 0 || typeof receipt.ClaimID !== "string" || !/^[0-9a-f]{64}$/.test(receipt.ClaimID) || receipt.Claim !== PROOF_CANDIDATE_CLAIM || typeof receipt.PayloadFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(receipt.PayloadFingerprint) || !fingerprint(receipt.InvocationDigest) || receipt.RoleID !== "onboard" || receipt.Stance !== "owner" || !plain2(receipt.Subject) || !exact2(receipt.Subject, ["kind", "id", "fingerprint"]) || receipt.Subject.kind !== "component" || typeof receipt.Subject.id !== "string" || receipt.Subject.id.length === 0 || !fingerprint(receipt.Subject.fingerprint) || receipt.ProducerCheckID !== "inspect" || !Array.isArray(receipt.ParentClaimIDs) || receipt.ParentClaimIDs.some((parent) => typeof parent !== "string" || !/^[0-9a-f]{64}$/.test(parent)) || !admissionBinding(receipt.Binding) || !plain2(receipt.Termination) || !exact2(receipt.Termination, ["Version", "Type", "SessionID", "Scope", "Binding", "CleanupStatus", "ControllerDecision", "FailureCode"]) || receipt.Termination.Version !== 1 || receipt.Termination.Type !== "ManagedRunTerminated" || receipt.Termination.SessionID !== receipt.Binding.SessionID || !admissionScope(receipt.Termination.Scope) || !admissionBinding(receipt.Termination.Binding) || canonicalJson(receipt.Termination.Binding) !== canonicalJson(receipt.Binding) || receipt.Termination.CleanupStatus !== "clean" || receipt.Termination.ControllerDecision !== "completed" || receipt.Termination.FailureCode !== null || !fingerprint(receipt.receipt_id) || receipt.receipt_id !== proofV1AdmissionReceiptID(receipt) || proofCanonicalJson(receipt) !== proofCanonicalJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== PROOF_ADMISSION_WIRE_FIELD)))) {
    invalid("component admission decision wire is incomplete or detached");
  }
  return { receipt, wire: wire2 };
}
function validateProofComponentCandidateAdmissionBinding(candidate, admission) {
  const authority = validateProofComponentCandidateClaim(candidate, "component candidate");
  const candidateSnapshot = authority.snapshot;
  if (admission.claim !== PROOF_ADMITTED_RECEIPT_CLAIM || admission.producerCheckId !== "proof_admit" || admission.parentClaimIds.length !== 1 || admission.parentClaimIds[0] !== candidateSnapshot.claimId || canonicalJson(admission.scope) !== canonicalJson(candidateSnapshot.scope)) {
    invalid("component admission lineage is detached from the candidate");
  }
  const admitted = componentAdmissionTransport(admission.payload);
  const receipt = admitted.receipt;
  const invocation = authority.evidence.role.invocation;
  if (receipt.ClaimID !== candidateSnapshot.claimId || receipt.Claim !== candidateSnapshot.claim || receipt.PayloadFingerprint !== candidateSnapshot.payloadFingerprint || receipt.ProducerCheckID !== candidateSnapshot.producerCheckId || canonicalJson(receipt.ParentClaimIDs) !== canonicalJson(candidateSnapshot.parentClaimIds) || receipt.InvocationDigest !== authority.evidence.role.invocationDigest || receipt.RoleID !== invocation.role_id || receipt.Stance !== invocation.stance || canonicalJson(receipt.Subject) !== canonicalJson(invocation.subject) || receipt.ProbeResultDigest !== authority.evidence.probe.resultIdentity.resultDigest || receipt.ProbeCanonicalBytes !== authority.evidence.probe.resultIdentity.canonicalBytes) {
    invalid("component admission receipt is detached from the candidate invocation or result");
  }
  return { ...admitted, candidate: candidateSnapshot };
}
function validateProofCandidateAdmissionBinding(candidate, admission) {
  const authority = validateGovernedProofCandidateClaim(candidate, "candidate");
  const candidateSnapshot = authority.snapshot;
  if (admission.claim !== PROOF_ADMITTED_RECEIPT_CLAIM || admission.producerCheckId !== "proof_admit" || admission.parentClaimIds.length !== 1 || admission.parentClaimIds[0] !== candidateSnapshot.claimId || canonicalJson(admission.scope) !== canonicalJson(candidateSnapshot.scope)) {
    invalid("admission lineage is detached from the governed candidate");
  }
  const admitted = admissionTransport(admission.payload);
  const receipt = admitted.receipt;
  const invocation = authority.evidence.role.invocation;
  if (receipt.ClaimID !== candidateSnapshot.claimId || receipt.Claim !== candidateSnapshot.claim || receipt.PayloadFingerprint !== candidateSnapshot.payloadFingerprint || receipt.ProducerCheckID !== candidateSnapshot.producerCheckId || canonicalJson(receipt.ParentClaimIDs) !== canonicalJson(candidateSnapshot.parentClaimIds) || receipt.InvocationDigest !== authority.evidence.role.invocationDigest || receipt.RoleID !== invocation.role_id || receipt.Stance !== invocation.stance || canonicalJson(receipt.Subject) !== canonicalJson(invocation.subject) || receipt.ProbeResultDigest !== authority.evidence.probe.resultIdentity.resultDigest || receipt.ProbeCanonicalBytes !== authority.evidence.probe.resultIdentity.canonicalBytes) {
    invalid("admission receipt is detached from the governed candidate invocation or result");
  }
  return { ...admitted, candidate: candidateSnapshot };
}
function validateAuthority(value, projectID, label) {
  const keys = ["version", "project_id", "subject_fingerprint", "code_fingerprint", "tests_fingerprint"];
  if (!exact2(value, keys) || value.version !== "proof.project-authority/v1" || value.project_id !== projectID || !fingerprint(value.subject_fingerprint) || !fingerprint(value.code_fingerprint) || !fingerprint(value.tests_fingerprint)) {
    invalid(`${label} is not a current Proof project authority`);
  }
  return value;
}
function validateInputState(value, label, expectedOwnerKind, expectedOwnerID) {
  if (!Array.isArray(value)) invalid(`${label} is invalid`);
  let previous = "";
  const paths = /* @__PURE__ */ new Set();
  for (const [index, item] of value.entries()) {
    if (!plain2(item) || !exact2(item, ["owner_kind", "owner_id", "input_kind", "path", "file_hash"]) || typeof item.owner_kind !== "string" || item.owner_kind.length === 0 || typeof item.owner_id !== "string" || item.owner_id.length === 0 || typeof item.input_kind !== "string" || item.input_kind.length === 0 || typeof item.path !== "string" || item.path.length === 0 || !fingerprint(item.file_hash) || expectedOwnerKind !== void 0 && item.owner_kind !== expectedOwnerKind || expectedOwnerID !== void 0 && item.owner_id !== expectedOwnerID || paths.has(item.path)) invalid(`${label}[${index}] is invalid`);
    if (normalizeProofPath(item.path) !== item.path) invalid(`${label}[${index}].path is not a canonical project-relative path`);
    const order = `${item.input_kind}\0${item.path}`;
    if (compareProofStrings(order, previous) < 0) invalid(`${label} must be sorted by input kind and path`);
    previous = order;
    paths.add(item.path);
  }
}
function validateStructuralInventory(value, projectID) {
  const keys = ["version", "authority", "sorted_paths", "sorted_module_paths", "boundary_fingerprint", "input_state"];
  if (!exact2(value, keys) || value.version !== STRUCTURAL_INVENTORY_VERSION || !fingerprint(value.boundary_fingerprint)) {
    invalid("structural inventory is not a closed Proof projection");
  }
  validateAuthority(value.authority, projectID, "structural inventory authority");
  sortedStrings(value.sorted_paths, "structural inventory sorted_paths", true);
  proofPathList(value.sorted_paths, "structural inventory sorted_paths", true);
  if (value.sorted_module_paths !== null) {
    sortedStrings(value.sorted_module_paths, "structural inventory sorted_module_paths", true);
    proofPathList(value.sorted_module_paths, "structural inventory sorted_module_paths", true);
  }
  validateInputState(value.input_state, "structural inventory input_state", "onboarding_structural_inventory", projectID);
  const inventoryPaths = value.sorted_paths;
  const inputPaths = proofSorted(value.input_state.map((row) => row.path));
  if (!sameStringSet(inventoryPaths, inputPaths)) invalid("structural inventory input_state does not cover sorted_paths");
  return bounded(value, "structural inventory", PROOF_INVENTORY_OUTPUT_MAX_BYTES, "proof");
}
function candidateComponents(value, projectID) {
  if (!plain2(value)) invalid("discovery candidate is not an object");
  const keys = ["version", "project_id", "components"];
  if (!exact2(value, keys) || value.version !== COMPONENT_CATALOG_CANDIDATE_VERSION || projectID !== void 0 && value.project_id !== projectID || !Array.isArray(value.components) || value.components.length === 0) invalid("discovery candidate is not the closed Proof catalog schema");
  const ids = /* @__PURE__ */ new Set();
  return value.components.map((component, index) => {
    const componentKeys = ["id", "responsibility", "owned_paths", "dependency_closure", "entry_points", "state_effects", "interfaces", "uncertainty"];
    if (!plain2(component) || !Reflect.ownKeys(component).every((key) => typeof key === "string" && componentKeys.includes(key)) || !("id" in component) || !("responsibility" in component) || !("owned_paths" in component) || typeof component.responsibility !== "string" || component.responsibility.length === 0) {
      invalid(`discovery component ${index} is not closed or is duplicated`);
    }
    const id = normalizedIdentifier(component.id, `discovery component ${index}.id`);
    if (ids.has(id)) invalid(`discovery component ${index} is duplicated`);
    ids.add(id);
    proofPathList(component.owned_paths, `discovery component ${component.id}.owned_paths`);
    if (component.dependency_closure !== void 0) proofPathList(component.dependency_closure, `discovery component ${component.id}.dependency_closure`);
    if (component.entry_points !== void 0) stringList(component.entry_points, `discovery component ${component.id}.entry_points`, true);
    if (component.state_effects !== void 0) stringList(component.state_effects, `discovery component ${component.id}.state_effects`, true);
    if (component.interfaces !== void 0 && (!Array.isArray(component.interfaces) || !component.interfaces.every((item) => validMaterialized(item)))) invalid(`discovery component ${component.id}.interfaces is invalid`);
    if (component.uncertainty !== void 0) stringList(component.uncertainty, `discovery component ${component.id}.uncertainty`, true);
    return component;
  });
}
function stringList(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || !allowEmpty && value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    invalid(`${label} is invalid`);
  }
  return value;
}
function proofPathList(value, label, allowEmpty = false) {
  stringList(value, label, allowEmpty);
  const seen = /* @__PURE__ */ new Set();
  for (const path of value) {
    const normalized = normalizeProofPath(path);
    if (normalized === void 0 || normalized !== trimProofSpace(path) || seen.has(normalized)) {
      invalid(`${label} contains a noncanonical or duplicate project-relative path`);
    }
    seen.add(normalized);
  }
  return value;
}
function normalizeProofPath(value) {
  const trimmed = trimProofSpace(value);
  if (trimmed.length === 0 || trimmed.includes("\0") || trimmed.startsWith("/")) return void 0;
  const parts = [];
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return void 0;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? void 0 : parts.join("/");
}
function trimProofSpace(value) {
  const chars = [...value];
  let start = 0;
  let end = chars.length;
  while (start < end && isProofSpace(chars[start])) start++;
  while (end > start && isProofSpace(chars[end - 1])) end--;
  return chars.slice(start, end).join("");
}
function isProofSpace(value) {
  const code = value.codePointAt(0);
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 || code === 133 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288;
}
function normalizedPathList(value, label) {
  proofPathList(value, label);
  return value.map((path) => normalizeProofPath(path));
}
function normalizedIdentifier(value, label) {
  if (typeof value !== "string") invalid(`${label} is invalid`);
  const normalized = trimProofSpace(value);
  if (!visibleIdentifier(normalized)) invalid(`${label} is not a visible identifier`);
  return normalized;
}
function visibleIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && [...value].every((char) => {
    const code = char.codePointAt(0);
    return code >= 33 && code <= 126;
  });
}
function sameStringSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function projectedCatalog(value, projectID) {
  if (!plain2(value) || !exact2(value, ["version", "project_id", "components"]) || value.version !== COMPONENT_CATALOG_CANDIDATE_VERSION || value.project_id !== projectID || !Array.isArray(value.components) || value.components.length === 0) {
    invalid("catalog revalidation catalog is invalid");
  }
  const ids = /* @__PURE__ */ new Set();
  for (const [index, component] of value.components.entries()) {
    if (!plain2(component)) invalid(`catalog component ${index} is not an object`);
    const allowed = ["id", "responsibility", "owned_paths", "dependency_closure", "entry_points", "state_effects", "interfaces", "uncertainty"];
    if (!Reflect.ownKeys(component).every((key) => typeof key === "string" && allowed.includes(key))) invalid(`catalog component ${index} contains an unknown field`);
    if (!("id" in component) || !("responsibility" in component) || !("owned_paths" in component) || !visibleIdentifier(component.id) || typeof component.responsibility !== "string" || component.responsibility.length === 0 || ids.has(component.id)) invalid(`catalog component ${index} is invalid or duplicated`);
    ids.add(component.id);
    sortedStrings(component.owned_paths, `catalog component ${component.id}.owned_paths`);
    proofPathList(component.owned_paths, `catalog component ${component.id}.owned_paths`);
    if (component.dependency_closure !== void 0) {
      sortedStrings(component.dependency_closure, `catalog component ${component.id}.dependency_closure`);
      proofPathList(component.dependency_closure, `catalog component ${component.id}.dependency_closure`);
    }
    for (const field of ["entry_points", "state_effects", "uncertainty"]) {
      if (component[field] !== void 0) stringList(component[field], `catalog component ${component.id}.${field}`, true);
    }
    if (component.interfaces !== void 0 && (!Array.isArray(component.interfaces) || !component.interfaces.every((item) => validMaterialized(item)))) {
      invalid(`catalog component ${component.id}.interfaces is invalid`);
    }
  }
  return value;
}
function expectedCatalog(candidate, projectID) {
  const components = candidateComponents(candidate.payload, projectID).map((component) => {
    const result = {
      id: normalizedIdentifier(component.id, `discovery component ${String(component.id)}.id`),
      responsibility: component.responsibility,
      owned_paths: proofSorted(normalizedPathList(component.owned_paths, `discovery component ${String(component.id)}.owned_paths`))
    };
    if (component.dependency_closure !== void 0) result.dependency_closure = proofSorted(normalizedPathList(component.dependency_closure, `discovery component ${String(component.id)}.dependency_closure`));
    for (const field of ["entry_points", "state_effects", "interfaces", "uncertainty"]) {
      const list = component[field];
      if (list !== void 0 && list.length > 0) result[field] = field === "interfaces" ? list : proofSorted(list);
    }
    return result;
  }).sort((left, right) => compareProofStrings(left.id, right.id));
  return { version: COMPONENT_CATALOG_CANDIDATE_VERSION, project_id: projectID, components };
}
function validMaterialized(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !/[\u0000-\u001f\u007f]/.test(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    return Array.isArray(value) ? value.every((item) => validMaterialized(item, seen)) : plain2(value) && Object.values(value).every((item) => validMaterialized(item, seen));
  } finally {
    seen.delete(value);
  }
}
function validateWorkItem(value, projectID, label) {
  const keys = ["version", "project_id", "component_id", "sorted_owned_paths", "sorted_dependency_closure", "proof_path_mapping", "proof_input_state", "proof_component_subject"];
  if (!exact2(value, keys) || value.version !== "reqproof.onboarding-component-work-item/v1" || value.project_id !== projectID || typeof value.component_id !== "string" || value.component_id.length === 0 || !plain2(value.proof_path_mapping) || !validMaterialized(value.proof_path_mapping) || !plain2(value.proof_component_subject) || !validMaterialized(value.proof_component_subject)) invalid(`${label} is not a closed Proof WorkItem`);
  sortedStrings(value.sorted_owned_paths, `${label}.sorted_owned_paths`);
  sortedStrings(value.sorted_dependency_closure, `${label}.sorted_dependency_closure`);
  validateInputState(value.proof_input_state, `${label}.proof_input_state`, "onboarding_component", value.component_id);
  const closure = value.sorted_dependency_closure;
  const inputPaths = proofSorted(value.proof_input_state.map((row) => row.path));
  if (!sameStringSet(closure, inputPaths)) invalid(`${label}.proof_input_state does not cover sorted_dependency_closure`);
  const subject = value.proof_component_subject;
  if (!exact2(subject, ["version", "project_id", "component_id", "sorted_owned_paths", "sorted_dependency_closure", "fingerprint"]) || subject.version !== "proof.component-subject/v1" || subject.project_id !== projectID || subject.component_id !== value.component_id || !fingerprint(subject.fingerprint) || canonicalJson(subject.sorted_owned_paths) !== canonicalJson(value.sorted_owned_paths) || canonicalJson(subject.sorted_dependency_closure) !== canonicalJson(value.sorted_dependency_closure)) invalid(`${label}.proof_component_subject is detached`);
  const mapping = value.proof_path_mapping;
  if (!exact2(mapping, ["paths", "components", "owner", "risk_tier", "enforcement"]) || !Array.isArray(mapping.paths) || !Array.isArray(mapping.components) || mapping.components.length !== 1 || mapping.components[0] !== value.component_id || mapping.owner !== "onboard" || mapping.risk_tier !== 0 || mapping.enforcement !== "soft" || canonicalJson(mapping.paths) !== canonicalJson(value.sorted_owned_paths) || mapping.paths.some((path) => typeof path !== "string" || path.length === 0)) invalid(`${label}.proof_path_mapping is detached`);
  return value;
}
function validateProofWorkItemsProjection(value, revalidation, inventory, candidate, admission, projectID) {
  const keys = ["version", "authority", "catalog", "work_items"];
  if (!exact2(value, keys) || value.version !== "proof.onboarding-work-item-projection/v1") invalid("work-items projection is not closed");
  const authority = validateAuthority(value.authority, projectID, "work-items authority");
  const expectedAuthority = inventory.authority;
  if (!plain2(expectedAuthority) || canonicalJson(authority) !== canonicalJson(expectedAuthority)) invalid("work-items authority is detached from current inventory");
  const expected = expectedCatalog(candidate, projectID);
  const catalog = projectedCatalog(value.catalog, projectID);
  if (proofCanonicalJson(catalog) !== proofCanonicalJson(expected)) invalid("work-items catalog is detached from candidate");
  if (!Array.isArray(value.work_items) || value.work_items.length !== expected.components.length) invalid("work-items projection is incomplete");
  const items = value.work_items.map((item, index) => validateWorkItem(item, projectID, `work-items[${index}]`));
  const sortedItems = [...items].sort((left, right) => compareProofStrings(left.component_id, right.component_id));
  if (canonicalJson(items) !== canonicalJson(sortedItems)) invalid("work-items projection is not sorted by component_id");
  const catalogByID = new Map(catalog.components.map((component) => [component.id, component]));
  const inventoryInput = new Map((inventory.input_state || []).map((row) => [row.path, row]));
  for (const item of items) {
    const component = catalogByID.get(item.component_id);
    if (!component || !sameStringSet(item.sorted_owned_paths, component.owned_paths) || !sameStringSet(item.sorted_dependency_closure, component.dependency_closure === void 0 ? item.sorted_owned_paths : component.dependency_closure)) invalid(`work-items ${item.component_id} is detached from catalog`);
    for (const row of item.proof_input_state) {
      const current = inventoryInput.get(row.path);
      if (!current || current.input_kind !== row.input_kind || current.file_hash !== row.file_hash) invalid(`work-items ${item.component_id} input state is stale`);
    }
  }
  const revalidationProjection = validateProofCatalogRevalidationProjection(revalidation, inventory, candidate, admission, projectID);
  const receipt = revalidationProjection.receipt;
  const authorities = receipt.component_authorities;
  for (const item of items) {
    const authorityRow = authorities.find((row) => row.component_id === item.component_id);
    if (!authorityRow || authorityRow.work_item_digest !== plainDigest(workItemWire(item)) || canonicalJson(authorityRow.subject) !== canonicalJson(item.proof_component_subject)) invalid(`work-items ${item.component_id} is not authorized by revalidation receipt`);
  }
  return bounded(value, "work-items projection", PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES, "proof");
}
function decodeExactProofJsonBytes(value, label, limit) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    invalid(`${label} must be non-empty canonical base64`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    invalid(`${label} is not base64`);
  }
  if (bytes.length === 0 || bytes.toString("base64") !== value || bytes.length > limit) invalid(`${label} exceeds its byte limit or is not canonical base64`);
  let text2;
  try {
    text2 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid(`${label} is not valid UTF-8`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text2);
  } catch {
    invalid(`${label} is not exactly one JSON value`);
  }
  if (!plain2(parsed) || proofCanonicalJson(parsed) !== text2) invalid(`${label} is not Proof CanonicalJSON`);
  return immutableGovernedValue(parsed, "proof");
}
function validateProofCurrentCatalogAuthorityBytes(input) {
  const revalidation = decodeExactProofJsonBytes(input.revalidationBytesBase64, "revalidationBytesBase64", PROOF_REVALIDATION_OUTPUT_MAX_BYTES);
  const workItems = decodeExactProofJsonBytes(input.workItemsBytesBase64, "workItemsBytesBase64", PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES);
  const candidatePayload = input.candidate.payload;
  if (!plain2(candidatePayload) || typeof candidatePayload.project_id !== "string") invalid("historical candidate project is invalid");
  const projectID = candidatePayload.project_id;
  validateProofCandidateAdmissionBinding(input.candidate, input.admission);
  const inventory = revalidation.inventory;
  if (!plain2(inventory)) invalid("revalidation inventory is invalid");
  const validatedRevalidation = validateProofCatalogRevalidationProjection(
    revalidation,
    inventory,
    input.candidate,
    input.admission,
    projectID
  );
  const validatedWorkItems = validateProofWorkItemsProjection(
    workItems,
    validatedRevalidation,
    inventory,
    input.candidate,
    input.admission,
    projectID
  );
  const receipt = validatedRevalidation.receipt;
  const authorities = plain2(receipt) && Array.isArray(receipt.component_authorities) ? receipt.component_authorities : void 0;
  const items = Array.isArray(validatedWorkItems.work_items) ? validatedWorkItems.work_items : void 0;
  if (!authorities || !items) invalid("Proof current catalog outputs lack component authorities");
  const components = items.map((item) => {
    if (!plain2(item) || typeof item.component_id !== "string") invalid("Proof WorkItem component id is invalid");
    const authority = authorities.find((row) => plain2(row) && row.component_id === item.component_id);
    if (!authority || !plain2(authority) || typeof authority.work_item_digest !== "string" || !plain2(authority.subject)) invalid(`Proof component ${item.component_id} authority is missing`);
    return {
      componentId: item.component_id,
      workItemDigest: authority.work_item_digest,
      subject: authority.subject
    };
  }).sort((left, right) => compareProofStrings(left.componentId, right.componentId));
  if (new Set(components.map((component) => component.componentId)).size !== components.length) invalid("Proof current component authorities are duplicated");
  const compactItems = items.map((item) => {
    const authority = authorities.find((row) => plain2(row) && row.component_id === item.component_id);
    if (!authority || !plain2(authority)) invalid(`Proof component ${String(item.component_id)} authority is missing`);
    return { ...item, authority: { component_id: authority.component_id, work_item_digest: authority.work_item_digest, subject: authority.subject } };
  });
  return immutableProofCanonicalValue({
    // Retain the decoded Proof values, not the graph-canonical validator
    // projection: this is the in-memory view of the exact supplied bytes.
    revalidation,
    workItems,
    items: compactItems,
    components
  });
}
function validateReceipt2(value, projectID, boundaryFingerprint, ids, workItems) {
  const keys = ["version", "decision", "project_id", "project_fingerprint", "boundary_fingerprint", "inventory_claim_id", "catalog_claim_id", "admission_candidate_id", "admission_result_digest", "admission_receipt_id", "component_authorities", "project_lineage", "receipt_id"];
  if (!exact2(value, keys) || value.version !== CATALOG_REVALIDATION_RECEIPT_VERSION || value.decision !== "accepted" || value.project_id !== projectID || value.boundary_fingerprint !== boundaryFingerprint || !fingerprint(value.project_fingerprint) || !fingerprint(value.boundary_fingerprint) || !fingerprint(value.inventory_claim_id) || !fingerprint(value.catalog_claim_id) || !fingerprint(value.admission_candidate_id) || !fingerprint(value.admission_result_digest) || !fingerprint(value.admission_receipt_id) || !fingerprint(value.receipt_id) || !Array.isArray(value.component_authorities)) invalid("catalog revalidation receipt is invalid");
  if (value.component_authorities.length !== ids.size || !admissionLineage(value.project_lineage)) invalid("catalog revalidation receipt has the wrong component count or lineage");
  const seen = /* @__PURE__ */ new Set();
  for (const [index, authority] of value.component_authorities.entries()) {
    if (!plain2(authority) || !exact2(authority, ["component_id", "work_item_digest", "subject"]) || typeof authority.component_id !== "string" || !fingerprint(authority.work_item_digest) || !plain2(authority.subject) || !exact2(authority.subject, ["version", "project_id", "component_id", "sorted_owned_paths", "sorted_dependency_closure", "fingerprint"]) || authority.subject.version !== "proof.component-subject/v1" || !fingerprint(authority.subject.fingerprint) || authority.subject.component_id !== authority.component_id || authority.subject.project_id !== projectID || seen.has(authority.component_id) || !ids.has(authority.component_id)) invalid(`catalog revalidation receipt component_authorities[${index}] is invalid`);
    const item = workItems.find((candidate) => candidate.component_id === authority.component_id);
    if (!item || authority.work_item_digest !== plainDigest(workItemWire(item)) || canonicalJson(authority.subject) !== canonicalJson(item.proof_component_subject)) invalid(`catalog revalidation receipt component_authorities[${index}] is detached`);
    seen.add(authority.component_id);
  }
  const sorted = [...value.component_authorities].sort((left, right) => compareProofStrings(left.component_id, right.component_id));
  if (canonicalJson(value.component_authorities) !== canonicalJson(sorted)) invalid("catalog revalidation receipt component authorities are not sorted");
  const componentAuthoritiesWire = value.component_authorities.map((authority) => {
    const subject = authority.subject;
    return {
      component_id: authority.component_id,
      work_item_digest: authority.work_item_digest,
      subject: {
        version: subject.version,
        project_id: subject.project_id,
        component_id: subject.component_id,
        sorted_owned_paths: subject.sorted_owned_paths,
        sorted_dependency_closure: subject.sorted_dependency_closure,
        fingerprint: subject.fingerprint
      }
    };
  });
  const unsigned = proofTopLevelJson({
    version: goCompatibleProofJson(value.version),
    decision: goCompatibleProofJson(value.decision),
    project_id: goCompatibleProofJson(value.project_id),
    project_fingerprint: goCompatibleProofJson(value.project_fingerprint),
    boundary_fingerprint: goCompatibleProofJson(value.boundary_fingerprint),
    inventory_claim_id: goCompatibleProofJson(value.inventory_claim_id),
    catalog_claim_id: goCompatibleProofJson(value.catalog_claim_id),
    admission_candidate_id: goCompatibleProofJson(value.admission_candidate_id),
    admission_result_digest: goCompatibleProofJson(value.admission_result_digest),
    admission_receipt_id: goCompatibleProofJson(value.admission_receipt_id),
    component_authorities: goCompatibleProofJson(componentAuthoritiesWire),
    project_lineage: goCompatibleProofJson(value.project_lineage === null ? null : (() => {
      const lineage = value.project_lineage;
      return { version: lineage.version, fingerprint: lineage.fingerprint, object_format: lineage.object_format, baseline_revision: lineage.baseline_revision };
    })()),
    // CatalogRevalidationReceipt.receipt_id is not `omitempty`; Proof clears
    // it and includes the empty member in its v2 preimage before hashing.
    receipt_id: goCompatibleProofJson("")
  });
  if (value.receipt_id !== domainDigestBytes("proof.catalog-revalidation-receipt/id/v2", unsigned)) invalid("catalog revalidation receipt ID is invalid");
  return value;
}
function inventoryWire(value) {
  const authority = value.authority;
  return {
    version: value.version,
    authority: {
      version: authority.version,
      project_id: authority.project_id,
      subject_fingerprint: authority.subject_fingerprint,
      code_fingerprint: authority.code_fingerprint,
      tests_fingerprint: authority.tests_fingerprint
    },
    sorted_paths: value.sorted_paths,
    sorted_module_paths: value.sorted_module_paths,
    boundary_fingerprint: value.boundary_fingerprint,
    input_state: value.input_state.map((row) => ({
      owner_kind: row.owner_kind,
      owner_id: row.owner_id,
      input_kind: row.input_kind,
      path: row.path,
      file_hash: row.file_hash
    }))
  };
}
function workItemWire(value) {
  const mapping = value.proof_path_mapping;
  const subject = value.proof_component_subject;
  return {
    version: value.version,
    project_id: value.project_id,
    component_id: value.component_id,
    sorted_owned_paths: value.sorted_owned_paths,
    sorted_dependency_closure: value.sorted_dependency_closure,
    proof_path_mapping: {
      paths: mapping.paths,
      components: mapping.components,
      owner: mapping.owner,
      risk_tier: mapping.risk_tier,
      enforcement: mapping.enforcement
    },
    proof_input_state: value.proof_input_state.map((row) => ({
      owner_kind: row.owner_kind,
      owner_id: row.owner_id,
      input_kind: row.input_kind,
      path: row.path,
      file_hash: row.file_hash
    })),
    proof_component_subject: {
      version: subject.version,
      project_id: subject.project_id,
      component_id: subject.component_id,
      sorted_owned_paths: subject.sorted_owned_paths,
      sorted_dependency_closure: subject.sorted_dependency_closure,
      fingerprint: subject.fingerprint
    }
  };
}
function proofWorkItemDigestForReconciliation(value, projectID) {
  const validated = validateWorkItem(value, projectID, "reconciliation work item");
  return plainDigest(workItemWire(validated));
}
function validateProofCatalogRevalidationProjection(value, inventory, candidate, admission, projectID, revalidationClaim, inventoryClaimId) {
  const admitted = validateProofCandidateAdmissionBinding(candidate, admission);
  candidate = admitted.candidate;
  const candidateWireMode = "proof";
  const keys = ["version", "inventory", "catalog", "work_items", "receipt"];
  if (!exact2(value, keys) || value.version !== CATALOG_REVALIDATION_VERSION) invalid("catalog revalidation projection is not closed");
  if (candidate.producerCheckId !== "inspect" || inventoryClaimId !== void 0 && !candidate.parentClaimIds.includes(inventoryClaimId) || !Array.isArray(candidate.parentClaimIds)) invalid("admission lineage is detached");
  if (candidate.parentClaimIds.some((parent) => typeof parent !== "string")) invalid("candidate lineage is invalid");
  if (revalidationClaim !== void 0) {
    if (inventoryClaimId === void 0 || revalidationClaim.producerCheckId !== "revalidate_catalog" || revalidationClaim.parentClaimIds.length !== 3 || canonicalJson(revalidationClaim.parentClaimIds) !== canonicalJson([inventoryClaimId, candidate.claimId, admission.claimId].sort()) || canonicalJson(revalidationClaim.scope) !== canonicalJson(candidate.scope)) invalid("revalidation lineage is detached");
  }
  const currentInventory = validateStructuralInventory(value.inventory, projectID);
  if (canonicalJson(currentInventory) !== canonicalJson(inventory)) invalid("catalog revalidation inventory is stale");
  const admissionSubject = admitted.receipt.Subject;
  if (admissionSubject.id !== projectID || admitted.receipt.ProjectLineage === null && admissionSubject.fingerprint !== currentInventory.authority.subject_fingerprint) {
    invalid("admission subject is not bound to the current Proof authority");
  }
  const candidateWire = governedCanonicalJson(candidate.payload, candidateWireMode);
  if (admitted.receipt.ProbeCanonicalBytes !== Buffer.byteLength(candidateWire, "utf8") || admitted.receipt.ProbeResultDigest !== governedResultDigest(candidate.payload, candidateWireMode)) {
    invalid("admission result is detached from the candidate catalog");
  }
  const components = candidateComponents(candidate.payload, projectID);
  const ids = new Set(components.map((component) => component.id));
  const catalog = projectedCatalog(value.catalog, projectID);
  const expected = expectedCatalog(candidate, projectID);
  if (proofCanonicalJson(catalog) !== proofCanonicalJson(expected)) invalid("catalog revalidation catalog is detached from candidate");
  const catalogComponents = catalog.components;
  if (new Set(catalogComponents.map((component) => component.id)).size !== ids.size || catalogComponents.some((component) => !ids.has(component.id))) invalid("catalog revalidation catalog is detached from candidate");
  const inventoryPaths = value.inventory && plain2(value.inventory) && Array.isArray(value.inventory.sorted_paths) ? value.inventory.sorted_paths : [];
  const ownedPaths = proofSorted(catalogComponents.flatMap((component) => component.owned_paths));
  if (new Set(ownedPaths).size !== ownedPaths.length || !sameStringSet(ownedPaths, inventoryPaths)) invalid("catalog revalidation catalog does not cover the current inventory");
  if (!Array.isArray(value.work_items) || value.work_items.length !== ids.size) invalid("catalog revalidation WorkItems are incomplete");
  const workItems = value.work_items.map((item, index) => validateWorkItem(item, projectID, `catalog revalidation work_items[${index}]`));
  const inventoryInputByPath = new Map(currentInventory.input_state.map((row) => [row.path, row]));
  for (const item of workItems) {
    for (const row of item.proof_input_state) {
      const inventoryRow = inventoryInputByPath.get(row.path);
      if (!inventoryRow || inventoryRow.input_kind !== row.input_kind || inventoryRow.file_hash !== row.file_hash) {
        invalid(`catalog revalidation WorkItem ${item.component_id} input state is detached from inventory`);
      }
    }
  }
  const itemIDs = new Set(workItems.map((item) => item.component_id));
  if (itemIDs.size !== ids.size || [...ids].some((id) => !itemIDs.has(id))) invalid("catalog revalidation WorkItems are detached from candidate");
  const catalogByID = new Map(catalogComponents.map((component) => [component.id, component]));
  for (const item of workItems) {
    const component = catalogByID.get(item.component_id);
    if (!component || !sameStringSet(item.sorted_owned_paths, component.owned_paths) || component.dependency_closure !== void 0 && !sameStringSet(item.sorted_dependency_closure, component.dependency_closure) || component.dependency_closure === void 0 && !sameStringSet(item.sorted_dependency_closure, item.sorted_owned_paths)) {
      invalid(`catalog revalidation WorkItem ${item.component_id} is detached from catalog paths`);
    }
  }
  const sortedItems = [...workItems].sort((left, right) => compareProofStrings(left.component_id, right.component_id));
  if (canonicalJson(workItems) !== canonicalJson(sortedItems)) invalid("catalog revalidation WorkItems are not sorted by component_id");
  const receipt = validateReceipt2(value.receipt, projectID, value.inventory.boundary_fingerprint, ids, workItems);
  if (admission.producerCheckId !== "proof_admit" || admitted.receipt.Status !== "ADMITTED" || admitted.receipt.ClaimID !== candidate.claimId || admitted.receipt.PayloadFingerprint !== candidate.payloadFingerprint) invalid("admission is not the exact admitted candidate");
  const authority = value.inventory.authority;
  if (!plain2(authority) || receipt.project_fingerprint !== authority.subject_fingerprint) invalid("catalog revalidation receipt project authority is detached");
  const expectedInventoryID = domainDigest("proof.structural-inventory/claim/v1", inventoryWire(currentInventory));
  const expectedCatalogID = domainDigestBytes("proof.component-catalog-candidate/claim/v1", governedCanonicalJson(candidate.payload, candidateWireMode));
  if (receipt.inventory_claim_id !== expectedInventoryID || receipt.catalog_claim_id !== expectedCatalogID || receipt.admission_candidate_id !== admitted.receipt.CandidateID || receipt.admission_result_digest !== admitted.receipt.ProbeResultDigest || receipt.admission_receipt_id !== admitted.receipt.receipt_id) invalid("catalog revalidation receipt lineage is detached");
  return bounded(value, "catalog revalidation projection", PROOF_REVALIDATION_OUTPUT_MAX_BYTES, "proof");
}
function createProofStructuralInventoryProviderFromCapability(capability) {
  return new ProofStructuralInventoryCheckProvider(capability, INTERNAL);
}
function createProofCatalogRevalidationProviderFromCapability(capability) {
  return new ProofCatalogRevalidationCheckProvider(capability, INTERNAL);
}
var INTERNAL, REVALIDATION_REQUEST_VERSION, STRUCTURAL_INVENTORY_VERSION, CATALOG_REVALIDATION_VERSION, CATALOG_REVALIDATION_RECEIPT_VERSION, COMPONENT_CATALOG_CANDIDATE_VERSION, PROOF_CATALOG_INPUT_MAX_BYTES, PROOF_INVENTORY_OUTPUT_MAX_BYTES, PROOF_REVALIDATION_REQUEST_MAX_BYTES, PROOF_REVALIDATION_OUTPUT_MAX_BYTES, PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES, DIGEST, ADMISSION_DECISION_KEYS, ADMISSION_RECEIPT_KEYS, ADMISSION_RECEIPT_COMMON_KEYS, ProofCatalogCliProvider, ProofStructuralInventoryCheckProvider, ProofCatalogRevalidationCheckProvider;
var init_proof_catalog_check_providers = __esm({
  "src/providers/proof-catalog-check-providers.ts"() {
    "use strict";
    init_claim_kernel();
    init_instance_plan();
    init_check_provider_interface();
    init_proof_admission_cli_child();
    init_proof_admission_cli_child();
    init_proof_wire();
    init_governed_proof_inspect_check_provider();
    INTERNAL = /* @__PURE__ */ Symbol("proof-catalog-provider");
    REVALIDATION_REQUEST_VERSION = "proof.catalog-revalidation-request/v2";
    STRUCTURAL_INVENTORY_VERSION = "proof.structural-inventory/v1";
    CATALOG_REVALIDATION_VERSION = "proof.catalog-revalidation/v2";
    CATALOG_REVALIDATION_RECEIPT_VERSION = "proof.catalog-revalidation-receipt/v2";
    COMPONENT_CATALOG_CANDIDATE_VERSION = "proof.component-catalog-candidate/v1";
    PROOF_CATALOG_INPUT_MAX_BYTES = 4 * 1024 * 1024;
    PROOF_INVENTORY_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
    PROOF_REVALIDATION_REQUEST_MAX_BYTES = PROOF_CATALOG_INPUT_MAX_BYTES + 9 * 1024 * 1024;
    PROOF_REVALIDATION_OUTPUT_MAX_BYTES = PROOF_INVENTORY_OUTPUT_MAX_BYTES + 4 * 1024 * 1024;
    PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
    DIGEST = /^sha256:[0-9a-f]{64}$/;
    ADMISSION_DECISION_KEYS = ["version", "status", "receipt", "reject_code"];
    ADMISSION_RECEIPT_KEYS = ["Version", "Status", "CandidateID", "ProbeResultDigest", "ProbeCanonicalBytes", "ClaimID", "Claim", "PayloadFingerprint", "InvocationDigest", "RoleID", "Stance", "Subject", "ProducerCheckID", "ParentClaimIDs", "Binding", "Termination", "ProjectLineage", "receipt_id"];
    ADMISSION_RECEIPT_COMMON_KEYS = ["Version", "Status", "CandidateID", "ProbeResultDigest", "ProbeCanonicalBytes", "ClaimID", "Claim", "PayloadFingerprint", "InvocationDigest", "RoleID", "Stance", "Subject", "ProducerCheckID", "ParentClaimIDs", "Binding", "Termination", "receipt_id"];
    ProofCatalogCliProvider = class extends CheckProvider {
      capability;
      constructor(capability, token) {
        super();
        if (capability && (token !== INTERNAL || !proofAdmissionCapabilityValid(capability))) invalid("capability is invalid");
        this.capability = capability;
      }
      async execute(_pr, _config, _deps, _context) {
        throw new Error(PROOF_ADMISSION_UNAVAILABLE);
      }
      async isAvailable() {
        return this.capability !== void 0;
      }
      getRequirements() {
        return [PROOF_ADMISSION_UNAVAILABLE];
      }
      getSupportedConfigKeys() {
        return ["type", "consumes", "emits", "depends_on"];
      }
    };
    ProofStructuralInventoryCheckProvider = class extends ProofCatalogCliProvider {
      getName() {
        return PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE;
      }
      getDescription() {
        return "Sealed Proof onboarding structural inventory provider";
      }
      async validateConfig(config) {
        return plain2(config) && config.type === PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE && Object.keys(config).every((key) => ["type", "consumes", "emits"].includes(key));
      }
      startManaged(request) {
        const claims = onlyClaims(request.executionContext.claims, ["project"]);
        const project = claim(claims.project, "project.discovery_item@1", "project");
        if (!plain2(project.payload) || typeof project.payload.project_id !== "string") invalid("project claim is invalid");
        const projectPayload = project.payload;
        return startProofManagedCliChild({
          binding: request.binding,
          workingDirectory: request.workingDirectory || "",
          command: ["onboarding", "inventory"],
          input: "",
          inputLimit: 0,
          outputLimit: PROOF_INVENTORY_OUTPUT_MAX_BYTES,
          outputCanonical: false,
          projectOutput: (value) => validateStructuralInventory(value, projectPayload.project_id)
        }, this.capability);
      }
    };
    ProofCatalogRevalidationCheckProvider = class extends ProofCatalogCliProvider {
      getName() {
        return PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE;
      }
      getDescription() {
        return "Sealed Proof onboarding catalog revalidation provider";
      }
      async validateConfig(config) {
        return plain2(config) && config.type === PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE && Object.keys(config).every((key) => ["type", "depends_on", "consumes", "emits"].includes(key));
      }
      startManaged(request) {
        const claims = onlyClaims(request.executionContext.claims, ["current_inventory", "candidate", "receipt"]);
        const inventory = claim(claims.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM, "current inventory");
        const candidate = claim(claims.candidate, PROOF_CANDIDATE_CLAIM, "candidate");
        const admission = claim(claims.receipt, PROOF_ADMITTED_RECEIPT_CLAIM, "admission");
        if (inventory.producerCheckId !== "structural_inventory" || !sameScope([inventory, candidate, admission]) || !plain2(inventory.payload) || !plain2(candidate.payload)) invalid("revalidation claims are cross-scope");
        const inventoryPayload = inventory.payload;
        const candidatePayload = candidate.payload;
        const projectID = typeof inventoryPayload.authority === "object" && inventoryPayload.authority && typeof inventoryPayload.authority.project_id === "string" ? inventoryPayload.authority.project_id : typeof candidatePayload.project_id === "string" ? candidatePayload.project_id : "";
        if (!projectID) invalid("revalidation project id is missing");
        validateStructuralInventory(inventory.payload, projectID);
        candidateComponents(candidate.payload, projectID);
        const admitted = validateProofCandidateAdmissionBinding(candidate, admission);
        let admissionObject;
        try {
          admissionObject = JSON.parse(admitted.wire);
        } catch {
          invalid("admission decision wire is not JSON");
        }
        const input = governedCanonicalJson({ version: REVALIDATION_REQUEST_VERSION, candidate: candidate.payload, admission: admissionObject }, "proof");
        return startProofManagedCliChild({
          binding: request.binding,
          workingDirectory: request.workingDirectory || "",
          command: ["onboarding", "revalidate"],
          input,
          inputLimit: PROOF_REVALIDATION_REQUEST_MAX_BYTES,
          outputLimit: PROOF_REVALIDATION_OUTPUT_MAX_BYTES,
          outputCanonical: false,
          projectOutput: (value) => validateProofCatalogRevalidationProjection(value, inventory.payload, candidate, admission, projectID, void 0, inventory.claimId)
        }, this.capability);
      }
    };
  }
});

// src/providers/governed-proof-inspect-check-provider.ts
import { TextDecoder as TextDecoder3 } from "util";
import { createHash as createHash6 } from "crypto";
function proofAdmissionChild() {
  return proofAdmissionCliChildModule ??= (init_proof_admission_cli_child(), __toCommonJS(proof_admission_cli_child_exports));
}
function probeExecReceiptValidator() {
  if (!probeExecReceiptModule) probeExecReceiptModule = __require("@probelabs/probe");
  return probeExecReceiptModule.validateGovernedCodexExecAttestation;
}
function dataDescriptor(v, key) {
  const descriptor = Object.getOwnPropertyDescriptor(v, key);
  return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor : void 0;
}
function exact3(v, keys) {
  const ks = Reflect.ownKeys(v);
  return ks.length === keys.length && ks.every((k) => typeof k === "string" && keys.includes(k) && !!dataDescriptor(v, k));
}
function validUnicode3(v) {
  for (let index = 0; index < v.length; index++) {
    const code = v.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      const next = v.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 56320 || next > 57343) return false;
      index++;
    } else if (code >= 56320 && code <= 57343) return false;
  }
  return true;
}
function validMaterialized2(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return validUnicode3(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) return false;
      const length = Object.getOwnPropertyDescriptor(value, "length");
      if (!length || !("value" in length) || length.enumerable) return false;
      for (const key of keys) {
        if (key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      }
      for (let index = 0; index < value.length; index++) if (!own(value, String(index))) return false;
      return value.every((item) => validMaterialized2(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !validMaterialized2(descriptor.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}
function text(v, max, nonempty = true) {
  return typeof v === "string" && validUnicode3(v) && (!nonempty || v.length > 0) && Buffer.byteLength(v, "utf8") <= max && (() => {
    try {
      new TextDecoder3("utf-8", { fatal: true }).decode(Buffer.from(v));
      return true;
    } catch {
      return false;
    }
  })();
}
function visible(v, max, nonempty = true) {
  return typeof v === "string" && (!nonempty || v.length > 0) && Buffer.byteLength(v) <= max && /^[\x21-\x7e]*$/.test(v);
}
function wire(v) {
  return typeof v === "string" && DIGEST2.test(v);
}
function bare(v) {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}
function fail2(detail) {
  throw new Error(`GOVERNED_PROOF_INVALID: ${detail}`);
}
function isGovernedProofComponentSelector(value) {
  if (!plain3(value) || !exact3(value, ["role_id", "stance", "subject", "output_schema_id", "output_schema"])) return false;
  const subject = value.subject;
  return value.role_id === "onboard" && value.stance === "owner" && plain3(subject) && exact3(subject, ["kind"]) && subject.kind === "component" && visible(value.output_schema_id, 128) && typeof value.output_schema === "string";
}
function isGovernedProofSpecReviewSelector(value) {
  if (!plain3(value) || !exact3(value, ["role_id", "stance", "subject", "output_schema_id", "output_schema"])) return false;
  const subject = value.subject;
  return value.role_id === "spec-review" && value.stance === "owner" && plain3(subject) && exact3(subject, ["kind"]) && subject.kind === "component" && visible(value.output_schema_id, 128) && typeof value.output_schema === "string";
}
function isGovernedProofProjectSelector(value) {
  if (!plain3(value) || !exact3(value, ["role_id", "stance", "subject", "output_schema_id", "output_schema"])) return false;
  const subject = value.subject;
  return value.role_id === "onboard" && value.stance === "owner" && plain3(subject) && exact3(subject, ["kind"]) && subject.kind === "project" && visible(value.output_schema_id, 128) && typeof value.output_schema === "string";
}
function validateProofComponentInvocationAuthority(value) {
  if (!plain3(value) || !exact3(value, ["work_item_digest", "subject", "candidate", "admission", "work_item", "catalog_revalidation_receipt"]) || !validMaterialized2(value)) fail2("component authority is not closed");
  if (!wire(value.work_item_digest) || !plain3(value.subject) || !exact3(value.subject, ["version", "project_id", "component_id", "sorted_owned_paths", "sorted_dependency_closure", "fingerprint"]) || value.subject.version !== "proof.component-subject/v1" || typeof value.subject.project_id !== "string" || typeof value.subject.component_id !== "string" || !wire(value.subject.fingerprint) || !Array.isArray(value.subject.sorted_owned_paths) || !Array.isArray(value.subject.sorted_dependency_closure)) fail2("component authority subject is invalid");
  if (!plain3(value.candidate) || !plain3(value.admission) || !plain3(value.work_item) || !plain3(value.catalog_revalidation_receipt)) fail2("component authority lineage is invalid");
  return cloneAndFreezeAuthority(value);
}
function cloneAndFreezeAuthority(value) {
  if (Array.isArray(value)) {
    const copy = value.map((item) => cloneAndFreezeAuthority(item));
    return Object.freeze(copy);
  }
  if (value && typeof value === "object") {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = cloneAndFreezeAuthority(value[key]);
    return Object.freeze(copy);
  }
  return value;
}
function governedResultDigest2(value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash6("sha256").update(GOVERNED_RESULT_IDENTITY_DOMAIN, "utf8").update(Buffer.from([0])).update(length).update(bytes).digest("hex")}`;
}
function jsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail2(`${label} is not JSON`);
  }
  if (!plain3(parsed) || !exact3(parsed, Object.keys(parsed))) fail2(`${label} must be a JSON object`);
  return parsed;
}
function decodeSchema(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail2("output_schema is not padded base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > 131072 || bytes.toString("base64") !== value) fail2("output_schema encoding is invalid");
  try {
    const decoded = new TextDecoder3("utf-8", { fatal: true }).decode(bytes);
    if (!validUnicode3(decoded)) fail2("output_schema contains malformed Unicode");
    return decoded;
  } catch {
    fail2("output_schema is not UTF-8");
  }
}
function validateInvocation(value) {
  const hasAuthority = plain3(value) && own(value, "component_authority");
  const hasOnboardingStage = plain3(value) && own(value, "onboarding_stage");
  const keys = hasOnboardingStage ? ["role_id", "stance", "subject", "component_authority", "onboarding_stage", "output_schema_id", "output_schema"] : hasAuthority ? ["role_id", "stance", "subject", "component_authority", "output_schema_id", "output_schema"] : ["role_id", "stance", "subject", "output_schema_id", "output_schema"];
  if (!plain3(value) || !exact3(value, keys)) fail2("invocation keys are not closed");
  if (!validMaterialized2(value)) fail2("invocation contains non-materialized data");
  if (!visible(value.role_id, 128) || value.stance !== "owner" && value.stance !== "external-review" || !visible(value.output_schema_id, 128)) fail2("invocation strings are invalid");
  const subject = value.subject;
  if (!plain3(subject) || !exact3(subject, ["kind", "id", "fingerprint"]) || subject.kind !== "project" && subject.kind !== "requirement" && !(hasAuthority && subject.kind === "component") || !visible(subject.id, 128) || !wire(subject.fingerprint)) fail2("invocation subject is invalid");
  if (hasAuthority) validateProofComponentInvocationAuthority(value.component_authority);
  if (hasOnboardingStage) {
    if (!hasAuthority || value.role_id !== "spec-review") fail2("onboarding stage context is paired with the wrong invocation");
    const stage = value.onboarding_stage;
    try {
      proofAdmissionChild().validateOnboardingStageContext(stage);
    } catch {
      fail2("onboarding stage context is invalid or exceeds its bound");
    }
  }
  const schema = decodeSchema(value.output_schema);
  const parsed = jsonObject(schema, "output_schema");
  if (!validMaterialized2(parsed)) fail2("output_schema contains non-materialized data");
}
function projectGovernedProofInspectConfig(value) {
  if (!plain3(value)) fail2("config is not a plain object");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail2("config contains a symbol key");
  for (const key of Reflect.ownKeys(value)) if (!dataDescriptor(value, key)) fail2(`config key ${String(key)} is not an enumerable data property`);
  for (const key of Object.keys(value)) {
    if (!AUTHORED.includes(key) && !CONTROLLER.has(key) && !GRAPH.has(key)) fail2(`unknown config key ${key}`);
    if (GRAPH.has(key) && !validMaterialized2(value[key])) fail2(`graph config key ${key} is not materialized`);
  }
  if (value.type !== GOVERNED_PROOF_INSPECT_PROVIDER_NAME || value.profile !== PROFILE) fail2("config fields are invalid");
  if (isGovernedProofProjectSelector(value.invocation)) {
    if (!text(value.message, 32768) || own(value, "instructions") || own(value, "invocation_digest") || own(value, "result_schema")) fail2("project selector may author only its discovery message");
    const decoded2 = decodeSchema(value.invocation.output_schema);
    const parsed = jsonObject(decoded2, "output_schema");
    if (!validMaterialized2(parsed)) fail2("output_schema contains non-materialized data");
    return immutableCanonicalValue({ type: GOVERNED_PROOF_INSPECT_PROVIDER_NAME, message: value.message, invocation: value.invocation, profile: PROFILE });
  }
  if (isGovernedProofComponentSelector(value.invocation) || isGovernedProofSpecReviewSelector(value.invocation)) {
    if (own(value, "message") || own(value, "instructions") || own(value, "invocation_digest") || own(value, "result_schema")) fail2("component selector cannot author resolved Proof fields");
    const decoded2 = decodeSchema(value.invocation.output_schema);
    const parsed = jsonObject(decoded2, "output_schema");
    if (!validMaterialized2(parsed)) fail2("output_schema contains non-materialized data");
    return immutableCanonicalValue({ type: GOVERNED_PROOF_INSPECT_PROVIDER_NAME, invocation: value.invocation, profile: PROFILE });
  }
  if (!text(value.message, 32768) || !text(value.instructions, 131072) || !wire(value.invocation_digest)) fail2("config fields are invalid");
  validateInvocation(value.invocation);
  if (!text(value.result_schema, 131072)) fail2("result_schema is invalid");
  const decoded = decodeSchema(value.invocation.output_schema);
  if (value.result_schema !== decoded) fail2("result_schema does not equal invocation output_schema");
  return immutableCanonicalValue(Object.fromEntries(AUTHORED.map((k) => [k, value[k]])));
}
function proofPathCompare(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
function validateGovernedProofComponentReinspectionContext(value) {
  if (!plain3(value) || !exact3(value, ["version", "component_id", "changed_paths", "historical_work_item", "current_work_item", "prior_candidate", "prior_admission"]) || !validMaterialized2(value) || value.version !== GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION || !visible(value.component_id, 256) || !Array.isArray(value.changed_paths)) fail2("reinspection context header is invalid");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail2("reinspection context exceeds bounded byte limit");
  const paths = value.changed_paths;
  if (paths.length === 0 || paths.some((path) => !visible(path, 4096)) || paths.some((path, index) => index > 0 && proofPathCompare(paths[index - 1], path) >= 0)) fail2("reinspection context paths are not sorted and nonempty");
  const ref = (entry, keys) => {
    if (!plain3(entry) || !exact3(entry, keys) || !validMaterialized2(entry)) fail2("reinspection context claim reference is invalid");
    if (!bare(entry.claim_id) || !bare(entry.payload_fingerprint)) fail2("reinspection context claim reference identity is invalid");
    return entry;
  };
  const historical = ref(value.historical_work_item, ["claim_id", "payload_fingerprint"]);
  const current = ref(value.current_work_item, ["claim_id", "payload_fingerprint"]);
  const candidate = ref(value.prior_candidate, ["claim_id", "payload_fingerprint", "result_digest", "payload"]);
  if (!wire(candidate.result_digest) || JSON.stringify(candidate.payload) !== canonicalJson(candidate.payload) || sha256Canonical(candidate.payload) !== candidate.payload_fingerprint) fail2("reinspection context candidate is detached");
  const admission = ref(value.prior_admission, ["claim_id", "payload_fingerprint"]);
  if (historical.claim_id === current.claim_id || candidate.claim_id === admission.claim_id) fail2("reinspection context identities are not distinct");
  return immutableCanonicalValue(value);
}
function governedProofComponentReinspectionContextDigest(value) {
  const context = validateGovernedProofComponentReinspectionContext(value);
  return `sha256:${sha256Canonical(context)}`;
}
function validateAttestation(att, digest2, expectedDispatch) {
  if (!validMaterialized2(att)) fail2("attestation contains non-materialized data");
  if (plain3(att) && att.version === "probe.governed-codex-exec-attestation/v1") {
    const validator = probeExecReceiptValidator();
    if (!validator) fail2("exec attestation validator is unavailable");
    let validated;
    try {
      validated = validator(att);
    } catch {
      fail2("exec attestation is invalid");
    }
    if (!plain3(validated) || validated.profileId !== PROFILE || !plain3(validated.executionContext) || !exact3(validated.executionContext, ["source", "invocationDigest"]) || validated.executionContext.source !== "caller" || validated.executionContext.invocationDigest !== digest2 || !plain3(validated.dispatch) || !exact3(validated.dispatch, ["source", "tool", "promptDigest", "promptBytes"]) || validated.dispatch.source !== "probe-host-exec" || validated.dispatch.tool !== "codex-exec") {
      fail2("exec attestation binding is invalid");
    }
    if (expectedDispatch && (expectedDispatch.source !== "probe-host-exec" || expectedDispatch.tool !== "codex-exec" || validated.dispatch.promptDigest !== expectedDispatch.promptDigest || validated.dispatch.promptBytes !== expectedDispatch.promptBytes)) fail2("exec attestation dispatch is detached from the Probe preview");
    return immutableCanonicalValue(validated);
  }
  if (!plain3(att) || !exact3(att, ["version", "profileId", "requested", "observed", "executionContext", "dispatch", "evidence", "usage"]) || att.version !== "probe.governed-codex-attestation/v2" || att.profileId !== PROFILE) fail2("attestation header invalid");
  const requested = att.requested, observed = att.observed, ctx = att.executionContext, dispatch = att.dispatch, evidence = att.evidence, usage = att.usage;
  if (!plain3(requested) || !exact3(requested, ["profileDigest", "cwdDigest", "probeToolsDigest", "model", "reasoningEffort", "sandbox", "approvalPolicy"]) || !bare(requested.profileDigest) || !bare(requested.cwdDigest) || !bare(requested.probeToolsDigest) || requested.model !== "gpt-5.6-luna" || requested.reasoningEffort !== "xhigh" || requested.sandbox !== "read-only" || requested.approvalPolicy !== "never") fail2("requested attestation invalid");
  if (!plain3(observed) || !exact3(observed, ["source", "model", "modelProviderId", "reasoningEffort", "approvalPolicy", "cwdDigest", "permissionProfileDigest", "filesystem", "network"]) || observed.source !== "session_configured" || observed.model !== "gpt-5.6-luna" || observed.modelProviderId !== "openai" || observed.reasoningEffort !== "xhigh" || observed.approvalPolicy !== "never" || !bare(observed.cwdDigest) || !bare(observed.permissionProfileDigest) || observed.filesystem !== "restricted-read-root" || observed.network !== "restricted") fail2("observed attestation invalid");
  if (!plain3(ctx) || !exact3(ctx, ["source", "invocationDigest"]) || ctx.source !== "caller" || ctx.invocationDigest !== digest2 || !plain3(dispatch) || !exact3(dispatch, ["source", "tool", "promptDigest", "promptBytes"]) || dispatch.source !== "probe-host-tools-call" || dispatch.tool !== "codex" || !wire(dispatch.promptDigest) || typeof dispatch.promptBytes !== "number" || !Number.isSafeInteger(dispatch.promptBytes) || dispatch.promptBytes < 0 || !plain3(evidence) || !exact3(evidence, ["eventCount"]) || evidence.eventCount !== 1 || !plain3(usage) || !exact3(usage, ["status"]) || usage.status !== "unavailable") fail2("attestation evidence invalid");
  if (expectedDispatch && (!plain3(expectedDispatch) || !exact3(expectedDispatch, ["source", "tool", "promptDigest", "promptBytes"]) || expectedDispatch.source !== "probe-host-tools-call" || expectedDispatch.tool !== "codex" || !wire(expectedDispatch.promptDigest) || typeof expectedDispatch.promptBytes !== "number" || !Number.isSafeInteger(expectedDispatch.promptBytes) || expectedDispatch.promptBytes < 0 || dispatch.promptDigest !== expectedDispatch.promptDigest || dispatch.promptBytes !== expectedDispatch.promptBytes)) fail2("attestation dispatch is detached from the Probe preview");
  return immutableCanonicalValue(att);
}
function validateRunnerResult(value) {
  if (!plain3(value) || !exact3(value, ["data", "runtimeAttestation", "resultIdentity"]) || !validMaterialized2(value) || !plain3(value.runtimeAttestation) || !plain3(value.resultIdentity)) fail2("runner result shape is invalid");
  return value;
}
function candidateClaimKeys(value) {
  return value.provenance === "controller" ? ["claimId", "claim", "payload", "payloadFingerprint", "producerCheckId", "scope", "parentClaimIds", "wireMode", "provenance", "catalogClaimId", "incarnation"] : ["claimId", "claim", "payload", "payloadFingerprint", "producerCheckId", "scope", "parentClaimIds", "wireMode", "provenance", "attemptId", "fence"];
}
function validateRuntimeContextClaim(value, expectedClaim, expectedScope, options) {
  if (!plain3(value) || !validMaterialized2(value)) fail2("runtime context claim is not materialized");
  const claim2 = value;
  if (claim2.provenance !== "controller" && claim2.provenance !== "attempt") fail2("runtime context claim provenance is invalid");
  if (!exact3(claim2, candidateClaimKeys(claim2))) fail2("runtime context claim contains extra or missing fields");
  if (!bare(claim2.claimId) || claim2.claim !== expectedClaim || !bare(claim2.payloadFingerprint) || !visible(claim2.producerCheckId, 128)) fail2("runtime context claim identity is invalid");
  if (!Array.isArray(claim2.parentClaimIds) || claim2.parentClaimIds.some((id) => !bare(id)) || [...claim2.parentClaimIds].sort().some((id, index) => id !== claim2.parentClaimIds[index])) fail2("runtime context claim parents are invalid");
  if (!Array.isArray(claim2.scope) || !validMaterialized2(claim2.scope)) fail2("runtime context claim scope is invalid");
  if (expectedScope && canonicalJson(claim2.scope) !== canonicalJson(expectedScope)) fail2("runtime context claim scope is foreign");
  if (!validMaterialized2(claim2.payload)) fail2("runtime context claim payload is not materialized");
  if (JSON.stringify(claim2.scope) !== canonicalJson(claim2.scope)) fail2("runtime context claim scope is noncanonical");
  const payloadCanonical = canonicalJson(claim2.payload);
  if (!options?.allowNonCanonicalPayload && JSON.stringify(claim2.payload) !== payloadCanonical || sha256Canonical(claim2.payload) !== claim2.payloadFingerprint) fail2("runtime context claim payload is noncanonical or detached");
  return immutableCanonicalValue({
    claimId: claim2.claimId,
    claim: claim2.claim,
    payloadFingerprint: claim2.payloadFingerprint,
    scope: claim2.scope,
    payload: claim2.payload
  });
}
function validateProjectedRuntimeContextClaim(value, expectedClaim, options) {
  if (!plain3(value) || !exact3(value, ["claimId", "claim", "payloadFingerprint", "scope", "payload"]) || !validMaterialized2(value)) fail2("projected runtime context claim is not closed");
  const claim2 = value;
  if (!bare(claim2.claimId) || claim2.claim !== expectedClaim || !bare(claim2.payloadFingerprint) || !Array.isArray(claim2.scope) || !validMaterialized2(claim2.scope) || !validMaterialized2(claim2.payload)) fail2("projected runtime context claim identity is invalid");
  if (!options?.allowNonCanonicalPayload && JSON.stringify(value) !== canonicalJson(value) || JSON.stringify(claim2.scope) !== canonicalJson(claim2.scope)) fail2("projected runtime context claim is noncanonical");
  if (!options?.allowNonCanonicalPayload && JSON.stringify(claim2.payload) !== canonicalJson(claim2.payload) || sha256Canonical(claim2.payload) !== claim2.payloadFingerprint) fail2("projected runtime context payload is noncanonical or detached");
  return immutableCanonicalValue({
    claimId: claim2.claimId,
    claim: claim2.claim,
    payloadFingerprint: claim2.payloadFingerprint,
    scope: claim2.scope,
    payload: claim2.payload
  });
}
function validateNativeReviewedComponentPayload(value, expectedComponentId) {
  if (!plain3(value) || !validMaterialized2(value) || !exact3(value, ["version", "component_id", "status", "item_count", "source", "reviews"]) || value.version !== "native.component.reviewed/v1" || !visible(value.component_id, 256) || value.component_id !== expectedComponentId || value.status !== "reviewed-native-requirement-items" || !Number.isSafeInteger(value.item_count) || value.item_count < 1 || !plain3(value.source) || !validMaterialized2(value.source) || !exact3(value.source, ["kind", "checkpoint_sha256", "graph_semantic_digest", "manifest_sha256"]) || value.source.kind !== "current_graph" && value.source.kind !== "retained_checkpoint" || (value.source.kind === "current_graph" ? value.source.checkpoint_sha256 !== null || value.source.graph_semantic_digest !== null : !wire(value.source.checkpoint_sha256) || !bare(value.source.graph_semantic_digest)) || !wire(value.source.manifest_sha256) || !Array.isArray(value.reviews) || value.reviews.length !== value.item_count) {
    fail2("reviewed component payload is invalid");
  }
  const reviews = value.reviews;
  const ids = /* @__PURE__ */ new Set();
  let previousId;
  for (const entry of reviews) {
    const retainedClaim = plain3(entry) && entry.retained_claim;
    const retainedClaimValid = value.source.kind === "current_graph" ? retainedClaim === null : plain3(retainedClaim) && exact3(retainedClaim, ["claim_id", "payload_fingerprint"]) && bare(retainedClaim.claim_id) && bare(retainedClaim.payload_fingerprint);
    if (!plain3(entry) || !validMaterialized2(entry) || !exact3(entry, ["id", "component_id", "file_path", "proof_file_hash", "candidate", "candidate_fingerprint", "packet_sha256", "retained_claim"]) || !visible(entry.id, 512) || ids.has(entry.id) || previousId !== void 0 && Buffer.from(previousId, "utf8").compare(Buffer.from(entry.id, "utf8")) >= 0 || entry.component_id !== expectedComponentId || !visible(entry.file_path, 4096) || entry.file_path.startsWith("/") || entry.file_path.includes("\\") || entry.file_path.split("/").some((part) => part === ".." || part.length === 0) || !wire(entry.proof_file_hash) || !validMaterialized2(entry.candidate) || entry.candidate_fingerprint !== `sha256:${sha256Canonical(entry.candidate)}` || !wire(entry.packet_sha256) || !retainedClaimValid) {
      fail2("reviewed component packet projection is invalid");
    }
    ids.add(entry.id);
    previousId = entry.id;
  }
  return value;
}
function validateReviewedComponentContext(value) {
  if (!plain3(value) || !exact3(value, ["version", "component", "reviewed"]) || !validMaterialized2(value) || value.version !== GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2) {
    fail2("reviewed component runtime context header is invalid");
  }
  const component = validateProjectedRuntimeContextClaim(value.component, COMPONENT_WORK_ITEM_CLAIM);
  const reviewed = validateProjectedRuntimeContextClaim(value.reviewed, NATIVE_COMPONENT_REVIEWED_CLAIM, { allowNonCanonicalPayload: true });
  if (component.claimId === reviewed.claimId || canonicalJson(component.scope) !== canonicalJson(reviewed.scope)) fail2("reviewed component context claims are not distinct and co-scoped");
  if (!plain3(component.payload) || typeof component.payload.component_id !== "string" || component.payload.component_id.length === 0) fail2("reviewed component WorkItem is invalid");
  validateNativeReviewedComponentPayload(reviewed.payload, component.payload.component_id);
  const context = immutableCanonicalValue({ version: GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2, component, reviewed });
  if (Buffer.byteLength(canonicalJson(context), "utf8") > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail2("reviewed component runtime context exceeds bounded byte limit");
  return context;
}
function projectEmbeddedAuthority(payload, expectedScope) {
  if (!plain3(payload) || !own(payload, "authority")) fail2("runtime WorkItem authority is missing");
  const embedded = payload.authority;
  if (!plain3(embedded) || !exact3(embedded, ["claimId", "claim", "payloadFingerprint", "payload"]) || !validMaterialized2(embedded)) fail2("runtime WorkItem authority envelope is not closed");
  if (!bare(embedded.claimId) || embedded.claim !== PROOF_ROLE_AUTHORITY_CLAIM || !bare(embedded.payloadFingerprint) || !validMaterialized2(embedded.payload) || JSON.stringify(embedded.payload) !== canonicalJson(embedded.payload) || sha256Canonical(embedded.payload) !== embedded.payloadFingerprint) fail2("runtime WorkItem authority is detached");
  return immutableCanonicalValue({
    claimId: embedded.claimId,
    claim: embedded.claim,
    payloadFingerprint: embedded.payloadFingerprint,
    scope: expectedScope,
    payload: embedded.payload
  });
}
function validateStructuralInventoryForContext(value, projectID) {
  try {
    const catalog = (init_proof_catalog_check_providers(), __toCommonJS(proof_catalog_check_providers_exports));
    return catalog.validateStructuralInventory(value, projectID);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GOVERNED_PROOF_INVALID:")) throw error;
    fail2(`project discovery inventory is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function validateProjectDiscoveryContextPayload(project, inventory, expectedSubject) {
  const projectPayload = project.payload;
  const inventoryPayload = inventory.payload;
  if (!plain3(projectPayload) || typeof projectPayload.project_id !== "string" || projectPayload.project_id.length === 0 || !plain3(inventoryPayload) || !plain3(inventoryPayload.authority)) fail2("project discovery context payload is invalid");
  const authority = inventoryPayload.authority;
  if (authority.project_id !== projectPayload.project_id || !wire(authority.subject_fingerprint)) fail2("project discovery context identity is detached");
  validateStructuralInventoryForContext(inventoryPayload, projectPayload.project_id);
  if (expectedSubject && (expectedSubject.projectId !== projectPayload.project_id || expectedSubject.fingerprint !== authority.subject_fingerprint)) fail2("project discovery context subject is detached");
}
function validateRuntimeContextShape(value) {
  if (!plain3(value) || typeof value.version !== "string" || JSON.stringify(value) !== canonicalJson(value)) fail2("runtime context header is invalid");
  const context = value;
  if (context.version === GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2) {
    return validateReviewedComponentContext(context);
  }
  if (context.version === GOVERNED_PROOF_CONTEXT_VERSION) {
    if (!exact3(value, ["version", "component", "authority"])) fail2("runtime context header is invalid");
    const component = validateProjectedRuntimeContextClaim(context.component, COMPONENT_WORK_ITEM_CLAIM);
    const authority = validateProjectedRuntimeContextClaim(context.authority, PROOF_ROLE_AUTHORITY_CLAIM);
    if (component.claimId === authority.claimId || canonicalJson(component.scope) !== canonicalJson(authority.scope)) fail2("runtime context claims are not distinct and co-scoped");
    return immutableCanonicalValue({ version: GOVERNED_PROOF_CONTEXT_VERSION, component, authority });
  }
  if (context.version === GOVERNED_PROOF_PROJECT_CONTEXT_VERSION) {
    if (!exact3(value, ["version", "project", "current_inventory"])) fail2("project discovery context header is invalid");
    const project = validateProjectedRuntimeContextClaim(context.project, PROJECT_DISCOVERY_CLAIM);
    const inventory = validateProjectedRuntimeContextClaim(context.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM2);
    if (project.claimId === inventory.claimId || canonicalJson(project.scope) !== canonicalJson(inventory.scope)) fail2("project discovery context claims are not distinct and co-scoped");
    validateProjectDiscoveryContextPayload(project, inventory);
    return immutableCanonicalValue({ version: GOVERNED_PROOF_PROJECT_CONTEXT_VERSION, project, current_inventory: inventory });
  }
  fail2("runtime context version is unsupported");
}
function projectGovernedProofRuntimeContext(claims, binding) {
  if (plain3(claims) && exact3(claims, ["component", "reviewed"])) {
    const context2 = validateReviewedComponentContext({
      version: GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2,
      component: validateRuntimeContextClaim(claims.component, COMPONENT_WORK_ITEM_CLAIM, binding.scope),
      reviewed: validateRuntimeContextClaim(claims.reviewed, NATIVE_COMPONENT_REVIEWED_CLAIM, binding.scope, { allowNonCanonicalPayload: true })
    });
    if (Buffer.byteLength(canonicalJson(context2), "utf8") > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail2("reviewed component runtime context exceeds bounded byte limit");
    return context2;
  }
  if (!plain3(claims) || !exact3(claims, ["component"])) fail2("runtime context requires exactly the component WorkItem claim");
  const record = claims;
  const component = validateRuntimeContextClaim(record.component, COMPONENT_WORK_ITEM_CLAIM, binding.scope);
  const authority = projectEmbeddedAuthority(component.payload, binding.scope);
  if (component.claimId === authority.claimId) fail2("runtime context claims must be distinct");
  const context = immutableCanonicalValue({ version: GOVERNED_PROOF_CONTEXT_VERSION, component, authority });
  if (Buffer.byteLength(canonicalJson(context), "utf8") > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail2("runtime context exceeds bounded byte limit");
  return context;
}
function projectGovernedProofProjectDiscoveryContext(claims, binding, expectedSubject) {
  if (!plain3(claims) || !exact3(claims, ["project", "current_inventory"])) fail2("project discovery context requires exactly project and current_inventory claims");
  const record = claims;
  const project = validateRuntimeContextClaim(record.project, PROJECT_DISCOVERY_CLAIM, binding.scope);
  const inventory = validateRuntimeContextClaim(record.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM2, binding.scope);
  if (project.claimId === inventory.claimId || canonicalJson(project.scope) !== canonicalJson(inventory.scope)) fail2("project discovery context claims are not distinct and co-scoped");
  validateProjectDiscoveryContextPayload(project, inventory, expectedSubject);
  const context = immutableCanonicalValue({ version: GOVERNED_PROOF_PROJECT_CONTEXT_VERSION, project, current_inventory: inventory });
  if (Buffer.byteLength(canonicalJson(context), "utf8") > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail2("project discovery context exceeds bounded byte limit");
  return context;
}
function governedProofRuntimeContextDigest(context) {
  validateRuntimeContextShape(context);
  return `sha256:${sha256Canonical(context)}`;
}
function validateGovernedProofRuntimeContextAgainstClaims(evidence, parentClaims, binding) {
  const contextClaims = parentClaims.filter((claim2) => claim2.claim === COMPONENT_WORK_ITEM_CLAIM);
  const reviewedClaims = parentClaims.filter((claim2) => claim2.claim === NATIVE_COMPONENT_REVIEWED_CLAIM);
  const projectClaims = parentClaims.filter((claim2) => claim2.claim === PROJECT_DISCOVERY_CLAIM);
  const inventoryClaims = parentClaims.filter((claim2) => claim2.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM2);
  const invocation = evidence.role.invocation;
  if (plain3(invocation) && own(invocation, "component_authority")) {
    if (evidence.reinspectionContext !== void 0 || evidence.reinspectionContextDigest !== void 0) {
      if (!evidence.reinspectionContext || typeof evidence.reinspectionContextDigest !== "string") fail2("reinspection context fields are not paired");
      const reinspection = validateGovernedProofComponentReinspectionContext(evidence.reinspectionContext);
      if (evidence.reinspectionContextDigest !== governedProofComponentReinspectionContextDigest(reinspection)) fail2("reinspection context digest is detached");
    }
    if (projectClaims.length !== 0 || inventoryClaims.length !== 0) fail2("component invocation authority cannot use project discovery parents");
    if (reviewedClaims.length > 0) {
      if (contextClaims.length !== 1 || reviewedClaims.length !== 1 || parentClaims.length !== 2 || !evidence.context || evidence.context.version !== GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2 || evidence.contextDigest === void 0) fail2("reviewed component invocation authority requires exactly WorkItem and reviewed parents");
      const context2 = validateRuntimeContextShape(evidence.context);
      if (context2.version !== GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2) fail2("reviewed component runtime context is invalid");
      if (evidence.contextDigest !== governedProofRuntimeContextDigest(context2)) fail2("reviewed component runtime context digest is detached");
      const parentComponent = contextClaims[0];
      const parentReviewed = reviewedClaims[0];
      if (canonicalJson(context2.component) !== canonicalJson({ claimId: parentComponent.claimId, claim: parentComponent.claim, payloadFingerprint: parentComponent.payloadFingerprint, scope: parentComponent.scope, payload: parentComponent.payload }) || canonicalJson(context2.reviewed) !== canonicalJson({ claimId: parentReviewed.claimId, claim: parentReviewed.claim, payloadFingerprint: parentReviewed.payloadFingerprint, scope: parentReviewed.scope, payload: parentReviewed.payload }) || canonicalJson(context2.component.scope) !== canonicalJson(binding.scope) || canonicalJson(context2.reviewed.scope) !== canonicalJson(binding.scope)) fail2("reviewed component runtime context is stale or foreign");
    } else if (contextClaims.length !== 1 || parentClaims.length !== 1) {
      fail2("component invocation authority requires exactly one WorkItem parent");
    }
    const authority2 = validateProofComponentInvocationAuthority(invocation.component_authority);
    const invocationSubject = invocation.subject;
    if (!plain3(invocationSubject) || invocationSubject.id !== authority2.subject.component_id || invocationSubject.fingerprint !== authority2.subject.fingerprint) fail2("component invocation subject is detached from authority");
    const payload = contextClaims[0].payload;
    if (!plain3(payload) || !plain3(payload.authority) || canonicalJson(payload.authority) !== canonicalJson({
      component_id: authority2.subject.component_id,
      work_item_digest: authority2.work_item_digest,
      subject: authority2.subject
    })) fail2("component invocation authority is detached from WorkItem");
    return;
  }
  if (projectClaims.length > 0 || inventoryClaims.length > 0) {
    if (projectClaims.length !== 1 || inventoryClaims.length !== 1 || contextClaims.length !== 0 || parentClaims.length !== 2 || !evidence.context || evidence.context.version !== GOVERNED_PROOF_PROJECT_CONTEXT_VERSION || evidence.contextDigest === void 0) fail2("project discovery runtime context is missing or foreign");
    const context2 = validateRuntimeContextShape(evidence.context);
    if (context2.version !== GOVERNED_PROOF_PROJECT_CONTEXT_VERSION) fail2("project discovery runtime context is invalid");
    const project = projectClaims[0];
    const inventory = inventoryClaims[0];
    if (canonicalJson(project.scope) !== canonicalJson(binding.scope) || canonicalJson(inventory.scope) !== canonicalJson(binding.scope) || canonicalJson(context2.project.scope) !== canonicalJson(binding.scope) || canonicalJson(context2.current_inventory.scope) !== canonicalJson(binding.scope) || canonicalJson(context2.project) !== canonicalJson({ claimId: project.claimId, claim: project.claim, payloadFingerprint: project.payloadFingerprint, scope: project.scope, payload: project.payload }) || canonicalJson(context2.current_inventory) !== canonicalJson({ claimId: inventory.claimId, claim: inventory.claim, payloadFingerprint: inventory.payloadFingerprint, scope: inventory.scope, payload: inventory.payload })) fail2("project discovery runtime context is stale or foreign");
    validateProjectDiscoveryContextPayload(context2.project, context2.current_inventory);
    const projectPayload = project.payload;
    const authority2 = plain3(context2.current_inventory.payload) && plain3(context2.current_inventory.payload.authority) ? context2.current_inventory.payload.authority : void 0;
    const subject = plain3(invocation.subject) ? invocation.subject : void 0;
    if (!plain3(projectPayload) || !plain3(authority2) || !subject || subject.kind !== "project" || subject.id !== projectPayload.project_id || subject.fingerprint !== authority2.subject_fingerprint) fail2("project discovery invocation is detached from runtime context");
    return;
  }
  if (contextClaims.length === 0) {
    if (evidence.context !== void 0 || evidence.contextDigest !== void 0) fail2("unexpected runtime context for legacy inspect");
    return;
  }
  if (contextClaims.length !== 1 || !evidence.context || evidence.contextDigest === void 0) fail2("runtime context is missing");
  const context = evidence.context;
  const parent = contextClaims[0];
  if (context.component.claimId !== parent.claimId || context.component.claim !== parent.claim || context.component.payloadFingerprint !== parent.payloadFingerprint || canonicalJson(parent.scope) !== canonicalJson(context.component.scope) || canonicalJson(parent.payload) !== canonicalJson(context.component.payload)) fail2("runtime context component is stale or foreign");
  const authority = projectEmbeddedAuthority(parent.payload, binding.scope);
  if (canonicalJson(authority) !== canonicalJson(context.authority)) fail2("runtime context authority is stale or foreign");
  if (canonicalJson(context.component.scope) !== canonicalJson(binding.scope) || canonicalJson(context.authority.scope) !== canonicalJson(binding.scope)) fail2("runtime context scope is foreign");
}
function requiresRuntimeContext(config) {
  if (isGovernedProofComponentSelector(config.invocation) || isGovernedProofSpecReviewSelector(config.invocation)) {
    const consumes2 = config.consumes;
    const exactConsume = (value, claim2, as) => plain3(value) && (exact3(value, ["claim", "as"]) || exact3(value, ["claim", "as", "cardinality"]) && value.cardinality === "one") && value.claim === claim2 && value.as === as;
    const reviewedBinding = isGovernedProofComponentSelector(config.invocation) && Array.isArray(consumes2) && consumes2.length === 2 && consumes2.some((value) => exactConsume(value, COMPONENT_WORK_ITEM_CLAIM, "component")) && consumes2.some((value) => exactConsume(value, NATIVE_COMPONENT_REVIEWED_CLAIM, "reviewed"));
    if (isGovernedProofComponentSelector(config.invocation) && Array.isArray(consumes2) && (consumes2.length > 1 || consumes2.some((value) => plain3(value) && value.claim === NATIVE_COMPONENT_REVIEWED_CLAIM)) && !reviewedBinding) {
      fail2("component selector reviewed bindings are not exact");
    }
    return reviewedBinding ? "reviewed-component" : void 0;
  }
  if (isGovernedProofProjectSelector(config.invocation)) {
    const consumes2 = config.consumes;
    const exactConsume = (value, claim2, as) => plain3(value) && (exact3(value, ["claim", "as"]) || exact3(value, ["claim", "as", "cardinality"]) && value.cardinality === "one") && value.claim === claim2 && value.as === as;
    if (!Array.isArray(consumes2) || consumes2.length !== 2 || consumes2.some((value) => !plain3(value)) || !consumes2.some((value) => exactConsume(value, PROJECT_DISCOVERY_CLAIM, "project")) || !consumes2.some((value) => exactConsume(value, PROOF_STRUCTURAL_INVENTORY_CLAIM2, "current_inventory"))) {
      fail2("project selector bindings are not exact");
    }
    return "project";
  }
  const consumes = config.consumes;
  if (consumes === void 0) return void 0;
  if (!Array.isArray(consumes)) fail2("config consumes is not an array");
  const component = consumes.filter((value) => plain3(value) && value.claim === COMPONENT_WORK_ITEM_CLAIM && value.as === "component");
  const project = consumes.filter((value) => plain3(value) && value.claim === PROJECT_DISCOVERY_CLAIM && value.as === "project");
  const inventory = consumes.filter((value) => plain3(value) && value.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM2 && value.as === "current_inventory");
  const exactProjectConsume = (value) => plain3(value) && (exact3(value, ["claim", "as"]) || exact3(value, ["claim", "as", "cardinality"]) && value.cardinality === "one");
  const hasComponentContextClaim = consumes.some((value) => plain3(value) && value.claim === COMPONENT_WORK_ITEM_CLAIM);
  if (hasComponentContextClaim) {
    if (consumes.some((value) => plain3(value) && value.claim === PROOF_ROLE_AUTHORITY_CLAIM)) fail2("runtime authority must be carried by the component WorkItem envelope");
    if (component.length !== 1 || consumes.length !== 1 || consumes.some((value) => !plain3(value))) fail2("runtime context declarations are not the canonical WorkItem envelope");
    return "component";
  }
  const hasProjectContextClaim = consumes.some((value) => plain3(value) && (value.claim === PROJECT_DISCOVERY_CLAIM || value.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM2));
  if (hasProjectContextClaim) {
    if (project.length !== 1 || inventory.length !== 1 || consumes.length !== 2 || consumes.some((value) => !exactProjectConsume(value))) fail2("project discovery runtime context declarations are not exact");
    return "project";
  }
  if (consumes.some((value) => plain3(value) && value.claim === PROOF_ROLE_AUTHORITY_CLAIM)) fail2("runtime authority must be carried by the component WorkItem envelope");
  return void 0;
}
function evidenceFromResult(config, result, context, reinspectionContext, dispatchPreview) {
  validateRunnerResult(result);
  if (!validMaterialized2(result.data)) fail2("runner data is not materialized JSON");
  const wireMode = governedWireModeFromInvocation(config.invocation);
  const dataBytes = Buffer.from(governedCanonicalJson(result.data, wireMode), "utf8");
  if (wireMode === "generic" && JSON.stringify(result.data) !== dataBytes.toString("utf8")) fail2("runner data is not canonical JSON");
  const identity = result.resultIdentity;
  if (!plain3(identity) || !exact3(identity, ["version", "source", "resultDigest", "canonicalBytes"]) || identity.version !== "probe.governed-result-identity/v1" || identity.source !== "probe-host-schema-valid-json" || identity.resultDigest !== (wireMode === "proof" ? governedResultDigest(result.data, wireMode) : governedResultDigest2(result.data)) || identity.canonicalBytes !== dataBytes.length || typeof identity.canonicalBytes !== "number" || !Number.isSafeInteger(identity.canonicalBytes) || identity.canonicalBytes < 0) fail2("result identity invalid");
  const digest2 = config.invocation_digest;
  const att = validateAttestation(result.runtimeAttestation, digest2, context || reinspectionContext ? dispatchPreview : void 0);
  const invocation = config.invocation;
  if (context) {
    const projected = validateRuntimeContextShape(context);
    return immutableProofCandidateEvidence({ version: "visor.proof-candidate-evidence/v1", role: { invocation, invocationDigest: digest2 }, probe: { attestation: att, resultIdentity: identity }, context: projected, contextDigest: governedProofRuntimeContextDigest(projected), ...reinspectionContext ? { reinspectionContext, reinspectionContextDigest: governedProofComponentReinspectionContextDigest(reinspectionContext) } : {} });
  }
  return immutableProofCandidateEvidence({ version: "visor.proof-candidate-evidence/v1", role: { invocation, invocationDigest: digest2 }, probe: { attestation: att, resultIdentity: identity }, ...reinspectionContext ? { reinspectionContext, reinspectionContextDigest: governedProofComponentReinspectionContextDigest(reinspectionContext) } : {} });
}
function validateProofCandidateEvidence(value) {
  if (!plain3(value) || value.version !== "visor.proof-candidate-evidence/v1") fail2("evidence header is invalid");
  const hasContext = own(value, "context") || own(value, "contextDigest");
  const hasReinspectionContext = own(value, "reinspectionContext") || own(value, "reinspectionContextDigest");
  const expectedKeys = ["version", "role", "probe", ...hasContext ? ["context", "contextDigest"] : [], ...hasReinspectionContext ? ["reinspectionContext", "reinspectionContextDigest"] : []];
  if (!exact3(value, expectedKeys)) fail2("evidence context fields are not paired");
  const role = value.role;
  if (!plain3(role) || !exact3(role, ["invocation", "invocationDigest"])) fail2("evidence role is invalid");
  const invocationDigest = role.invocationDigest;
  if (!wire(invocationDigest)) fail2("evidence role is invalid");
  const invocation = role.invocation;
  validateInvocation(invocation);
  const probe = value.probe;
  if (!plain3(probe) || !exact3(probe, ["attestation", "resultIdentity"])) fail2("evidence probe is invalid");
  const attestation = validateAttestation(probe.attestation, invocationDigest);
  const identity = probe.resultIdentity;
  if (!plain3(identity) || !exact3(identity, ["version", "source", "resultDigest", "canonicalBytes"]) || identity.version !== "probe.governed-result-identity/v1" || identity.source !== "probe-host-schema-valid-json" || !wire(identity.resultDigest) || typeof identity.canonicalBytes !== "number" || !Number.isSafeInteger(identity.canonicalBytes) || identity.canonicalBytes < 0) fail2("evidence result identity is invalid");
  if (!validMaterialized2(value)) fail2("evidence contains non-materialized data");
  if (hasContext) {
    const context = validateRuntimeContextShape(value.context);
    if (value.contextDigest !== governedProofRuntimeContextDigest(context)) fail2("evidence runtime context digest is detached");
  }
  let reinspectionContext;
  if (hasReinspectionContext) {
    if (!value.reinspectionContext || typeof value.reinspectionContextDigest !== "string") fail2("evidence reinspection context fields are not paired");
    reinspectionContext = validateGovernedProofComponentReinspectionContext(value.reinspectionContext);
    if (value.reinspectionContextDigest !== governedProofComponentReinspectionContextDigest(reinspectionContext)) fail2("evidence reinspection context digest is detached");
  }
  let canonical;
  try {
    canonical = governedProofCandidateEvidenceJson(value);
  } catch {
    fail2("evidence is not canonical JSON");
  }
  if (Buffer.byteLength(canonical, "utf8") > 262144) fail2("evidence exceeds canonical byte limit");
  const evidence = {
    version: "visor.proof-candidate-evidence/v1",
    role: {
      invocation,
      invocationDigest
    },
    probe: {
      attestation,
      resultIdentity: identity
    },
    ...hasContext ? { context: validateRuntimeContextShape(value.context), contextDigest: value.contextDigest } : {},
    ...reinspectionContext ? { reinspectionContext, reinspectionContextDigest: value.reinspectionContextDigest } : {}
  };
  return immutableProofCandidateEvidence(evidence);
}
function createGovernedProofInspectProviderFromCapability(capability) {
  if (!proofAdmissionChild().proofAdmissionCapabilityValid(capability)) fail2(PROOF_ADMISSION_UNAVAILABLE2);
  return new GovernedProofInspectCheckProvider(void 0, INTERNAL2, capability);
}
var proofAdmissionCliChildModule, probeExecReceiptModule, GOVERNED_PROOF_INSPECT_PROVIDER_NAME, GOVERNED_PROBE_UNAVAILABLE, PROOF_ADMISSION_UNAVAILABLE2, GOVERNED_PROOF_INSPECT_MESSAGE, GOVERNED_RESULT_IDENTITY_DOMAIN, DIGEST2, PROFILE, COMPONENT_WORK_ITEM_CLAIM, PROOF_ROLE_AUTHORITY_CLAIM, GOVERNED_PROOF_CONTEXT_VERSION, GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION, GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2, PROJECT_DISCOVERY_CLAIM, PROOF_STRUCTURAL_INVENTORY_CLAIM2, GOVERNED_PROOF_PROJECT_CONTEXT_VERSION, NATIVE_COMPONENT_REVIEWED_CLAIM, GOVERNED_PROOF_CONTEXT_MAX_BYTES, AUTHORED, CONTROLLER, GRAPH, own, plain3, INTERNAL2, GovernedProofInspectCheckProvider;
var init_governed_proof_inspect_check_provider = __esm({
  "src/providers/governed-proof-inspect-check-provider.ts"() {
    "use strict";
    init_claim_kernel();
    init_check_provider_interface();
    init_governed_probe_runner();
    init_proof_wire();
    init_proof_wire();
    GOVERNED_PROOF_INSPECT_PROVIDER_NAME = "governed-proof-inspect";
    GOVERNED_PROBE_UNAVAILABLE = "GOVERNED_PROBE_UNAVAILABLE";
    PROOF_ADMISSION_UNAVAILABLE2 = "PROOF_ADMISSION_UNAVAILABLE";
    GOVERNED_PROOF_INSPECT_MESSAGE = GOVERNED_PROOF_ROLE_MESSAGE;
    GOVERNED_RESULT_IDENTITY_DOMAIN = "probe.governed-result-identity/data/v1";
    DIGEST2 = /^sha256:[0-9a-f]{64}$/;
    PROFILE = "luna-xhigh-readonly-v1";
    COMPONENT_WORK_ITEM_CLAIM = "component.work_item@1";
    PROOF_ROLE_AUTHORITY_CLAIM = "proof.component_role_authority@1";
    GOVERNED_PROOF_CONTEXT_VERSION = "visor.proof-runtime-context/v1";
    GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION = "visor.proof-component-reinspection-context/v1";
    GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION2 = GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION;
    PROJECT_DISCOVERY_CLAIM = "project.discovery_item@1";
    PROOF_STRUCTURAL_INVENTORY_CLAIM2 = "proof.structural_inventory@1";
    GOVERNED_PROOF_PROJECT_CONTEXT_VERSION = "visor.proof-project-discovery-context/v1";
    NATIVE_COMPONENT_REVIEWED_CLAIM = "native.component.reviewed@1";
    GOVERNED_PROOF_CONTEXT_MAX_BYTES = 131072;
    AUTHORED = ["type", "message", "instructions", "invocation", "invocation_digest", "result_schema", "profile"];
    CONTROLLER = /* @__PURE__ */ new Set(["checkName", "prompt", "exec", "schema", "group", "focus", "transform", "transform_js", "env", "forEach", "eventContext", "__outputHistory", "__globalTools", "checksMeta", "workflowInputs", "ai"]);
    GRAPH = /* @__PURE__ */ new Set(["emits", "consumes", "depends_on", "expand"]);
    own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
    plain3 = (v) => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
    INTERNAL2 = /* @__PURE__ */ Symbol("governed-proof-inspect-test-factory");
    GovernedProofInspectCheckProvider = class extends CheckProvider {
      factory;
      capability;
      constructor(factory, token, capability) {
        super();
        if (factory && token !== INTERNAL2) fail2("runner factory is test-only");
        this.factory = factory || createGovernedProbeRunner;
        this.capability = capability;
      }
      getName() {
        return GOVERNED_PROOF_INSPECT_PROVIDER_NAME;
      }
      getDescription() {
        return "Sealed built-in governed Proof inspection provider";
      }
      async validateConfig(config) {
        try {
          projectGovernedProofInspectConfig(config);
          return true;
        } catch {
          return false;
        }
      }
      async execute(_pr, _config, _deps, _ctx) {
        throw new Error(GOVERNED_PROBE_UNAVAILABLE);
      }
      getSupportedConfigKeys() {
        return [...AUTHORED];
      }
      async isAvailable() {
        return false;
      }
      getRequirements() {
        return [GOVERNED_PROBE_UNAVAILABLE];
      }
      startManaged(request) {
        const runtimeContextKind = requiresRuntimeContext(request.checkConfig);
        const runtimeContextRequired = runtimeContextKind !== void 0;
        const config = projectGovernedProofInspectConfig(request.checkConfig);
        if (!/^[0-9a-f]{64}$/.test(request.executionConfigDigest)) fail2("executionConfigDigest is invalid");
        if (typeof request.workingDirectory !== "string" || request.workingDirectory.length === 0) fail2("workingDirectory is invalid");
        const binding = immutableCanonicalValue(request.binding);
        const componentSelector = isGovernedProofComponentSelector(request.checkConfig.invocation);
        const projectSelector = isGovernedProofProjectSelector(request.checkConfig.invocation);
        const selector = componentSelector || isGovernedProofSpecReviewSelector(request.checkConfig.invocation) || projectSelector;
        const reinspectionContext = request.reinspectionContext === void 0 ? void 0 : validateGovernedProofComponentReinspectionContext(request.reinspectionContext);
        if (reinspectionContext && !isGovernedProofComponentSelector(request.checkConfig.invocation)) fail2("reinspection context requires a component selector");
        const specReview = isGovernedProofSpecReviewSelector(request.checkConfig.invocation);
        const onboardingStage = request.executionContext.proofOnboardingStageContext;
        if (specReview !== (onboardingStage !== void 0)) fail2("spec-review requires its paired controller onboarding context");
        let context;
        if (runtimeContextKind === "project") {
          const invocation = config.invocation;
          const subject = plain3(invocation) && plain3(invocation.subject) ? invocation.subject : void 0;
          if (projectSelector) {
            context = projectGovernedProofProjectDiscoveryContext(request.executionContext?.claims, binding);
          } else {
            if (!subject || subject.kind !== "project" || typeof subject.id !== "string" || typeof subject.fingerprint !== "string") fail2("project discovery invocation subject is invalid");
            context = projectGovernedProofProjectDiscoveryContext(request.executionContext?.claims, binding, { projectId: subject.id, fingerprint: subject.fingerprint });
          }
        } else if (runtimeContextKind === "component" || runtimeContextKind === "reviewed-component") {
          context = projectGovernedProofRuntimeContext(request.executionContext?.claims, binding);
        }
        const contextDigest = context ? governedProofRuntimeContextDigest(context) : void 0;
        if (selector && !this.capability) fail2(PROOF_ADMISSION_UNAVAILABLE2);
        let cancelled = false, closed = false;
        const c0Cancellation = new AbortController();
        let runner;
        let runnerRequest;
        let acquisition;
        const acquire = async () => {
          if (cancelled || closed) throw new Error(PROOF_ADMISSION_UNAVAILABLE2);
          let effective = config;
          if (selector) {
            const authored = config.invocation;
            let c0Request;
            if (projectSelector) {
              if (!context || context.version !== GOVERNED_PROOF_PROJECT_CONTEXT_VERSION) fail2("project selector context is unavailable");
              const projectPayload = context.project.payload;
              const inventoryPayload = context.current_inventory.payload;
              const inventoryAuthority = plain3(inventoryPayload) && plain3(inventoryPayload.authority) ? inventoryPayload.authority : void 0;
              if (!plain3(projectPayload) || !plain3(inventoryAuthority) || typeof projectPayload.project_id !== "string" || typeof inventoryAuthority.subject_fingerprint !== "string") fail2("project selector context authority is invalid");
              c0Request = {
                role_id: authored.role_id,
                stance: authored.stance,
                subject: { kind: "project", id: projectPayload.project_id, fingerprint: inventoryAuthority.subject_fingerprint },
                output_schema_id: authored.output_schema_id,
                output_schema: authored.output_schema
              };
            } else {
              const authority = validateProofComponentInvocationAuthority(request.executionContext.proofComponentAuthority);
              const subject = authority.subject;
              if (reinspectionContext && reinspectionContext.component_id !== subject.component_id) fail2("reinspection context component is detached from authority");
              const componentClaim = request.executionContext.claims && request.executionContext.claims.component;
              if (!plain3(componentClaim) || !plain3(componentClaim.payload) || !plain3(componentClaim.payload.authority)) fail2("activated WorkItem authority is missing");
              const expectedCompact = { component_id: subject.component_id, work_item_digest: authority.work_item_digest, subject };
              if (canonicalJson(componentClaim.payload.authority) !== canonicalJson(expectedCompact)) fail2("component authority is detached from activated WorkItem");
              c0Request = {
                role_id: authored.role_id,
                stance: authored.stance,
                subject: { kind: "component", id: subject.component_id, fingerprint: subject.fingerprint },
                component_authority: authority,
                ...specReview ? { onboarding_stage: onboardingStage } : {},
                output_schema_id: authored.output_schema_id,
                output_schema: authored.output_schema
              };
            }
            const resolved = await proofAdmissionChild().resolveProofRoleInvocation(this.capability, c0Request, request.workingDirectory, c0Cancellation.signal);
            if (cancelled || closed || c0Cancellation.signal.aborted) throw new Error(PROOF_ADMISSION_UNAVAILABLE2);
            const outputSchema = decodeSchema(resolved.output_schema);
            const resolvedConfig = { type: GOVERNED_PROOF_INSPECT_PROVIDER_NAME, message: projectSelector ? config.message : GOVERNED_PROOF_INSPECT_MESSAGE, instructions: resolved.instructions, invocation: c0Request, invocation_digest: resolved.invocation_digest, result_schema: outputSchema, profile: PROFILE };
            effective = projectSelector ? immutableCanonicalValue(resolvedConfig) : immutableProofCanonicalValue(resolvedConfig);
          }
          const invocation = effective.invocation;
          const governedCodexTransport = request.executionContext.governedCodexTransport;
          const codexBin = request.executionContext.codexBin;
          const codexSha256 = request.executionContext.codexSha256;
          if (governedCodexTransport !== void 0 && (governedCodexTransport !== "exec-jsonl-default-auth-v1" || typeof codexBin !== "string" || typeof codexSha256 !== "string" || !/^(?:[0-9a-f]{64}|sha256:[0-9a-f]{64})$/.test(codexSha256))) fail2("governed Codex transport identity is invalid");
          if (governedCodexTransport === void 0 && (codexBin !== void 0 || codexSha256 !== void 0)) fail2("governed Codex executable requires an explicit transport");
          const runnerConfig = { message: effective.message, instructions: effective.instructions, invocation, invocationDigest: effective.invocation_digest, resultSchema: effective.result_schema, executionConfigDigest: request.executionConfigDigest, binding, workingDirectory: request.workingDirectory, ...governedCodexTransport ? { governedCodexTransport, codexBin, codexSha256 } : {}, ...context ? { context, contextDigest } : {}, ...reinspectionContext ? { reinspectionContext, reinspectionContextDigest: governedProofComponentReinspectionContextDigest(reinspectionContext) } : {} };
          runnerRequest = componentSelector || specReview ? immutableProofCanonicalValue(runnerConfig) : immutableCanonicalValue(runnerConfig);
          try {
            request.executionContext.hooks?.onPromptCaptured?.({
              step: request.binding.checkId,
              provider: GOVERNED_PROOF_INSPECT_PROVIDER_NAME,
              prompt: renderGovernedProbePublicRequest(runnerRequest)
            });
          } catch {
          }
          runner = this.factory(runnerRequest);
          if (!runner || typeof runner !== "object" || typeof runner.answer !== "function" || typeof runner.cancel !== "function" || typeof runner.close !== "function") fail2("runner boundary is invalid");
          if ((runtimeContextRequired || reinspectionContext) && typeof runner.preview !== "function") fail2("runner boundary lacks the required Probe preview");
          return { config: effective, runner, request: runnerRequest };
        };
        const answer = Promise.resolve().then(() => {
          acquisition = acquire();
          acquisition = acquisition.catch((error) => {
            emitGovernedProbeFailure(request.binding, "acquire", error);
            throw error;
          });
          return acquisition;
        }).then(({ config: effective, runner: acquired, request: effectiveRequest }) => {
          const preview = runtimeContextRequired || reinspectionContext ? acquired.preview(effectiveRequest) : void 0;
          return Promise.resolve(preview).then((previewValue) => Promise.resolve(acquired.answer(effectiveRequest)).then((value) => ({ value, preview: previewValue, effective })));
        }).then(({ value, preview, effective }) => {
          const validated = validateRunnerResult(value);
          const evidence = evidenceFromResult(effective, validated, context, reinspectionContext, preview);
          const wireMode = governedWireModeFromEvidence(evidence);
          const output = immutableGovernedValue(validated.data, wireMode);
          return Object.freeze({ version: 1, kind: "succeeded-proof-candidate", binding, summary: Object.freeze({ issues: [], output }), proofCandidateEvidence: evidence, wireMode });
        });
        return { binding, started: Promise.resolve({ version: 1, kind: "started", binding }), outcome: answer, cancel: async (reason, fence) => {
          if (fence !== binding.fence) throw new Error("GOVERNED_PROOF_INVALID: cancellation fence is stale");
          if (!cancelled) {
            cancelled = true;
            c0Cancellation.abort();
            if (acquisition) await acquisition.catch(() => void 0);
            if (runner) await runner.cancel(reason);
          }
          return { version: 1, kind: "cancelled", binding, reason };
        }, close: async () => {
          if (!closed) {
            closed = true;
            c0Cancellation.abort();
            if (acquisition) await acquisition.catch(() => void 0);
            if (runner) await runner.close();
          }
          return { version: 1, kind: "cleanup", binding, status: "clean", activeChildren: 0, activeResources: 0 };
        } };
      }
    };
  }
});

// src/state-machine/graph/instance-plan.ts
import { TextDecoder as TextDecoder4 } from "util";
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key) && (() => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  })());
}
function validUnicode4(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 56320 || next > 57343) return false;
      index++;
    } else if (code >= 56320 && code <= 57343) return false;
  }
  return true;
}
function validText(value, max, nonempty = true) {
  return typeof value === "string" && validUnicode4(value) && (!nonempty || value.length > 0) && Buffer.byteLength(value, "utf8") <= max;
}
function validVisible(value, max) {
  return typeof value === "string" && validUnicode4(value) && value.length > 0 && Buffer.byteLength(value, "utf8") <= max && /^[\x21-\x7e]+$/.test(value);
}
function validDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
function decodeGovernedSchema(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return "";
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > 131072 || bytes.toString("base64") !== value) return "";
  try {
    const decoded = new TextDecoder4("utf-8", { fatal: true }).decode(bytes);
    return validUnicode4(decoded) ? decoded : "";
  } catch {
    return "";
  }
}
function validateControllerAi(name, value) {
  if (value === void 0) return;
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) rejectReservedProfile(name, "inspect ai must be a plain object");
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "timeout");
  if (keys.length !== 1 || keys[0] !== "timeout" || !descriptor || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value) || descriptor.value < CONTROLLER_TIMEOUT_MIN || descriptor.value > CONTROLLER_TIMEOUT_MAX) rejectReservedProfile(name, "inspect ai.timeout must be one finite integer from 1 through 2147483647");
}
function componentSelectorTemplateBindingAllowed(inputName, inputClaim, check) {
  if (inputName !== "component" || inputClaim !== "component.work_item@1") return false;
  const consumes = check.consumes;
  if (!Array.isArray(consumes) || consumes.length !== 1) return false;
  const consumption = consumes[0];
  const keys = Reflect.ownKeys(consumption);
  return Object.getPrototypeOf(consumption) === Object.prototype && (keys.length === 2 || keys.length === 3 && consumption.cardinality === "one") && keys.every((key) => typeof key === "string" && (key === "claim" || key === "as" || key === "cardinality")) && consumption.claim === "component.work_item@1" && consumption.as === "component";
}
function reviewedComponentSelectorTemplateBindingAllowed(inputName, inputClaim, check) {
  if (inputName !== "component" || inputClaim !== "component.work_item@1") return false;
  const consumes = check.consumes;
  if (!Array.isArray(consumes) || consumes.length !== 2) return false;
  const exactConsume = (value, claim2, as) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value;
    const keys = Reflect.ownKeys(record);
    if (!(keys.length === 2 || keys.length === 3 && record.cardinality === "one") || keys.some((key) => typeof key !== "string" || key !== "claim" && key !== "as" && key !== "cardinality")) return false;
    return record.claim === claim2 && record.as === as;
  };
  return consumes.some((value) => exactConsume(value, "component.work_item@1", "component")) && consumes.some((value) => exactConsume(value, "native.component.reviewed@1", "reviewed"));
}
function validateGovernedInspectConfig(name, check, componentSelectorAllowed = false, specReviewSelectorAllowed = false, projectSelectorAllowed = false) {
  const record = check, allowed = ["type", "message", "instructions", "invocation", "invocation_digest", "result_schema", "profile", "ai", "depends_on", "emits", "consumes", "expand"], prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null || !hasExactKeys(record, Reflect.ownKeys(record).filter((key) => typeof key === "string"))) rejectReservedProfile(name, "inspect config must be a plain materialized object");
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.includes(key))) rejectReservedProfile(name, "inspect config contains unknown provider or topology keys");
  validateControllerAi(name, record.ai);
  if (record.profile !== "luna-xhigh-readonly-v1") rejectReservedProfile(name, "inspect governed config is invalid");
  if (isGovernedProofComponentSelector(record.invocation)) {
    if (!componentSelectorAllowed) rejectReservedProfile(name, "component selector is only valid for a component.work_item@1 template input bound as component");
    if (["message", "instructions", "invocation_digest", "result_schema"].some((key) => hasOwn(record, key))) rejectReservedProfile(name, "component selector cannot author resolved Proof fields");
    const selectorInvocation = record.invocation;
    const decodedSelectorSchema = decodeGovernedSchema(selectorInvocation.output_schema);
    let selectorSchema;
    try {
      selectorSchema = JSON.parse(decodedSelectorSchema);
    } catch {
      rejectReservedProfile(name, "component selector output schema is not JSON");
    }
    if (!decodedSelectorSchema || !selectorSchema || typeof selectorSchema !== "object" || Array.isArray(selectorSchema) || !validMaterialized3(selectorSchema)) rejectReservedProfile(name, "component selector output schema is invalid");
    return;
  }
  if (specReviewSelectorAllowed && isGovernedProofSpecReviewSelector(record.invocation)) {
    if (["message", "instructions", "invocation_digest", "result_schema"].some((key) => hasOwn(record, key))) rejectReservedProfile(name, "spec-review selector cannot author resolved Proof fields");
    const selectorInvocation = record.invocation;
    const decodedSelectorSchema = decodeGovernedSchema(selectorInvocation.output_schema);
    let selectorSchema;
    try {
      selectorSchema = JSON.parse(decodedSelectorSchema);
    } catch {
      rejectReservedProfile(name, "spec-review selector output schema is not JSON");
    }
    if (!decodedSelectorSchema || !selectorSchema || typeof selectorSchema !== "object" || Array.isArray(selectorSchema) || !validMaterialized3(selectorSchema)) rejectReservedProfile(name, "spec-review selector output schema is invalid");
    return;
  }
  if (projectSelectorAllowed && isGovernedProofProjectSelector(record.invocation)) {
    if (!validText(record.message, 32768) || ["instructions", "invocation_digest", "result_schema"].some((key) => hasOwn(record, key))) rejectReservedProfile(name, "project selector may author only its discovery message");
    const selectorInvocation = record.invocation;
    const decodedSelectorSchema = decodeGovernedSchema(selectorInvocation.output_schema);
    let selectorSchema;
    try {
      selectorSchema = JSON.parse(decodedSelectorSchema);
    } catch {
      rejectReservedProfile(name, "project selector output schema is not JSON");
    }
    if (!decodedSelectorSchema || !selectorSchema || typeof selectorSchema !== "object" || Array.isArray(selectorSchema) || !validMaterialized3(selectorSchema)) rejectReservedProfile(name, "project selector output schema is invalid");
    return;
  }
  if (!validText(record.message, 32768) || !validText(record.instructions, 131072) || !validDigest(record.invocation_digest) || !validText(record.result_schema, 131072)) rejectReservedProfile(name, "inspect governed config is invalid");
  const invocation = record.invocation;
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation) || !hasExactKeys(invocation, ["role_id", "stance", "subject", "output_schema_id", "output_schema"]) || !validMaterialized3(invocation)) rejectReservedProfile(name, "inspect invocation is not closed");
  const invocationRecord = invocation, subject = invocationRecord.subject;
  if (!validVisible(invocationRecord.role_id, 128) || invocationRecord.stance !== "owner" && invocationRecord.stance !== "external-review" || !validVisible(invocationRecord.output_schema_id, 128) || !subject || typeof subject !== "object" || Array.isArray(subject) || !hasExactKeys(subject, ["kind", "id", "fingerprint"]) || !validMaterialized3(subject)) rejectReservedProfile(name, "inspect invocation fields are invalid");
  const subjectRecord = subject;
  if (subjectRecord.kind !== "project" && subjectRecord.kind !== "requirement" || !validVisible(subjectRecord.id, 128) || !validDigest(subjectRecord.fingerprint)) rejectReservedProfile(name, "inspect invocation subject is invalid");
  const decoded = decodeGovernedSchema(invocationRecord.output_schema);
  if (!decoded || record.result_schema !== decoded) rejectReservedProfile(name, "inspect result schema is not bound to invocation");
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    rejectReservedProfile(name, "inspect output schema is not JSON");
  }
  if (!validMaterialized3(parsed) || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) rejectReservedProfile(name, "inspect output schema must be a JSON object");
}
function validMaterialized3(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return validUnicode4(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, "length");
      if (keys.some((key) => typeof key !== "string" || key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) || !length || !("value" in length) || length.enumerable) return false;
      for (const key of keys) {
        if (key === "length") continue;
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !("value" in d) || !d.enumerable) return false;
      }
      for (let i = 0; i < value.length; i++) if (!hasOwn(value, String(i))) return false;
      return value.every((item) => validMaterialized3(item, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable || !validMaterialized3(d.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}
function qualifiedNestedExpansionOwner(parentTemplateName, parentTemplateNodeKey) {
  return JSON.stringify([parentTemplateName, parentTemplateNodeKey]);
}
function frozenRecord(record) {
  return Object.freeze(record);
}
function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InstancePlanError("INVALID_EXPANSION_CONFIG", `${field} must be a non-empty string`);
  }
  return value;
}
function compileJsonPointer(pointer, field) {
  if (typeof pointer !== "string" || pointer !== "" && !pointer.startsWith("/")) {
    throw new InstancePlanError(
      "INVALID_JSON_POINTER",
      `${field} must be an RFC 6901 JSON Pointer`
    );
  }
  const tokens = pointer === "" ? [] : pointer.slice(1).split("/");
  const decoded = tokens.map((token) => {
    if (/~(?:[^01]|$)/.test(token)) {
      throw new InstancePlanError(
        "INVALID_JSON_POINTER",
        `${field} contains an invalid RFC 6901 escape`
      );
    }
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
  });
  return Object.freeze({ source: pointer, tokens: Object.freeze(decoded) });
}
function resolveJsonPointer(value, pointer) {
  let current = value;
  for (const token of pointer.tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        throw new InstancePlanError(
          "JSON_POINTER_NOT_FOUND",
          `Pointer ${pointer.source} does not resolve exactly`
        );
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        throw new InstancePlanError(
          "JSON_POINTER_NOT_FOUND",
          `Pointer ${pointer.source} does not resolve exactly`
        );
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object" || !hasOwn(current, token)) {
      throw new InstancePlanError(
        "JSON_POINTER_NOT_FOUND",
        `Pointer ${pointer.source} does not resolve exactly`
      );
    }
    current = current[token];
  }
  return current;
}
function dependencyTokens(check, checkId) {
  const raw = check.depends_on;
  const tokens = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const orToken = tokens.find((token) => token.includes("|"));
  if (orToken) {
    throw new InstancePlanError(
      "UNSUPPORTED_TEMPLATE_OR_DEPENDENCY",
      `Template check "${checkId}" uses unsupported OR dependency token "${orToken}"`
    );
  }
  return tokens;
}
function hasRouting(check) {
  return ["on_init", "on_success", "on_fail", "on_finish"].some((field) => {
    if (!hasOwn(check, field)) return false;
    const value = check[field];
    return value !== void 0 && value !== null;
  });
}
function resolvedTemplateCheck(check) {
  const consumptions = (check.consumes || []).map((consumption) => ({
    ...consumption,
    cardinality: "one"
  }));
  return immutableCanonicalValue({
    ...check,
    type: check.type || "ai",
    ...check.consumes ? { consumes: consumptions } : {}
  });
}
function compileWaitForExpansion(templateName, nodeKey, value, siblingKeys) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, ["owner", "terminal_node"])) {
    throw new InstancePlanError(
      "INVALID_WAIT_FOR_EXPANSION",
      `Template check "${templateName}.${nodeKey}" wait_for_expansion must contain only owner and terminal_node`
    );
  }
  const record = value;
  const owner = requireNonEmptyString(record.owner, `subgraphs.${templateName}.checks.${nodeKey}.wait_for_expansion.owner`);
  const terminalNode = requireNonEmptyString(record.terminal_node, `subgraphs.${templateName}.checks.${nodeKey}.wait_for_expansion.terminal_node`);
  if (owner === nodeKey || !siblingKeys.has(owner)) {
    throw new InstancePlanError(
      "INVALID_WAIT_FOR_EXPANSION",
      `Template check "${templateName}.${nodeKey}" wait_for_expansion.owner must name a sibling node`
    );
  }
  return Object.freeze({ owner, terminal_node: terminalNode });
}
function claimList(check, field) {
  return (check[field] || []).map((declaration) => declaration.claim).sort();
}
function claimBindings(check) {
  return (check.consumes || []).map((declaration) => JSON.stringify([declaration.claim, declaration.as])).sort();
}
function validateCatalogEgressConfig(templateName, nodeKey, check, allowed) {
  const record = check;
  if (Reflect.ownKeys(record).some(
    (key) => typeof key !== "string" || !allowed.includes(key) || !Object.getOwnPropertyDescriptor(record, key)?.enumerable || !("value" in (Object.getOwnPropertyDescriptor(record, key) || {}))
  )) {
    rejectReservedProfile(templateName, `${nodeKey} contains an unknown or non-materialized key`);
  }
}
function rejectReservedProfile(templateName, detail) {
  throw new InstancePlanError(
    "RESERVED_PROOF_ADMISSION_PROFILE",
    `Subgraph template "${templateName}" violates the reserved proof admission profile: ${detail}`
  );
}
function validateChecklistProjectTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, consumptionsByNode, dependencies, topology, authority) {
  const researchClaim = "proof.checklist.research-snapshot@1";
  const researchAuthorityClaim = "proof.checklist.research-catalog-authority@1";
  const baselineClaim = "native.initialized.baseline@1";
  const skeletonClaim = "proof.checklist.skeleton-snapshot@1";
  const expectedTopology = [
    "structural_inventory",
    "inspect",
    PROOF_ADMIT_NODE_KEY,
    "verify",
    "research-catalog-authority",
    "checklist-research",
    "commit-initialized-baseline",
    "revalidate_catalog",
    "materialize_catalog",
    "skeleton-ready",
    "checklist-skeleton"
  ];
  const expectedNodes = [...expectedTopology].sort();
  if (inputName !== "project" || inputClaim !== "project.discovery_item@1" || nodeKeys.length !== expectedNodes.length || nodeKeys.some((key, index) => key !== expectedNodes[index]) || topology.join("\0") !== expectedTopology.join("\0")) {
    rejectReservedProfile(name, `expected exactly the checklist topology ${expectedTopology.join(" -> ")}`);
  }
  if (!hasOwn(authority.claimTypes, researchClaim) || !hasOwn(authority.claimTypes, researchAuthorityClaim) || !hasOwn(authority.claimTypes, baselineClaim) || !hasOwn(authority.claimTypes, skeletonClaim)) {
    rejectReservedProfile(name, "checklist snapshot and initialized-baseline claims must be declared");
  }
  const exactClaimBindings = (node, expected) => {
    if (claimBindings(resolvedChecks[node]).join("\0") !== expected.map((value) => JSON.stringify(value)).sort().join("\0")) {
      rejectReservedProfile(name, `${node} has unexpected claim bindings`);
    }
  };
  const structural = resolvedChecks.structural_inventory;
  if (structural.type !== PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE || claimList(structural, "consumes").join("\0") !== inputClaim || claimList(structural, "emits").join("\0") !== PROOF_STRUCTURAL_INVENTORY_CLAIM) {
    rejectReservedProfile(name, "checklist structural_inventory must retain the exact Proof inventory binding");
  }
  const inspect = resolvedChecks.inspect;
  if (inspect.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE) rejectReservedProfile(name, "checklist inspect must use the governed project selector");
  validateGovernedInspectConfig(name, inspect, false, false, true);
  if (!isGovernedProofProjectSelector(inspect.invocation)) {
    rejectReservedProfile(name, "checklist project inspect must use the controller-owned project selector");
  }
  if (claimList(inspect, "consumes").join("\0") !== [inputClaim, PROOF_STRUCTURAL_INVENTORY_CLAIM].sort().join("\0") || claimList(inspect, "emits").join("\0") !== PROOF_CANDIDATE_CLAIM) {
    rejectReservedProfile(name, "checklist inspect must consume project and current inventory and emit only candidate");
  }
  const admit = resolvedChecks[PROOF_ADMIT_NODE_KEY];
  if (admit.type !== PROOF_ADMIT_PROVIDER_TYPE || claimList(admit, "consumes").join("\0") !== PROOF_CANDIDATE_CLAIM || claimList(admit, "emits").join("\0") !== PROOF_ADMITTED_RECEIPT_CLAIM) {
    rejectReservedProfile(name, "checklist proof_admit must retain the exact candidate/admission suffix");
  }
  const verify = resolvedChecks.verify;
  if (verify.type === PROOF_ADMIT_PROVIDER_TYPE || claimList(verify, "emits").length !== 0 || claimList(verify, "consumes").join("\0") !== [PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM].sort().join("\0")) {
    rejectReservedProfile(name, "checklist verify must consume candidate and admission and emit none");
  }
  const researchAuthority = resolvedChecks["research-catalog-authority"];
  if (researchAuthority.type !== PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE || claimList(researchAuthority, "emits").join("\0") !== researchAuthorityClaim || claimList(researchAuthority, "consumes").join("\0") !== [PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM].sort().join("\0")) {
    rejectReservedProfile(name, "checklist research-catalog-authority must retain the exact pre-baseline Proof binding");
  }
  const revalidate = resolvedChecks.revalidate_catalog;
  if (revalidate.type !== PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE || claimList(revalidate, "emits").join("\0") !== PROOF_CATALOG_REVALIDATION_CLAIM || claimList(revalidate, "consumes").join("\0") !== [PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM].sort().join("\0")) {
    rejectReservedProfile(name, "checklist revalidate_catalog must retain the exact post-baseline current-catalog binding");
  }
  const research = resolvedChecks["checklist-research"];
  if (research.type !== "command" || claimList(research, "emits").join("\0") !== researchClaim) {
    rejectReservedProfile(name, "checklist-research must be a command emitting one research snapshot");
  }
  exactClaimBindings("checklist-research", [[inputClaim, "project"], [researchAuthorityClaim, "research_authority"]]);
  const baseline = resolvedChecks["commit-initialized-baseline"];
  if (baseline.type !== "command" || claimList(baseline, "emits").join("\0") !== baselineClaim) {
    rejectReservedProfile(name, "commit-initialized-baseline must emit one immutable baseline claim");
  }
  exactClaimBindings("commit-initialized-baseline", [[researchClaim, "research"]]);
  const materialize = resolvedChecks.materialize_catalog;
  if (materialize.type !== PROOF_ADMITTED_CATALOG_PROVIDER_TYPE || claimList(materialize, "emits").join("\0") !== "component.catalog@1" || claimList(materialize, "consumes").join("\0") !== [PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM, PROOF_CATALOG_REVALIDATION_CLAIM].sort().join("\0") || !materialize.expand || materialize.expand.template !== "checklist-onboard-component") {
    rejectReservedProfile(name, "checklist materialize_catalog must retain current Proof catalog egress and named component prefix");
  }
  const skeletonReady = resolvedChecks["skeleton-ready"];
  if (skeletonReady.type !== "noop" || dependencyTokens(skeletonReady, `${name}.skeleton-ready`).join("\0") !== "materialize_catalog" || !skeletonReady.wait_for_expansion || skeletonReady.wait_for_expansion.owner !== "materialize_catalog" || skeletonReady.wait_for_expansion.terminal_node !== "promote-native-component") {
    rejectReservedProfile(name, "skeleton-ready must wait for the exact component promotion terminal");
  }
  const skeleton = resolvedChecks["checklist-skeleton"];
  if (skeleton.type !== "command" || claimList(skeleton, "emits").join("\0") !== skeletonClaim) {
    rejectReservedProfile(name, "checklist-skeleton must be a command emitting one skeleton snapshot");
  }
  exactClaimBindings("checklist-skeleton", [[researchClaim, "research"]]);
  const expectedDependencies = {
    structural_inventory: [],
    inspect: ["structural_inventory"],
    [PROOF_ADMIT_NODE_KEY]: ["inspect"],
    verify: ["inspect", PROOF_ADMIT_NODE_KEY],
    "research-catalog-authority": ["structural_inventory", "inspect", PROOF_ADMIT_NODE_KEY, "verify"],
    "checklist-research": ["research-catalog-authority"],
    "commit-initialized-baseline": ["checklist-research"],
    revalidate_catalog: ["structural_inventory", "inspect", PROOF_ADMIT_NODE_KEY, "checklist-research", "commit-initialized-baseline"],
    materialize_catalog: ["checklist-research", "commit-initialized-baseline", "revalidate_catalog", "structural_inventory", "inspect", PROOF_ADMIT_NODE_KEY],
    "skeleton-ready": ["materialize_catalog"],
    "checklist-skeleton": ["checklist-research", "skeleton-ready"]
  };
  for (const node of expectedTopology) {
    const expected = [...expectedDependencies[node] || []].sort().join("\0");
    if ((dependencies[node] || []).join("\0") !== expected) rejectReservedProfile(name, `checklist profile has unexpected dependencies for ${node}`);
  }
}
function validateChecklistComponentPrefixTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, dependencies, topology, authority) {
  const expectedTopology = [
    "prepare-work-item",
    "role-onboard-component",
    "checkout-target",
    "checkout-worktree",
    "author-native-component",
    "promote-native-component"
  ];
  if (inputName !== "component" || inputClaim !== "component.work_item@1" || nodeKeys.length !== expectedTopology.length || nodeKeys.join("\0") !== [...expectedTopology].sort().join("\0") || topology.join("\0") !== expectedTopology.join("\0")) {
    rejectReservedProfile(name, "checklist component profile requires exactly the six-node prepare/checkout/role/author/promote prefix");
  }
  const expectedDependencies = {
    "prepare-work-item": [],
    "checkout-target": ["prepare-work-item"],
    "checkout-worktree": ["checkout-target"],
    "role-onboard-component": [],
    "author-native-component": ["checkout-worktree", "prepare-work-item", "role-onboard-component"],
    "promote-native-component": ["author-native-component", "checkout-worktree", "prepare-work-item"]
  };
  for (const [nodeKey, expected] of Object.entries(expectedDependencies)) {
    if ((dependencies[nodeKey] || []).join("\0") !== expected.join("\0")) {
      rejectReservedProfile(name, `checklist component profile has unexpected dependencies for ${nodeKey}`);
    }
  }
  const expectedClaims = {
    "prepare-work-item": { type: "command", consumes: [["component.work_item@1", "component"]], emits: "component.prepared_work_item@1" },
    "checkout-target": { type: "command", consumes: [["component.prepared_work_item@1", "work_item"]], emits: "component.checkout_target@1" },
    "checkout-worktree": { type: "git-checkout", consumes: [["component.checkout_target@1", "target"]], emits: "component.checkout@1" },
    "role-onboard-component": { type: "command", consumes: [["component.work_item@1", "component"]], emits: "native.role.onboard@1" },
    "author-native-component": { type: "ai", consumes: [
      ["component.prepared_work_item@1", "work_item"],
      ["component.checkout@1", "checkout"],
      ["native.role.onboard@1", "role"]
    ], emits: "native.author.evidence@1" },
    "promote-native-component": { type: "command", consumes: [
      ["component.prepared_work_item@1", "work_item"],
      ["component.checkout@1", "checkout"],
      ["native.author.evidence@1", "author"]
    ], emits: "native.promotion@1" }
  };
  for (const [nodeKey, expected] of Object.entries(expectedClaims)) {
    const check = resolvedChecks[nodeKey];
    if (!check || check.type !== expected.type || claimBindings(check).join("\0") !== expected.consumes.map((value) => JSON.stringify(value)).sort().join("\0") || claimList(check, "emits").join("\0") !== expected.emits) {
      rejectReservedProfile(name, `${nodeKey} is not the exact checklist component prefix node`);
    }
  }
  if (Object.values(resolvedChecks).some((check) => check.type === PROOF_ADMIT_PROVIDER_TYPE || check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE || claimList(check, "emits").some((claim2) => claim2 === PROOF_ADMITTED_RECEIPT_CLAIM || claim2 === PROOF_CANDIDATE_CLAIM) || claimList(check, "consumes").some((claim2) => claim2 === PROOF_ADMITTED_RECEIPT_CLAIM || claim2 === PROOF_CANDIDATE_CLAIM))) {
    rejectReservedProfile(name, "checklist component prefix cannot contain Proof admission or governed inspection nodes");
  }
  if (!hasOwn(authority.claimTypes, "native.promotion@1")) {
    rejectReservedProfile(name, "checklist component prefix requires the shipped native promotion claim declaration");
  }
}
function validateNativeRetainedComponentAdmissionTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, consumptionsByNode, dependencies, topology, authority) {
  const reviewedClaim = "native.component.reviewed@1";
  const expectedTopology = ["component-reviewed", "native-validation", "inspect", PROOF_ADMIT_NODE_KEY, "spec_review", "spec_review_admit", "verify"];
  const expectedNodes = [...expectedTopology].sort();
  if (inputName !== "component" || inputClaim !== "component.work_item@1" || !hasOwn(authority.claimTypes, reviewedClaim)) {
    rejectReservedProfile(name, "retained native component profile requires the component WorkItem input and reviewed claim declaration");
  }
  if (nodeKeys.length !== expectedNodes.length || nodeKeys.some((key, index) => key !== expectedNodes[index]) || topology.join("\0") !== expectedTopology.join("\0")) {
    rejectReservedProfile(name, "retained native component profile requires exactly the named retained prefix and admission suffix");
  }
  const dependenciesByNode = {
    "component-reviewed": [],
    "native-validation": ["component-reviewed"],
    inspect: ["component-reviewed", "native-validation"],
    [PROOF_ADMIT_NODE_KEY]: ["inspect"],
    spec_review: ["inspect", PROOF_ADMIT_NODE_KEY],
    spec_review_admit: ["spec_review"],
    verify: ["inspect", PROOF_ADMIT_NODE_KEY, "spec_review", "spec_review_admit"]
  };
  for (const [nodeKey, expected] of Object.entries(dependenciesByNode)) {
    if (dependencies[nodeKey]?.join("\0") !== expected.join("\0")) {
      rejectReservedProfile(name, `retained native component profile has unexpected dependencies for ${nodeKey}`);
    }
  }
  const reviewed = resolvedChecks["component-reviewed"];
  const retainedMapLiteral = reviewed && reviewed.type === "command" && typeof reviewed.exec === "string" ? [...reviewed.exec.matchAll(/const encoded = '([^']*)';/g)].map((match) => match[1]) : [];
  const retainedMapEncoding = retainedMapLiteral.length === 1 ? retainedMapLiteral[0] : void 0;
  const retainedMapIsCanonical = retainedMapEncoding === "__NATIVE_RETAINED_AGGREGATE_MAP_BASE64__" || (() => {
    if (!retainedMapEncoding || !/^[A-Za-z0-9+/]+={0,2}$/.test(retainedMapEncoding)) return false;
    try {
      return Buffer.from(retainedMapEncoding, "base64").length > 0 && Buffer.from(retainedMapEncoding, "base64").toString("base64") === retainedMapEncoding;
    } catch {
      return false;
    }
  })();
  const reviewedTransportKeys = ["stdin", "env", "transform", "transform_js", "content", "url", "body", "headers", "tools", "tools_js", "mcp_servers", "enable_fetch", "enable_bash"];
  const reviewedHasTransportOverride = reviewed && reviewedTransportKeys.some((key) => Object.prototype.hasOwnProperty.call(reviewed, key));
  if (!reviewed || reviewed.type !== "command" || claimBindings(reviewed).join("\0") !== JSON.stringify(["component.work_item@1", "component"]) || claimList(reviewed, "emits").join("\0") !== reviewedClaim || typeof reviewed.exec !== "string" || retainedMapLiteral.length !== 1 || !retainedMapIsCanonical || reviewedHasTransportOverride) {
    rejectReservedProfile(name, "retained component-reviewed must consume the current WorkItem and one runner-bound aggregate map");
  }
  const inspect = resolvedChecks.inspect;
  if (inspect.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE || !isGovernedProofComponentSelector(inspect.invocation)) {
    rejectReservedProfile(name, "retained native component inspect must use the builtin component selector");
  }
  validateGovernedInspectConfig(name, inspect, true);
  if (claimBindings(inspect).join("\0") !== [
    ["component.work_item@1", "component"],
    [reviewedClaim, "reviewed"]
  ].map((value) => JSON.stringify(value)).sort().join("\0") || claimList(inspect, "emits").join("\0") !== PROOF_CANDIDATE_CLAIM) {
    rejectReservedProfile(name, "retained native component inspect must consume exactly WorkItem and reviewed aggregate parents");
  }
  const nativeValidation = resolvedChecks["native-validation"];
  if (nativeValidation.type !== "command" || claimBindings(nativeValidation).join("\0") !== [
    ["component.work_item@1", "component"],
    [reviewedClaim, "reviewed"]
  ].map((value) => JSON.stringify(value)).sort().join("\0") || claimList(nativeValidation, "emits").join("\0") !== "native.component.summary@1") {
    rejectReservedProfile(name, "retained native-validation must consume the exact WorkItem/reviewed parents and emit the component summary");
  }
  const proofAdmit = resolvedChecks[PROOF_ADMIT_NODE_KEY];
  if (proofAdmit.type !== PROOF_ADMIT_PROVIDER_TYPE || claimBindings(proofAdmit).join("\0") !== JSON.stringify([PROOF_CANDIDATE_CLAIM, "candidate"]) || claimList(proofAdmit, "emits").join("\0") !== PROOF_ADMITTED_RECEIPT_CLAIM) {
    rejectReservedProfile(name, "retained native component proof_admit bindings are not exact");
  }
  const specReview = resolvedChecks.spec_review;
  if (specReview.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE || !isGovernedProofSpecReviewSelector(specReview.invocation)) rejectReservedProfile(name, "retained native component spec_review must use the builtin spec-review selector");
  validateGovernedInspectConfig(name, specReview, false, true);
  if (claimBindings(specReview).join("\0") !== [
    ["component.work_item@1", "component"],
    [PROOF_CANDIDATE_CLAIM, "candidate"],
    [PROOF_ADMITTED_RECEIPT_CLAIM, "admission"]
  ].map((value) => JSON.stringify(value)).sort().join("\0") || claimList(specReview, "emits").join("\0") !== PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM) rejectReservedProfile(name, "retained native component spec_review bindings are not exact");
  const specReviewAdmit = resolvedChecks.spec_review_admit;
  if (specReviewAdmit.type !== PROOF_ADMIT_PROVIDER_TYPE || claimBindings(specReviewAdmit).join("\0") !== JSON.stringify([PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, "candidate"]) || claimList(specReviewAdmit, "emits").join("\0") !== PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM) rejectReservedProfile(name, "retained native component spec_review_admit bindings are not exact");
  const verify = resolvedChecks.verify;
  if (verify.type === PROOF_ADMIT_PROVIDER_TYPE || claimList(verify, "emits").length !== 0 || claimBindings(verify).join("\0") !== [
    [PROOF_CANDIDATE_CLAIM, "candidate"],
    [PROOF_ADMITTED_RECEIPT_CLAIM, "receipt"],
    [PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, "spec_candidate"],
    [PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM, "spec_receipt"]
  ].map((value) => JSON.stringify(value)).sort().join("\0")) rejectReservedProfile(name, "retained native component verify bindings are not exact");
  if (consumptionsByNode[PROOF_ADMIT_NODE_KEY].length !== 1 || consumptionsByNode.spec_review_admit.length !== 1) rejectReservedProfile(name, "retained native component admission consumers are not singular");
}
function validateNativeReviewedComponentAdmissionTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, consumptionsByNode, dependencies, topology, authority) {
  const reviewedClaim = "native.component.reviewed@1";
  const suffix = ["inspect", PROOF_ADMIT_NODE_KEY, "spec_review", "spec_review_admit", "verify"];
  const liveTopology = [
    "prepare-work-item",
    "role-onboard-component",
    "role-spec-review-component",
    "checkout-target",
    "checkout-worktree",
    "author-native-component",
    "promote-native-component",
    "enumerate-native-requirements",
    "wait-for-native-items",
    "component-reviewed",
    "native-validation",
    ...suffix
  ];
  const liveDependencies = {
    "prepare-work-item": [],
    "role-onboard-component": [],
    "role-spec-review-component": [],
    "checkout-target": ["prepare-work-item"],
    "checkout-worktree": ["checkout-target"],
    "author-native-component": ["checkout-worktree", "prepare-work-item", "role-onboard-component"],
    "promote-native-component": ["author-native-component", "checkout-worktree", "prepare-work-item"],
    "enumerate-native-requirements": ["author-native-component", "prepare-work-item", "promote-native-component", "role-spec-review-component"],
    "wait-for-native-items": ["enumerate-native-requirements"],
    "component-reviewed": ["enumerate-native-requirements", "prepare-work-item", "wait-for-native-items"],
    "native-validation": ["component-reviewed"]
  };
  if (inputName !== "component" || inputClaim !== "component.work_item@1" || !hasOwn(authority.claimTypes, reviewedClaim)) {
    rejectReservedProfile(name, "native reviewed component profile requires the component WorkItem input and reviewed claim declaration");
  }
  if (nodeKeys.join("\0") !== [...liveTopology].sort().join("\0") || topology.join("\0") !== liveTopology.join("\0")) {
    rejectReservedProfile(name, "native reviewed component profile requires the complete named live onboarding topology");
  }
  for (const nodeKey of suffix) if (!hasOwn(resolvedChecks, nodeKey)) rejectReservedProfile(name, `native reviewed component profile is missing ${nodeKey}`);
  for (const [nodeKey, expected] of Object.entries(liveDependencies)) {
    if (dependencies[nodeKey]?.join("\0") !== expected.join("\0")) rejectReservedProfile(name, `native reviewed component profile has unexpected dependencies for ${nodeKey}`);
  }
  const prefixExpectations = {
    "prepare-work-item": { type: "command", consumes: ["component.work_item@1"], emits: ["component.prepared_work_item@1"] },
    "checkout-target": { type: "command", consumes: ["component.prepared_work_item@1"], emits: ["component.checkout_target@1"] },
    "checkout-worktree": { type: "git-checkout", consumes: ["component.checkout_target@1"], emits: ["component.checkout@1"] },
    "role-onboard-component": { type: "command", consumes: ["component.work_item@1"], emits: ["native.role.onboard@1"] },
    "author-native-component": { type: "ai", consumes: ["component.checkout@1", "component.prepared_work_item@1", "native.role.onboard@1"], emits: ["native.author.evidence@1"] },
    "promote-native-component": { type: "command", consumes: ["component.checkout@1", "component.prepared_work_item@1", "native.author.evidence@1"], emits: ["native.promotion@1"] },
    "role-spec-review-component": { type: "command", consumes: ["component.work_item@1"], emits: ["native.role.spec_review@1"] },
    "enumerate-native-requirements": { type: "command", consumes: ["component.prepared_work_item@1", "native.author.evidence@1", "native.promotion@1", "native.role.spec_review@1"], emits: ["native.requirement.catalog@1"] },
    "wait-for-native-items": { type: "noop", consumes: [], emits: [] },
    "component-reviewed": { type: "command", consumes: ["component.prepared_work_item@1", "native.requirement.catalog@1"], emits: [reviewedClaim] },
    "native-validation": { type: "command", consumes: ["component.work_item@1", reviewedClaim], emits: ["native.component.summary@1"] }
  };
  for (const [nodeKey, expected] of Object.entries(prefixExpectations)) {
    const check = resolvedChecks[nodeKey];
    if (!check || check.type !== expected.type || claimList(check, "consumes").join("\0") !== [...expected.consumes].sort().join("\0") || claimList(check, "emits").join("\0") !== [...expected.emits].sort().join("\0")) {
      rejectReservedProfile(name, `${nodeKey} is not the exact native onboarding prefix node`);
    }
  }
  const wait = resolvedChecks["wait-for-native-items"];
  if (!wait || !wait.wait_for_expansion || !hasExactKeys(wait.wait_for_expansion, ["owner", "terminal_node"]) || wait.wait_for_expansion.owner !== "enumerate-native-requirements" || wait.wait_for_expansion.terminal_node !== "collect-proof-evidence") {
    rejectReservedProfile(name, "wait-for-native-items must be the sole native requirement expansion barrier");
  }
  const requirementExpansion = resolvedChecks["enumerate-native-requirements"].expand;
  if (!requirementExpansion || typeof requirementExpansion !== "object" || Array.isArray(requirementExpansion) || !hasExactKeys(requirementExpansion, ["claim", "template", "items_pointer", "key_pointer", "item_claim"]) || requirementExpansion.claim !== "native.requirement.catalog@1" || requirementExpansion.template !== "native-requirement-review" || requirementExpansion.items_pointer !== "/items" || requirementExpansion.key_pointer !== "/id" || requirementExpansion.item_claim !== "native.requirement.item@1") {
    rejectReservedProfile(name, "enumerate-native-requirements must own the exact native requirement expansion");
  }
  const inspect = resolvedChecks.inspect;
  if (inspect.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE || !isGovernedProofComponentSelector(inspect.invocation)) {
    rejectReservedProfile(name, "native reviewed component inspect must use the builtin component selector");
  }
  validateGovernedInspectConfig(name, inspect, true);
  if (claimBindings(inspect).join("\0") !== [
    ["component.work_item@1", "component"],
    [reviewedClaim, "reviewed"]
  ].map((value) => JSON.stringify(value)).sort().join("\0") || claimList(inspect, "emits").join("\0") !== PROOF_CANDIDATE_CLAIM) {
    rejectReservedProfile(name, "native reviewed component inspect must consume exactly WorkItem and reviewed aggregate parents");
  }
  const nativeValidation = resolvedChecks["native-validation"];
  if (!nativeValidation || claimBindings(nativeValidation).join("\0") !== [
    ["component.work_item@1", "component"],
    [reviewedClaim, "reviewed"]
  ].map((value) => JSON.stringify(value)).sort().join("\0") || claimList(nativeValidation, "emits").join("\0") !== "native.component.summary@1") {
    rejectReservedProfile(name, "native-validation must consume the exact WorkItem/reviewed parents and emit the component summary");
  }
  const reviewedProducer = resolvedChecks["component-reviewed"];
  if (!reviewedProducer || claimList(reviewedProducer, "emits").join("\0") !== reviewedClaim) {
    rejectReservedProfile(name, "component-reviewed must be the sole reviewed aggregate producer");
  }
  const proofAdmit = resolvedChecks[PROOF_ADMIT_NODE_KEY];
  if (proofAdmit.type !== PROOF_ADMIT_PROVIDER_TYPE || claimBindings(proofAdmit).join("\0") !== JSON.stringify([PROOF_CANDIDATE_CLAIM, "candidate"]) || claimList(proofAdmit, "emits").join("\0") !== PROOF_ADMITTED_RECEIPT_CLAIM) {
    rejectReservedProfile(name, "native reviewed component proof_admit bindings are not exact");
  }
  const expectedDependencies = {
    inspect: ["component-reviewed", "native-validation"],
    [PROOF_ADMIT_NODE_KEY]: ["inspect"],
    spec_review: ["inspect", PROOF_ADMIT_NODE_KEY],
    spec_review_admit: ["spec_review"],
    verify: ["inspect", PROOF_ADMIT_NODE_KEY, "spec_review", "spec_review_admit"]
  };
  for (const [nodeKey, expected] of Object.entries(expectedDependencies)) {
    if (dependencies[nodeKey]?.join("\0") !== expected.join("\0")) rejectReservedProfile(name, `native reviewed component profile has unexpected dependencies for ${nodeKey}`);
  }
  const specReview = resolvedChecks.spec_review;
  if (specReview.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE || !isGovernedProofSpecReviewSelector(specReview.invocation)) rejectReservedProfile(name, "native reviewed component spec_review must use the builtin spec-review selector");
  validateGovernedInspectConfig(name, specReview, false, true);
  if (claimBindings(specReview).join("\0") !== [
    ["component.work_item@1", "component"],
    [PROOF_CANDIDATE_CLAIM, "candidate"],
    [PROOF_ADMITTED_RECEIPT_CLAIM, "admission"]
  ].map((value) => JSON.stringify(value)).sort().join("\0") || claimList(specReview, "emits").join("\0") !== PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM) rejectReservedProfile(name, "native reviewed component spec_review bindings are not exact");
  const specReviewAdmit = resolvedChecks.spec_review_admit;
  if (specReviewAdmit.type !== PROOF_ADMIT_PROVIDER_TYPE || claimBindings(specReviewAdmit).join("\0") !== JSON.stringify([PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, "candidate"]) || claimList(specReviewAdmit, "emits").join("\0") !== PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM) rejectReservedProfile(name, "native reviewed component spec_review_admit bindings are not exact");
  const verify = resolvedChecks.verify;
  if (verify.type === PROOF_ADMIT_PROVIDER_TYPE || claimList(verify, "emits").length !== 0 || claimBindings(verify).join("\0") !== [
    [PROOF_CANDIDATE_CLAIM, "candidate"],
    [PROOF_ADMITTED_RECEIPT_CLAIM, "receipt"],
    [PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, "spec_candidate"],
    [PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM, "spec_receipt"]
  ].map((value) => JSON.stringify(value)).sort().join("\0")) rejectReservedProfile(name, "native reviewed component verify bindings are not exact");
  if (consumptionsByNode[PROOF_ADMIT_NODE_KEY].length !== 1 || consumptionsByNode.spec_review_admit.length !== 1) rejectReservedProfile(name, "native reviewed component admission consumers are not singular");
}
function validateReservedProofAdmissionTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, consumptionsByNode, dependencies, topology, authority) {
  const stagedClaims = [PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM];
  const reservedClaims = [PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM, PROOF_CATALOG_REVALIDATION_CLAIM, PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM, ...stagedClaims];
  const staged = nodeKeys.includes("spec_review") || nodeKeys.includes("spec_review_admit") || stagedClaims.some((claim2) => nodeKeys.some((nodeKey) => claimList(resolvedChecks[nodeKey], "emits").includes(claim2) || claimList(resolvedChecks[nodeKey], "consumes").includes(claim2)));
  const triggered = staged || nodeKeys.some((nodeKey) => {
    const check = resolvedChecks[nodeKey];
    return check.type === PROOF_ADMIT_PROVIDER_TYPE || check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE || check.type === PROOF_ADMITTED_CATALOG_PROVIDER_TYPE || check.type === PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE || check.type === PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE || check.type === PROOF_PROJECT_RECONCILE_PROVIDER_TYPE || claimList(check, "emits").some(
      (claim2) => reservedClaims.includes(claim2)
    ) || claimList(check, "consumes").some(
      (claim2) => reservedClaims.includes(claim2)
    );
  });
  const nativeRetainedName = name === RETAINED_COMPONENT_TEMPLATE_NAME;
  const nativeLiveName = name === "onboard-component" && inputClaim === "component.work_item@1" && nodeKeys.includes("prepare-work-item");
  if ((nativeRetainedName || nativeLiveName) && !triggered) {
    rejectReservedProfile(name, "reserved native component profile is missing its governed admission suffix");
  }
  if (name === "discover-project-checklist") {
    validateChecklistProjectTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, consumptionsByNode, dependencies, topology, authority);
    return;
  }
  if (name === "checklist-onboard-component") {
    validateChecklistComponentPrefixTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, dependencies, topology, authority);
    return;
  }
  if (!triggered) return;
  const nativeReviewed = resolvedChecks.inspect !== void 0 && reviewedComponentSelectorTemplateBindingAllowed(
    inputName,
    inputClaim,
    resolvedChecks.inspect
  );
  if ((nativeRetainedName || nativeLiveName) && !nativeReviewed) {
    rejectReservedProfile(name, "reserved native component profile must use the exact reviewed component selector");
  }
  if (nativeReviewed) {
    if (nativeRetainedName) {
      validateNativeRetainedComponentAdmissionTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, consumptionsByNode, dependencies, topology, authority);
    } else {
      validateNativeReviewedComponentAdmissionTemplate(name, inputName, inputClaim, nodeKeys, resolvedChecks, consumptionsByNode, dependencies, topology, authority);
    }
    return;
  }
  if (!hasOwn(authority.claimTypes, PROOF_CANDIDATE_CLAIM)) {
    rejectReservedProfile(name, `missing ${PROOF_CANDIDATE_CLAIM} declaration`);
  }
  if (!hasOwn(authority.claimTypes, PROOF_ADMITTED_RECEIPT_CLAIM)) {
    rejectReservedProfile(name, `missing ${PROOF_ADMITTED_RECEIPT_CLAIM} declaration`);
  }
  if (staged) {
    for (const claim2 of stagedClaims) if (!hasOwn(authority.claimTypes, claim2)) rejectReservedProfile(name, `missing ${claim2} declaration`);
  }
  if (reservedClaims.includes(inputClaim)) {
    rejectReservedProfile(name, "a reserved claim cannot be the template input");
  }
  const hasCatalogEgress = nodeKeys.includes("revalidate_catalog") || nodeKeys.includes("materialize_catalog");
  if (staged && hasCatalogEgress) rejectReservedProfile(name, "staged component profile cannot use catalog egress");
  if (staged && (inputName !== "component" || inputClaim !== "component.work_item@1")) rejectReservedProfile(name, "staged component profile requires the component work item input");
  const hasProjectReconciliation = nodeKeys.includes(PROOF_PROJECT_RECONCILE_NODE_KEY);
  const expectedNodes = hasCatalogEgress ? [
    "structural_inventory",
    "inspect",
    PROOF_ADMIT_NODE_KEY,
    "verify",
    "revalidate_catalog",
    "materialize_catalog",
    ...hasProjectReconciliation ? [PROOF_PROJECT_RECONCILE_NODE_KEY] : []
  ] : staged ? ["inspect", PROOF_ADMIT_NODE_KEY, "spec_review", "spec_review_admit", "verify"] : ["inspect", PROOF_ADMIT_NODE_KEY, "verify"];
  const expectedNodeKeys = [...expectedNodes].sort();
  if (nodeKeys.length !== expectedNodeKeys.length || nodeKeys.some((key, index) => key !== expectedNodeKeys[index])) {
    rejectReservedProfile(name, `expected exactly the nodes ${expectedNodes.join(", ")}`);
  }
  if (topology.join("\0") !== expectedNodes.join("\0")) {
    rejectReservedProfile(name, `expected topology ${expectedNodes.join(" -> ")}`);
  }
  for (const nodeKey of nodeKeys) {
    const check = resolvedChecks[nodeKey];
    if (hasOwn(check, "expand") && nodeKey !== "materialize_catalog") rejectReservedProfile(name, `${nodeKey} cannot use check.expand`);
    const admissionNode = nodeKey === PROOF_ADMIT_NODE_KEY || staged && nodeKey === "spec_review_admit";
    if (!admissionNode && check.type === PROOF_ADMIT_PROVIDER_TYPE) {
      rejectReservedProfile(name, `provider type ${PROOF_ADMIT_PROVIDER_TYPE} is only valid at ${PROOF_ADMIT_NODE_KEY}`);
    }
  }
  const inspect = resolvedChecks.inspect;
  if (inspect.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE) {
    rejectReservedProfile(name, `inspect must have type ${GOVERNED_PROOF_INSPECT_PROVIDER_TYPE}`);
  }
  validateGovernedInspectConfig(name, inspect, componentSelectorTemplateBindingAllowed(inputName, inputClaim, inspect));
  if (claimList(inspect, "emits").join("\0") !== PROOF_CANDIDATE_CLAIM) {
    rejectReservedProfile(name, `inspect must emit only ${PROOF_CANDIDATE_CLAIM}`);
  }
  const inspectInputs = claimList(inspect, "consumes");
  const expectedInspectInputs = hasCatalogEgress ? [inputClaim, PROOF_STRUCTURAL_INVENTORY_CLAIM].sort() : inspectInputs.includes(PROOF_ROLE_AUTHORITY_CLAIM) ? [inputClaim, PROOF_ROLE_AUTHORITY_CLAIM].sort() : [inputClaim];
  if (inspectInputs.length !== expectedInspectInputs.length || inspectInputs.some((claim2, index) => claim2 !== expectedInspectInputs[index])) {
    rejectReservedProfile(name, `inspect must consume the template input claim and, when present, ${PROOF_ROLE_AUTHORITY_CLAIM}`);
  }
  const proofAdmit = resolvedChecks[PROOF_ADMIT_NODE_KEY];
  if (proofAdmit.type !== PROOF_ADMIT_PROVIDER_TYPE) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must have type ${PROOF_ADMIT_PROVIDER_TYPE}`);
  }
  if (claimList(proofAdmit, "emits").join("\0") !== PROOF_ADMITTED_RECEIPT_CLAIM) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must emit only ${PROOF_ADMITTED_RECEIPT_CLAIM}`);
  }
  if (claimList(proofAdmit, "consumes").join("\0") !== PROOF_CANDIDATE_CLAIM) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must consume only ${PROOF_CANDIDATE_CLAIM}`);
  }
  if (staged) {
    const expectedDependencies = {
      inspect: [],
      [PROOF_ADMIT_NODE_KEY]: ["inspect"],
      spec_review: ["inspect", PROOF_ADMIT_NODE_KEY],
      spec_review_admit: ["spec_review"],
      verify: ["inspect", PROOF_ADMIT_NODE_KEY, "spec_review", "spec_review_admit"]
    };
    for (const [nodeKey, expected] of Object.entries(expectedDependencies)) {
      if (dependencies[nodeKey]?.join("\0") !== expected.join("\0")) rejectReservedProfile(name, `staged profile has unexpected dependencies for ${nodeKey}`);
    }
    const specReview = resolvedChecks.spec_review;
    if (specReview.type !== GOVERNED_PROOF_INSPECT_PROVIDER_TYPE) rejectReservedProfile(name, "spec_review must use the governed Proof inspect provider");
    if (!isGovernedProofSpecReviewSelector(specReview.invocation)) rejectReservedProfile(name, "spec_review must use the builtin spec-review component invocation selector");
    validateGovernedInspectConfig(name, specReview, false, true);
    if (claimList(specReview, "emits").join("\0") !== PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM) rejectReservedProfile(name, `spec_review must emit only ${PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM}`);
    if (claimBindings(specReview).join("\0") !== [
      ["component.work_item@1", "component"],
      [PROOF_CANDIDATE_CLAIM, "candidate"],
      [PROOF_ADMITTED_RECEIPT_CLAIM, "admission"]
    ].map((value) => JSON.stringify(value)).sort().join("\0")) rejectReservedProfile(name, "spec_review must consume the component work item, original candidate, and admission with exact bindings");
    const specReviewAdmit = resolvedChecks.spec_review_admit;
    if (specReviewAdmit.type !== PROOF_ADMIT_PROVIDER_TYPE) rejectReservedProfile(name, `spec_review_admit must have type ${PROOF_ADMIT_PROVIDER_TYPE}`);
    if (claimList(specReviewAdmit, "emits").join("\0") !== PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM) rejectReservedProfile(name, `spec_review_admit must emit only ${PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM}`);
    if (claimBindings(specReviewAdmit).join("\0") !== JSON.stringify([PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, "candidate"])) rejectReservedProfile(name, `spec_review_admit must consume only ${PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM} as candidate`);
  }
  const verify = resolvedChecks.verify;
  if (verify.type === PROOF_ADMIT_PROVIDER_TYPE) {
    rejectReservedProfile(name, "verify cannot use the proof admission provider");
  }
  if (claimList(verify, "emits").length !== 0 || (staged ? claimBindings(verify).join("\0") !== [
    [PROOF_CANDIDATE_CLAIM, "candidate"],
    [PROOF_ADMITTED_RECEIPT_CLAIM, "receipt"],
    [PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, "spec_candidate"],
    [PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM, "spec_receipt"]
  ].map((value) => JSON.stringify(value)).sort().join("\0") : claimList(verify, "consumes").join("\0") !== [PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM].sort().join("\0"))) {
    rejectReservedProfile(name, staged ? "verify must consume both candidate/admission pairs and emit none" : "verify must consume both reserved claims and emit none");
  }
  if (consumptionsByNode[PROOF_ADMIT_NODE_KEY].length !== 1) {
    rejectReservedProfile(name, `${PROOF_ADMIT_NODE_KEY} must have exactly one candidate consumer`);
  }
  if (hasCatalogEgress) {
    if (!hasOwn(authority.claimTypes, PROOF_STRUCTURAL_INVENTORY_CLAIM)) {
      rejectReservedProfile(name, `missing ${PROOF_STRUCTURAL_INVENTORY_CLAIM} declaration`);
    }
    if (!hasOwn(resolvedChecks, "revalidate_catalog") || !hasOwn(resolvedChecks, "materialize_catalog")) {
      rejectReservedProfile(name, "catalog egress requires both revalidate_catalog and materialize_catalog");
    }
    const structuralInventory = resolvedChecks.structural_inventory;
    if (structuralInventory.type !== PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE) {
      rejectReservedProfile(name, `structural_inventory must have type ${PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE}`);
    }
    validateCatalogEgressConfig(name, "structural_inventory", structuralInventory, ["type", "consumes", "emits"]);
    if (claimList(structuralInventory, "consumes").join("\0") !== inputClaim || claimList(structuralInventory, "emits").join("\0") !== PROOF_STRUCTURAL_INVENTORY_CLAIM) {
      rejectReservedProfile(name, "structural_inventory must consume the template input and emit only the current Proof inventory");
    }
    if (resolvedChecks.revalidate_catalog.type !== PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE) {
      rejectReservedProfile(name, `revalidate_catalog must have type ${PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE}`);
    }
    validateCatalogEgressConfig(name, "revalidate_catalog", resolvedChecks.revalidate_catalog, [
      "type",
      "depends_on",
      "consumes",
      "emits"
    ]);
    if (claimList(resolvedChecks.revalidate_catalog, "emits").join("\0") !== PROOF_CATALOG_REVALIDATION_CLAIM) {
      rejectReservedProfile(name, `revalidate_catalog must emit only ${PROOF_CATALOG_REVALIDATION_CLAIM}`);
    }
    if (claimList(resolvedChecks.revalidate_catalog, "consumes").join("\0") !== [PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM].sort().join("\0")) {
      rejectReservedProfile(name, "revalidate_catalog must consume the template input, candidate, and admission receipt");
    }
    const materialize = resolvedChecks.materialize_catalog;
    if (materialize.type !== PROOF_ADMITTED_CATALOG_PROVIDER_TYPE) {
      rejectReservedProfile(name, `materialize_catalog must have type ${PROOF_ADMITTED_CATALOG_PROVIDER_TYPE}`);
    }
    validateCatalogEgressConfig(name, "materialize_catalog", materialize, [
      "type",
      "consumes",
      "emits",
      "expand"
    ]);
    if (!materialize.expand || typeof materialize.expand !== "object" || Array.isArray(materialize.expand)) {
      rejectReservedProfile(name, "materialize_catalog must own a downstream expansion");
    }
    if (claimList(materialize, "emits").length !== 1 || claimList(materialize, "emits")[0] === PROOF_CANDIDATE_CLAIM || claimList(materialize, "emits")[0] === PROOF_ADMITTED_RECEIPT_CLAIM || claimList(materialize, "emits")[0] === PROOF_CATALOG_REVALIDATION_CLAIM) {
      rejectReservedProfile(name, "materialize_catalog must emit exactly one non-reserved catalog claim");
    }
    if (claimList(materialize, "consumes").join("\0") !== [PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM, PROOF_CATALOG_REVALIDATION_CLAIM].sort().join("\0")) {
      rejectReservedProfile(name, "materialize_catalog must consume the template input, candidate, admission receipt, and current revalidation");
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
        "type",
        "depends_on",
        "wait_for_expansion",
        "emits"
      ]);
      const dependencies2 = dependencyTokens(
        reconciliation,
        `${name}.${PROOF_PROJECT_RECONCILE_NODE_KEY}`
      );
      if (dependencies2.length !== 1 || dependencies2[0] !== "materialize_catalog") {
        rejectReservedProfile(
          name,
          `${PROOF_PROJECT_RECONCILE_NODE_KEY} must depend only on materialize_catalog`
        );
      }
      if (claimList(reconciliation, "emits").join("\0") !== PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM) {
        rejectReservedProfile(
          name,
          `${PROOF_PROJECT_RECONCILE_NODE_KEY} must emit only ${PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM}`
        );
      }
      const wait = reconciliation.wait_for_expansion;
      if (!wait || typeof wait !== "object" || Array.isArray(wait) || !hasExactKeys(wait, ["owner", "terminal_node"]) || wait.owner !== "materialize_catalog" || wait.terminal_node !== "verify") {
        rejectReservedProfile(
          name,
          `${PROOF_PROJECT_RECONCILE_NODE_KEY} must wait for materialize_catalog terminal verify`
        );
      }
    }
  }
}
function topologicalOrder(templateName, dependencies) {
  const remaining = new Map(
    Object.entries(dependencies).map(([node, values]) => [node, new Set(values)])
  );
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, values]) => values.size === 0).map(([node]) => node).sort();
    if (ready.length === 0) {
      throw new InstancePlanError(
        "TEMPLATE_CYCLE",
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
function compileTemplate(name, authored, authority) {
  if (!authored || typeof authored !== "object" || Array.isArray(authored)) {
    throw new InstancePlanError("INVALID_SUBGRAPH_TEMPLATE", `Subgraph "${name}" must be an object`);
  }
  const inputName = requireNonEmptyString(authored.input?.name, `subgraphs.${name}.input.name`);
  if (!BINDING_NAME_PATTERN.test(inputName)) {
    throw new InstancePlanError(
      "INVALID_TEMPLATE_BINDING",
      `Subgraph "${name}" input name "${inputName}" is not a canonical binding name`
    );
  }
  const inputClaim = requireNonEmptyString(
    authored.input?.claim,
    `subgraphs.${name}.input.claim`
  );
  if (!CLAIM_REF_PATTERN.test(inputClaim) || !hasOwn(authority.claimTypes, inputClaim)) {
    throw new InstancePlanError(
      "UNKNOWN_TEMPLATE_CLAIM",
      `Subgraph "${name}" references undeclared input claim "${inputClaim}"`
    );
  }
  if (!authored.checks || typeof authored.checks !== "object" || Array.isArray(authored.checks)) {
    throw new InstancePlanError(
      "INVALID_SUBGRAPH_TEMPLATE",
      `Subgraph "${name}" requires a checks map`
    );
  }
  const nodeKeys = Object.keys(authored.checks).sort();
  if (nodeKeys.length === 0 || nodeKeys.some((node) => node.length === 0)) {
    throw new InstancePlanError(
      "INVALID_SUBGRAPH_TEMPLATE",
      `Subgraph "${name}" requires at least one named check`
    );
  }
  const resolvedChecks = {};
  const emitterByClaim = {};
  const consumptionsByNode = {};
  let consumesTemplateInput = false;
  for (const nodeKey of nodeKeys) {
    const check = authored.checks[nodeKey];
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new InstancePlanError(
        "INVALID_TEMPLATE_CHECK",
        `Template check "${name}.${nodeKey}" must be an object`
      );
    }
    if (check.forEach || check.type === "workflow" || hasRouting(check)) {
      throw new InstancePlanError(
        "UNSUPPORTED_TEMPLATE_EXECUTION",
        `Template check "${name}.${nodeKey}" cannot use forEach, workflow, or lifecycle routing`
      );
    }
    if (check.resource_group !== void 0 && (typeof check.resource_group !== "string" || !RESOURCE_GROUP_PATTERN.test(check.resource_group))) {
      throw new InstancePlanError(
        "INVALID_RESOURCE_GROUP",
        `Template check "${name}.${nodeKey}" resource_group must be a non-empty safe token of at most 64 characters`
      );
    }
    if (check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE) {
      validateGovernedInspectConfig(
        name,
        check,
        componentSelectorTemplateBindingAllowed(inputName, inputClaim, check) || reviewedComponentSelectorTemplateBindingAllowed(inputName, inputClaim, check),
        nodeKey === "spec_review",
        name === "discover-project-checklist" && nodeKey === "inspect"
      );
    }
    for (const field of ["emits", "consumes"]) {
      if (hasOwn(check, field) && (!Array.isArray(check[field]) || check[field].length === 0)) {
        throw new InstancePlanError(
          "EMPTY_TEMPLATE_CLAIM_DECLARATION",
          `Template check "${name}.${nodeKey}" declares ${field}, which must be a non-empty array`
        );
      }
    }
    const resolved = resolvedTemplateCheck(check);
    const seenClaims = /* @__PURE__ */ new Set();
    const seenBindings = /* @__PURE__ */ new Set();
    const consumptions = (resolved.consumes || []).map((consumption) => {
      if (!CLAIM_REF_PATTERN.test(consumption.claim) || !hasOwn(authority.claimTypes, consumption.claim)) {
        throw new InstancePlanError(
          "UNKNOWN_TEMPLATE_CLAIM",
          `Template check "${name}.${nodeKey}" consumes undeclared claim "${consumption.claim}"`
        );
      }
      if (consumption.cardinality !== "one") {
        throw new InstancePlanError(
          "UNSUPPORTED_TEMPLATE_CARDINALITY",
          `Template check "${name}.${nodeKey}" supports cardinality one only`
        );
      }
      const binding = requireNonEmptyString(
        consumption.as,
        `subgraphs.${name}.checks.${nodeKey}.consumes.as`
      );
      if (!BINDING_NAME_PATTERN.test(binding)) {
        throw new InstancePlanError(
          "INVALID_TEMPLATE_BINDING",
          `Template check "${name}.${nodeKey}" has invalid binding "${binding}"`
        );
      }
      if (seenClaims.has(consumption.claim) || seenBindings.has(binding)) {
        throw new InstancePlanError(
          "DUPLICATE_TEMPLATE_CONSUMPTION",
          `Template check "${name}.${nodeKey}" has a duplicate claim or binding`
        );
      }
      if (consumption.claim === inputClaim) {
        consumesTemplateInput = true;
        if (binding !== inputName) {
          throw new InstancePlanError(
            "INVALID_TEMPLATE_BINDING",
            `Template input claim "${inputClaim}" must bind as "${inputName}"`
          );
        }
      }
      seenClaims.add(consumption.claim);
      seenBindings.add(binding);
      return Object.freeze({
        claim: consumption.claim,
        cardinality: "one",
        as: binding
      });
    });
    consumptionsByNode[nodeKey] = Object.freeze(consumptions);
    for (const emission of resolved.emits || []) {
      if (!CLAIM_REF_PATTERN.test(emission.claim) || !hasOwn(authority.claimTypes, emission.claim)) {
        throw new InstancePlanError(
          "UNKNOWN_TEMPLATE_CLAIM",
          `Template check "${name}.${nodeKey}" emits undeclared claim "${emission.claim}"`
        );
      }
      if (emission.from !== "output") {
        throw new InstancePlanError(
          "UNSUPPORTED_TEMPLATE_CLAIM_SOURCE",
          `Template check "${name}.${nodeKey}" uses an unsupported claim source`
        );
      }
      if (emission.claim === inputClaim) {
        throw new InstancePlanError(
          "FORGED_CONTROLLER_ITEM_CLAIM",
          `Template check "${name}.${nodeKey}" cannot emit controller input claim "${inputClaim}"`
        );
      }
      const existing = emitterByClaim[emission.claim];
      if (existing) {
        throw new InstancePlanError(
          "DUPLICATE_TEMPLATE_EMITTER",
          `Template claim "${emission.claim}" has duplicate emitters "${existing}" and "${nodeKey}"`
        );
      }
      emitterByClaim[emission.claim] = nodeKey;
    }
    resolvedChecks[nodeKey] = resolved;
  }
  if (!consumesTemplateInput) {
    throw new InstancePlanError(
      "UNUSED_TEMPLATE_INPUT",
      `Subgraph "${name}" has no check consuming its input claim "${inputClaim}"`
    );
  }
  const dependencies = {};
  for (const nodeKey of nodeKeys) {
    const effective = new Set(dependencyTokens(resolvedChecks[nodeKey], `${name}.${nodeKey}`));
    for (const dependency of effective) {
      if (!hasOwn(resolvedChecks, dependency)) {
        throw new InstancePlanError(
          "UNKNOWN_TEMPLATE_CHECK",
          `Template check "${name}.${nodeKey}" depends on unknown check "${dependency}"`
        );
      }
    }
    for (const consumption of consumptionsByNode[nodeKey]) {
      if (consumption.claim === inputClaim) continue;
      const emitter = emitterByClaim[consumption.claim];
      if (!emitter) {
        throw new InstancePlanError(
          "MISSING_TEMPLATE_EMITTER",
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
    dependencies,
    topology,
    authority
  );
  const dependentsByNode = {};
  for (const nodeKey of nodeKeys) {
    dependentsByNode[nodeKey] = Object.freeze(
      nodeKeys.filter((candidate) => dependencies[candidate].includes(nodeKey)).sort()
    );
  }
  const input = Object.freeze({ name: inputName, claim: inputClaim });
  const resolvedTemplate = immutableCanonicalValue({
    name,
    input,
    checks: resolvedChecks
  });
  const templateDigest = sha256Canonical({ v: 1, template: resolvedTemplate });
  const nodesByKey = {};
  for (const nodeKey of nodeKeys) {
    const check = resolvedChecks[nodeKey];
    const waitForExpansion = compileWaitForExpansion(
      name,
      nodeKey,
      check.wait_for_expansion,
      new Set(nodeKeys)
    );
    if (waitForExpansion && (dependencies[nodeKey].length !== 1 || dependencies[nodeKey][0] !== waitForExpansion.owner || (check.consumes?.length || 0) !== 0)) {
      throw new InstancePlanError(
        "INVALID_WAIT_FOR_EXPANSION",
        `Template check "${name}.${nodeKey}" wait_for_expansion must depend only on its owner and declare no consumes`
      );
    }
    const executionConfigDigest = sha256Canonical({
      v: 1,
      templateDigest,
      templateNodeKey: nodeKey,
      ...check.type === GOVERNED_PROOF_INSPECT_PROVIDER_TYPE ? { authoredProviderConfig: Object.fromEntries(["type", "message", "instructions", "invocation", "invocation_digest", "result_schema", "profile", ...check.ai ? ["ai"] : []].filter((key) => check[key] !== void 0).map((key) => [key, check[key]])) } : { resolvedCheck: check }
    });
    nodesByKey[nodeKey] = Object.freeze({
      templateNodeKey: nodeKey,
      check,
      emissions: Object.freeze([...check.emits || []]),
      consumptions: consumptionsByNode[nodeKey],
      dependencyNodeKeys: dependencies[nodeKey],
      executionConfigDigest,
      ...waitForExpansion ? { waitForExpansion } : {}
    });
  }
  return Object.freeze({
    name,
    input,
    templateDigest,
    templateNodeKeys: Object.freeze(nodeKeys),
    topology,
    reverseTopology: Object.freeze([...topology].reverse()),
    sourceNodeKeys: Object.freeze(nodeKeys.filter((node) => dependencies[node].length === 0)),
    nodesByKey: frozenRecord(nodesByKey),
    emitterByClaim: frozenRecord(emitterByClaim),
    dependentsByNode: frozenRecord(dependentsByNode)
  });
}
function resolvedRootChecks(checks) {
  const resolved = {};
  for (const checkId of Object.keys(checks).sort()) {
    resolved[checkId] = immutableCanonicalValue({
      ...checks[checkId],
      type: checks[checkId].type || "ai"
    });
  }
  return frozenRecord(resolved);
}
function compileExpansionPlan(config, authority) {
  const checks = config.checks || config.steps || {};
  for (const [checkId, check] of Object.entries(checks)) {
    if (check.resource_group !== void 0) {
      throw new InstancePlanError(
        "UNSUPPORTED_RESOURCE_GROUP_PLACEMENT",
        `Check "${checkId}" declares resource_group outside a Graph-v2 subgraph template`
      );
    }
  }
  const subgraphs = config.subgraphs;
  const owners = Object.entries(checks).filter(([, check]) => hasOwn(check, "expand"));
  const hasSubgraphs = hasOwn(config, "subgraphs");
  const rootWaiter = Object.entries(checks).find(([, check]) => hasOwn(check, "wait_for_expansion"));
  if (rootWaiter) {
    throw new InstancePlanError(
      "INVALID_WAIT_FOR_EXPANSION",
      `Root check "${rootWaiter[0]}" cannot declare wait_for_expansion; barriers belong to subgraph templates`
    );
  }
  if (!hasSubgraphs && owners.length === 0) {
    return Object.freeze({
      active: false,
      graphSemanticDigest: sha256Canonical({ v: 1, active: false }),
      byOwner: frozenRecord({}),
      byNestedOwner: frozenRecord({}),
      templatesByName: frozenRecord({})
    });
  }
  if (!subgraphs || typeof subgraphs !== "object" || Array.isArray(subgraphs) || Object.keys(subgraphs).length === 0 || owners.length === 0) {
    throw new InstancePlanError(
      "INCOMPLETE_EXPANSION_CONFIG",
      "Graph v2 C2 requires both a non-empty subgraphs map and a check-local expand block"
    );
  }
  const templatesByName = {};
  for (const name of Object.keys(subgraphs).sort()) {
    requireNonEmptyString(name, "subgraph name");
    templatesByName[name] = compileTemplate(name, subgraphs[name], authority);
  }
  const precompiled = [];
  for (const [owner, check] of owners.sort(([a], [b]) => a.localeCompare(b))) {
    const expansion = check.expand;
    if (!expansion || typeof expansion !== "object" || Array.isArray(expansion)) {
      throw new InstancePlanError(
        "INVALID_EXPANSION_CONFIG",
        `Check "${owner}" expand must be an object`
      );
    }
    const catalogClaim = requireNonEmptyString(expansion.claim, `checks.${owner}.expand.claim`);
    if (!CLAIM_REF_PATTERN.test(catalogClaim) || !authority.validatorsByClaim[catalogClaim]) {
      throw new InstancePlanError(
        "UNKNOWN_EXPANSION_CLAIM",
        `Check "${owner}" expands undeclared catalog claim "${catalogClaim}"`
      );
    }
    const matchingEmissions = (check.emits || []).filter((emission) => emission.claim === catalogClaim);
    if (matchingEmissions.length !== 1 || authority.rootEmitterByClaim[catalogClaim] !== owner) {
      throw new InstancePlanError(
        "INVALID_EXPANSION_OWNER",
        `Check "${owner}" must be the sole emitter of expanded claim "${catalogClaim}"`
      );
    }
    const itemClaim = requireNonEmptyString(
      expansion.item_claim,
      `checks.${owner}.expand.item_claim`
    );
    if (!CLAIM_REF_PATTERN.test(itemClaim) || !authority.validatorsByClaim[itemClaim]) {
      throw new InstancePlanError(
        "UNKNOWN_ITEM_CLAIM",
        `Check "${owner}" references undeclared item claim "${itemClaim}"`
      );
    }
    if (authority.rootEmitterByClaim[itemClaim]) {
      throw new InstancePlanError(
        "FORGED_CONTROLLER_ITEM_CLAIM",
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
        "UNKNOWN_SUBGRAPH_TEMPLATE",
        `Check "${owner}" references unknown subgraph template "${templateName}"`
      );
    }
    if (template.input.claim !== itemClaim) {
      throw new InstancePlanError(
        "ITEM_CLAIM_MISMATCH",
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
    let coverage;
    if (expansion.coverage !== void 0) {
      if (!expansion.coverage || typeof expansion.coverage !== "object" || Array.isArray(expansion.coverage)) {
        throw new InstancePlanError("INVALID_COVERAGE_CONFIG", `Check "${owner}" coverage must be an object`);
      }
      const outcomeClaimRef = requireNonEmptyString(
        expansion.coverage.outcome_claim,
        `checks.${owner}.expand.coverage.outcome_claim`
      );
      if (!CLAIM_REF_PATTERN.test(outcomeClaimRef) || !authority.validatorsByClaim[outcomeClaimRef] || outcomeClaimRef === catalogClaim || outcomeClaimRef === itemClaim || outcomeClaimRef === template.input.claim) {
        throw new InstancePlanError(
          "INVALID_COVERAGE_OUTCOME_CLAIM",
          `Check "${owner}" coverage outcome must be a distinct declared template claim`
        );
      }
      const emitterNodeKey = template.emitterByClaim[outcomeClaimRef];
      if (!emitterNodeKey || template.dependentsByNode[emitterNodeKey].length !== 0) {
        throw new InstancePlanError(
          "INVALID_COVERAGE_OUTCOME_EMITTER",
          `Check "${owner}" coverage outcome must have exactly one sink emitter`
        );
      }
      coverage = Object.freeze({
        outcomeClaimRef,
        emitterNodeKey,
        classPointer: compileJsonPointer(
          expansion.coverage.class_pointer,
          `checks.${owner}.expand.coverage.class_pointer`
        )
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
      ...coverage ? {
        coverage: {
          outcomeClaimRef: coverage.outcomeClaimRef,
          classPointer: coverage.classPointer.source,
          emitterNodeKey: coverage.emitterNodeKey
        }
      } : {}
    });
    precompiled.push({
      owner,
      expansion,
      template,
      itemsPointer,
      keyPointer,
      coverage,
      expansionSpecDigest
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
            template.templateNodeKeys.map((node) => [node, template.nodesByKey[node].check])
          )
        }
      ])
    )
  });
  const byOwner = {};
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
      ...compiled.coverage ? { coverage: compiled.coverage } : {},
      graphSemanticDigest
    });
  }
  const byNestedOwner = {};
  const reachableTemplates = /* @__PURE__ */ new Set();
  const visitingTemplates = /* @__PURE__ */ new Set();
  const compileReachableTemplate = (parentTemplate, depth) => {
    if (visitingTemplates.has(parentTemplate.name)) {
      throw new InstancePlanError(
        "NESTED_EXPANSION_DEPTH_EXCEEDED",
        `Graph v2 expansion templates contain a recursive cycle at "${parentTemplate.name}"`
      );
    }
    if (reachableTemplates.has(parentTemplate.name)) return;
    visitingTemplates.add(parentTemplate.name);
    reachableTemplates.add(parentTemplate.name);
    for (const nodeKey of parentTemplate.templateNodeKeys) {
      const check = parentTemplate.nodesByKey[nodeKey].check;
      if (!hasOwn(check, "expand")) continue;
      const expansion = check.expand;
      const ownerAddress = qualifiedNestedExpansionOwner(parentTemplate.name, nodeKey);
      if (!expansion || typeof expansion !== "object" || Array.isArray(expansion)) {
        throw new InstancePlanError(
          "INVALID_EXPANSION_CONFIG",
          `Template check "${parentTemplate.name}.${nodeKey}" expand must be an object`
        );
      }
      const fieldPrefix = `subgraphs.${parentTemplate.name}.checks.${nodeKey}.expand`;
      const catalogClaim = requireNonEmptyString(expansion.claim, `${fieldPrefix}.claim`);
      if (!CLAIM_REF_PATTERN.test(catalogClaim) || !authority.validatorsByClaim[catalogClaim]) {
        throw new InstancePlanError(
          "UNKNOWN_EXPANSION_CLAIM",
          `Template check "${parentTemplate.name}.${nodeKey}" expands undeclared catalog claim "${catalogClaim}"`
        );
      }
      const matchingEmissions = (check.emits || []).filter((emission) => emission.claim === catalogClaim);
      if (matchingEmissions.length !== 1 || parentTemplate.emitterByClaim[catalogClaim] !== nodeKey) {
        throw new InstancePlanError(
          "INVALID_EXPANSION_OWNER",
          `Template check "${parentTemplate.name}.${nodeKey}" must be the sole template emitter of expanded claim "${catalogClaim}"`
        );
      }
      const itemClaim = requireNonEmptyString(expansion.item_claim, `${fieldPrefix}.item_claim`);
      if (!CLAIM_REF_PATTERN.test(itemClaim) || !authority.validatorsByClaim[itemClaim]) {
        throw new InstancePlanError(
          "UNKNOWN_ITEM_CLAIM",
          `Template check "${parentTemplate.name}.${nodeKey}" references undeclared item claim "${itemClaim}"`
        );
      }
      if (authority.rootEmitterByClaim[itemClaim] || Object.values(templatesByName).some((candidate) => candidate.emitterByClaim[itemClaim])) {
        throw new InstancePlanError(
          "FORGED_CONTROLLER_ITEM_CLAIM",
          `Nested item claim "${itemClaim}" is controller-owned and cannot have an emitter`
        );
      }
      const templateName = requireNonEmptyString(expansion.template, `${fieldPrefix}.template`);
      const childTemplate = templatesByName[templateName];
      if (!childTemplate) {
        throw new InstancePlanError(
          "UNKNOWN_SUBGRAPH_TEMPLATE",
          `Template check "${parentTemplate.name}.${nodeKey}" references unknown subgraph template "${templateName}"`
        );
      }
      if (childTemplate.input.claim !== itemClaim) {
        throw new InstancePlanError(
          "ITEM_CLAIM_MISMATCH",
          `Nested item claim "${itemClaim}" does not match template input "${childTemplate.input.claim}"`
        );
      }
      const itemsPointer = compileJsonPointer(expansion.items_pointer, `${fieldPrefix}.items_pointer`);
      const keyPointer = compileJsonPointer(expansion.key_pointer, `${fieldPrefix}.key_pointer`);
      let coverage;
      if (expansion.coverage !== void 0) {
        if (!expansion.coverage || typeof expansion.coverage !== "object" || Array.isArray(expansion.coverage)) {
          throw new InstancePlanError("INVALID_COVERAGE_CONFIG", `Template check "${parentTemplate.name}.${nodeKey}" coverage must be an object`);
        }
        const outcomeClaimRef = requireNonEmptyString(
          expansion.coverage.outcome_claim,
          `${fieldPrefix}.coverage.outcome_claim`
        );
        if (!CLAIM_REF_PATTERN.test(outcomeClaimRef) || !authority.validatorsByClaim[outcomeClaimRef] || outcomeClaimRef === catalogClaim || outcomeClaimRef === itemClaim || outcomeClaimRef === childTemplate.input.claim) {
          throw new InstancePlanError(
            "INVALID_COVERAGE_OUTCOME_CLAIM",
            `Template check "${parentTemplate.name}.${nodeKey}" coverage outcome must be a distinct declared template claim`
          );
        }
        const emitterNodeKey = childTemplate.emitterByClaim[outcomeClaimRef];
        if (!emitterNodeKey || childTemplate.dependentsByNode[emitterNodeKey].length !== 0) {
          throw new InstancePlanError(
            "INVALID_COVERAGE_OUTCOME_EMITTER",
            `Template check "${parentTemplate.name}.${nodeKey}" coverage outcome must have exactly one sink emitter`
          );
        }
        coverage = Object.freeze({
          outcomeClaimRef,
          emitterNodeKey,
          classPointer: compileJsonPointer(expansion.coverage.class_pointer, `${fieldPrefix}.coverage.class_pointer`)
        });
      }
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
        ...coverage ? {
          coverage: {
            outcomeClaimRef: coverage.outcomeClaimRef,
            classPointer: coverage.classPointer.source,
            emitterNodeKey: coverage.emitterNodeKey
          }
        } : {}
      });
      byNestedOwner[ownerAddress] = Object.freeze({
        expansionOwnerCheck: ownerAddress,
        depth,
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
        ...coverage ? { coverage } : {},
        graphSemanticDigest
      });
      compileReachableTemplate(childTemplate, depth + 1);
    }
    visitingTemplates.delete(parentTemplate.name);
  };
  for (const compiled of precompiled) compileReachableTemplate(compiled.template, 2);
  for (const templateName of Object.keys(templatesByName)) {
    const dormantNativeProfile = templateName === RETAINED_COMPONENT_TEMPLATE_NAME || templateName === "onboard-component" && templatesByName[templateName].input.claim === "component.work_item@1" && Object.prototype.hasOwnProperty.call(templatesByName[templateName].nodesByKey, "prepare-work-item");
    if (!reachableTemplates.has(templateName) && !dormantNativeProfile) {
      throw new InstancePlanError(
        "UNREACHABLE_SUBGRAPH_TEMPLATE",
        `Subgraph template "${templateName}" is not reachable from a root expansion`
      );
    }
  }
  const waitOwnerByTemplate = /* @__PURE__ */ new Set();
  for (const template of Object.values(templatesByName)) {
    for (const nodeKey of template.templateNodeKeys) {
      const wait = template.nodesByKey[nodeKey].waitForExpansion;
      if (!wait) continue;
      const nested = byNestedOwner[qualifiedNestedExpansionOwner(template.name, wait.owner)];
      if (!nested) {
        throw new InstancePlanError(
          "INVALID_WAIT_FOR_EXPANSION",
          `Template check "${template.name}.${nodeKey}" wait_for_expansion.owner must own a compiled expansion`
        );
      }
      if (!nested.template.nodesByKey[wait.terminal_node]) {
        throw new InstancePlanError(
          "INVALID_WAIT_FOR_EXPANSION",
          `Template check "${template.name}.${nodeKey}" wait_for_expansion.terminal_node must exist in child template "${nested.template.name}"`
        );
      }
      if (nested.template.dependentsByNode[wait.terminal_node].length !== 0) {
        throw new InstancePlanError(
          "INVALID_WAIT_FOR_EXPANSION",
          `Template check "${template.name}.${nodeKey}" wait_for_expansion.terminal_node must be a child-template sink`
        );
      }
      const ownerKey = qualifiedNestedExpansionOwner(template.name, wait.owner);
      if (waitOwnerByTemplate.has(ownerKey)) {
        throw new InstancePlanError(
          "INVALID_WAIT_FOR_EXPANSION",
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
    templatesByName: frozenRecord(templatesByName)
  });
}
var CLAIM_REF_PATTERN, BINDING_NAME_PATTERN, CONTROLLER_TIMEOUT_MIN, CONTROLLER_TIMEOUT_MAX, RESOURCE_GROUP_PATTERN, RETAINED_COMPONENT_TEMPLATE_NAME, PROOF_CANDIDATE_CLAIM, PROOF_ADMITTED_RECEIPT_CLAIM, PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM, PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM, PROOF_CATALOG_REVALIDATION_CLAIM, PROOF_STRUCTURAL_INVENTORY_CLAIM, PROOF_ADMITTED_CATALOG_PROVIDER_TYPE, PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE, PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE, PROOF_ADMIT_PROVIDER_TYPE, GOVERNED_PROOF_INSPECT_PROVIDER_TYPE, PROOF_PROJECT_RECONCILE_PROVIDER_TYPE, PROOF_PROJECT_RECONCILE_NODE_KEY, PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM, PROOF_ADMIT_NODE_KEY, InstancePlanError;
var init_instance_plan = __esm({
  "src/state-machine/graph/instance-plan.ts"() {
    "use strict";
    init_claim_kernel();
    init_governed_proof_inspect_check_provider();
    CLAIM_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[1-9][0-9]*$/;
    BINDING_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
    CONTROLLER_TIMEOUT_MIN = 1;
    CONTROLLER_TIMEOUT_MAX = 2147483647;
    RESOURCE_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    RETAINED_COMPONENT_TEMPLATE_NAME = "onboard-component-retained";
    PROOF_CANDIDATE_CLAIM = "proof.candidate@1";
    PROOF_ADMITTED_RECEIPT_CLAIM = "proof.admitted_receipt@1";
    PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM = "proof.component_spec_review_candidate@1";
    PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM = "proof.component_spec_review_admitted_receipt@1";
    PROOF_CATALOG_REVALIDATION_CLAIM = "proof.catalog_revalidation@1";
    PROOF_STRUCTURAL_INVENTORY_CLAIM = "proof.structural_inventory@1";
    PROOF_ADMITTED_CATALOG_PROVIDER_TYPE = "proof-admitted-catalog";
    PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE = "proof-catalog-revalidate";
    PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE = "proof-structural-inventory";
    PROOF_ADMIT_PROVIDER_TYPE = "proof-admit";
    GOVERNED_PROOF_INSPECT_PROVIDER_TYPE = "governed-proof-inspect";
    PROOF_PROJECT_RECONCILE_PROVIDER_TYPE = "proof-project-reconcile";
    PROOF_PROJECT_RECONCILE_NODE_KEY = "project_reconcile";
    PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM = "proof.project_reconciliation_receipt@1";
    PROOF_ADMIT_NODE_KEY = "proof_admit";
    InstancePlanError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.name = "InstancePlanError";
        this.code = code;
      }
    };
  }
});

export {
  ClaimKernelError,
  canonicalJson,
  sha256Canonical,
  immutableCanonicalValue,
  immutableRuntimeEvent,
  attemptProjectionKey,
  createInitialClaimProjection,
  exactActiveClaimIds,
  reduceClaimEvent,
  replayClaimEvents,
  compileClaimSchema,
  buildClaimPublishedEvent,
  init_claim_kernel,
  governedWireModeFromEvidence,
  proofCanonicalJson,
  immutableProofCanonicalValue,
  governedCanonicalJson,
  governedPayloadFingerprint,
  governedResultDigest,
  immutableGovernedValue,
  governedProofCandidateEvidenceJson,
  immutableProofCandidateEvidence,
  proofCandidateEvidenceFingerprint,
  init_proof_wire,
  sanitizeGovernedAnswerFailure,
  init_governed_probe_runner,
  PROOF_ADMISSION_UNAVAILABLE,
  PROOF_ADMISSION_WIRE_FIELD,
  PROOF_ONBOARDING_STAGE_CONTEXT_VERSION,
  PROOF_ONBOARDING_STAGE_SPEC_REVIEW,
  PROOF_ONBOARDING_STAGE_MAX_BYTES,
  validateOnboardingStageContext,
  proofCatalogRevalidationReceiptIdentityJson,
  proofComponentCandidateEnvelopeJson,
  proofCandidateAdmissionRequestJson,
  extractProofAdmissionCandidate,
  validateProofComponentAdmissionOutcome,
  proofAdmissionCapabilityValid,
  goCompatibleProofJson,
  createProofAdmissionCliChildForFocusedTest,
  startProofManagedCliChild,
  startProofAdmissionCliChild,
  init_proof_admission_cli_child,
  PROOF_CANDIDATE_CLAIM,
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM,
  PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM,
  PROOF_CATALOG_REVALIDATION_CLAIM,
  PROOF_STRUCTURAL_INVENTORY_CLAIM,
  PROOF_ADMITTED_CATALOG_PROVIDER_TYPE,
  PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE,
  PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE,
  PROOF_ADMIT_PROVIDER_TYPE,
  GOVERNED_PROOF_INSPECT_PROVIDER_TYPE,
  PROOF_PROJECT_RECONCILE_PROVIDER_TYPE,
  PROOF_PROJECT_RECONCILE_NODE_KEY,
  PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM,
  PROOF_ADMIT_NODE_KEY,
  qualifiedNestedExpansionOwner,
  resolveJsonPointer,
  compileExpansionPlan,
  init_instance_plan,
  PROOF_REVALIDATION_REQUEST_MAX_BYTES,
  PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES,
  compareProofStrings,
  validateGovernedProofCandidateClaim,
  validateProofComponentCandidateAdmissionBinding,
  validateProofCandidateAdmissionBinding,
  validateProofWorkItemsProjection,
  validateProofCurrentCatalogAuthorityBytes,
  proofWorkItemDigestForReconciliation,
  validateProofCatalogRevalidationProjection,
  ProofStructuralInventoryCheckProvider,
  ProofCatalogRevalidationCheckProvider,
  createProofStructuralInventoryProviderFromCapability,
  createProofCatalogRevalidationProviderFromCapability,
  init_proof_catalog_check_providers,
  GOVERNED_PROOF_INSPECT_PROVIDER_NAME,
  COMPONENT_WORK_ITEM_CLAIM,
  NATIVE_COMPONENT_REVIEWED_CLAIM,
  isGovernedProofComponentSelector,
  isGovernedProofSpecReviewSelector,
  isGovernedProofProjectSelector,
  validateProofComponentInvocationAuthority,
  validateGovernedProofComponentReinspectionContext,
  governedProofComponentReinspectionContextDigest,
  validateGovernedProofRuntimeContextAgainstClaims,
  validateProofCandidateEvidence,
  createGovernedProofInspectProviderFromCapability,
  GovernedProofInspectCheckProvider,
  init_governed_proof_inspect_check_provider
};
//# sourceMappingURL=chunk-OEH4UJNW.mjs.map