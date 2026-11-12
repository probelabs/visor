export declare const PROOF_CANDIDATE_OUTPUT_SCHEMA_ID = "proof.component-catalog-candidate@1";
export type GovernedWireMode = 'generic' | 'proof';
/** The mode is an attested property of the governed role invocation. */
export declare function governedWireModeFromEvidence(value: unknown): GovernedWireMode;
export declare function governedWireModeFromInvocation(value: unknown): GovernedWireMode;
/** Proof CanonicalJSON for values at a governed Proof boundary. */
export declare function proofCanonicalJson(value: unknown): string;
/** Sort only a Proof receipt's outer map; nested struct values are pre-encoded. */
export declare function proofTopLevelJson(fields: Readonly<Record<string, string>>): string;
/** Rebuild a JSON value in Proof's canonical key order and freeze it. */
export declare function immutableProofCanonicalValue<T>(value: T): T;
/** Proof's governed result identity digest over canonical UTF-8 bytes. */
export declare function proofGovernedResultDigest(value: unknown): string;
/** Plain SHA-256 over Proof's canonical JSON bytes (claim payload fingerprint). */
export declare function proofPayloadFingerprint(value: unknown): string;
export declare function governedCanonicalJson(value: unknown, mode: GovernedWireMode): string;
export declare function governedPayloadFingerprint(value: unknown, mode: GovernedWireMode): string;
export declare function governedResultDigest(value: unknown, mode: GovernedWireMode): string;
export declare function immutableGovernedValue<T>(value: T, mode: GovernedWireMode): T;
/** Component C0 evidence embeds Proof-owned RawMessage authority. Its
 * identity is selected by that exact runtime authority field, never by a
 * claim name or caller-provided wire mode. Generic/project evidence retains
 * the historical graph serializer and fingerprint byte-for-byte. */
export declare function isProofComponentEvidence(value: unknown): boolean;
export declare function governedProofCandidateEvidenceJson(value: unknown): string;
export declare function immutableProofCandidateEvidence<T>(value: T): T;
export declare function proofCandidateEvidenceFingerprint(value: unknown): string;
//# sourceMappingURL=proof-wire.d.ts.map