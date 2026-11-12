import type { ManagedAgentRun, ManagedRunCancelReceiptV1, ManagedRunCleanupReceiptV1, ManagedRunOutcomeV1, ManagedRunStartRequest, ManagedRunStartedReceiptV1 } from '../../providers/check-provider.interface';
import { type GovernedWireMode } from '../../providers/proof-wire';
import { type ManagedRunBindingV1, type ManagedRunFailureCode } from '../graph/instance-kernel';
type ManagedRunProtocolFailureCode = Extract<ManagedRunFailureCode, 'MANAGED_HANDLE_INVALID' | 'MANAGED_BINDING_MISMATCH' | 'MANAGED_START_FAILED' | 'MANAGED_STARTED_RECEIPT_INVALID' | 'MANAGED_OUTCOME_RECEIPT_INVALID' | 'MANAGED_CANCEL_FAILED' | 'MANAGED_CANCEL_RECEIPT_INVALID' | 'MANAGED_CLOSE_FAILED' | 'MANAGED_CLEANUP_RECEIPT_INVALID'>;
/** Stable, data-minimal failure surfaced by the managed provider boundary. */
export declare class ManagedRunProtocolError extends Error {
    readonly code: ManagedRunProtocolFailureCode;
    constructor(code: ManagedRunProtocolFailureCode);
}
export interface ManagedRunSnapshot {
    readonly binding: ManagedRunBindingV1;
    readonly started: Promise<ManagedRunStartedReceiptV1>;
    readonly outcome: Promise<ManagedRunOutcomeV1>;
    readonly cancelOnce: (reason: 'deadline', fence: number) => Promise<ManagedRunCancelReceiptV1>;
    readonly closeOnce: () => Promise<ManagedRunCleanupReceiptV1>;
}
export interface ManagedRunDeadlineSettlement {
    readonly cancel: PromiseSettledResult<ManagedRunCancelReceiptV1> | null;
    readonly close: PromiseSettledResult<ManagedRunCleanupReceiptV1>;
    readonly cancelRequested: boolean;
}
export interface ManagedRunDeadline {
    /** Resolves only after the independently started cancel and close calls both settle. */
    readonly fired: Promise<ManagedRunDeadlineSettlement>;
    readonly didFire: () => boolean;
    /** The controller calls this only after close has settled on the ordinary path. */
    readonly clear: () => void;
}
/** Build an immutable provider-only view without freezing controller-owned inputs. */
export declare function snapshotManagedRunStartRequest(request: ManagedRunStartRequest): ManagedRunStartRequest;
/** Preserve the selected timeout value when valid; otherwise arm an immediate deadline. */
export declare function normalizeManagedRunTimeout(timeoutMs: number): number;
/**
 * Invoke start exactly once, then synchronously detach all handle authority
 * from provider mutation before any provider-controlled await can occur.
 */
export declare function snapshotManagedRun(start: () => ManagedAgentRun, expectedBinding: ManagedRunBindingV1, onSynchronousStartFailure?: (error: unknown) => void): ManagedRunSnapshot;
export declare function normalizeManagedRunStartedReceipt(value: unknown, expectedBinding: ManagedRunBindingV1): ManagedRunStartedReceiptV1;
export declare function normalizeManagedRunOutcome(value: unknown, expectedBinding: ManagedRunBindingV1, trustedWireMode?: GovernedWireMode): ManagedRunOutcomeV1;
export declare function normalizeManagedRunCancelReceipt(value: unknown, expectedBinding: ManagedRunBindingV1): ManagedRunCancelReceiptV1;
export declare function normalizeManagedRunCleanupReceipt(value: unknown, expectedBinding: ManagedRunBindingV1): ManagedRunCleanupReceiptV1;
/**
 * Arm the managed run's sole deadline timer. Once the journal callback commits,
 * cancel and close are invoked back-to-back before either is awaited.
 */
export declare function armManagedRunDeadline(input: {
    readonly snapshot: ManagedRunSnapshot;
    readonly timeoutMs: number;
    readonly onCancelRequested: () => void;
}): ManagedRunDeadline;
export {};
//# sourceMappingURL=managed-run.d.ts.map