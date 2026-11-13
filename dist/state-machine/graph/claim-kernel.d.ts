import type { CandidateClaimInput } from '../../providers/check-provider.interface';
import type { ScopePath } from '../../snapshot-store';
import type { ClaimPlan } from './claim-plan';
export type ClaimRuntimeEvent = AttemptStartedEvent | ClaimPublishedEvent | CheckScheduledEvent | AttemptCompletedEvent | AttemptFailedEvent;
interface RuntimeEventBase {
    readonly version: 1;
    readonly eventId: number;
    readonly sessionId: string;
    readonly checkId: string;
    readonly scope: ScopePath;
    readonly attemptId: string;
    readonly fence: number;
}
export interface AttemptStartedEvent extends RuntimeEventBase {
    readonly type: 'AttemptStarted';
}
export interface ClaimPublishedEvent extends RuntimeEventBase {
    readonly type: 'ClaimPublished';
    readonly claimId: string;
    readonly claim: string;
    readonly payload: unknown;
    readonly payloadFingerprint: string;
    readonly producerCheckId: string;
    readonly parentClaimIds: readonly string[];
}
export interface CheckScheduledEvent extends RuntimeEventBase {
    readonly type: 'CheckScheduled';
    readonly claimIds: readonly string[];
}
export interface AttemptCompletedEvent extends RuntimeEventBase {
    readonly type: 'AttemptCompleted';
}
export interface AttemptFailedEvent extends RuntimeEventBase {
    readonly type: 'AttemptFailed';
    readonly reason: string;
}
export interface AttemptProjection {
    readonly sessionId: string;
    readonly checkId: string;
    readonly scope: ScopePath;
    readonly attemptId: string;
    readonly fence: number;
    readonly status: 'started' | 'completed' | 'failed';
    readonly reason?: string;
}
export interface ClaimProjection {
    readonly lastEventId: number;
    readonly attempts: Readonly<Record<string, AttemptProjection>>;
    readonly claims: Readonly<Record<string, CandidateClaimInput>>;
    readonly activeClaimIdsByRef: Readonly<Record<string, string>>;
    readonly scheduled: readonly CheckScheduledEvent[];
}
export type ClaimSchemaValidator = (payload: unknown) => void;
export declare class ClaimKernelError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Deterministic UTF-8 JSON with recursively sorted object keys. */
export declare function canonicalJson(value: unknown): string;
export declare function sha256Canonical(value: unknown): string;
export declare function immutableCanonicalValue<T>(value: T): T;
export declare function immutableRuntimeEvent<T extends ClaimRuntimeEvent>(event: T): T;
export declare function attemptProjectionKey(sessionId: string, checkId: string, scope: ScopePath): string;
export declare function createInitialClaimProjection(): ClaimProjection;
export declare function exactActiveClaimIds(plan: ClaimPlan, projection: ClaimProjection, checkId: string): readonly string[];
/** Pure plan-aware transition reducer. It returns a deeply immutable projection. */
export declare function reduceClaimEvent(projection: ClaimProjection, event: ClaimRuntimeEvent, plan: ClaimPlan): ClaimProjection;
export declare function replayClaimEvents(events: readonly ClaimRuntimeEvent[], plan: ClaimPlan): ClaimProjection;
/** Compile a claim schema once, strictly, before any provider may launch. */
export declare function compileClaimSchema(schema: Record<string, unknown>): ClaimSchemaValidator;
export declare function buildClaimPublishedEvent(input: {
    eventId: number;
    sessionId: string;
    checkId: string;
    scope: ScopePath;
    attemptId: string;
    fence: number;
    claim: string;
    payload: unknown;
    parentClaimIds: readonly string[];
    projection: ClaimProjection;
    plan: ClaimPlan;
}): ClaimPublishedEvent;
export {};
//# sourceMappingURL=claim-kernel.d.ts.map