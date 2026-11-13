/**
 * Global debounce manager for step execution.
 *
 * When a step has `debounce: <ms>`, multiple invocations within the debounce
 * window are coalesced — only the LAST invocation actually executes, after
 * the window expires with no new invocations.
 *
 * Additionally, if the function is currently executing, new invocations are
 * skipped (resolved as 'debounced') to prevent parallel executions.
 *
 * Key: typically `workflow:stepId` — callers decide the grouping.
 *
 * Earlier invocations resolve with 'debounced' (skipped).
 * The final invocation resolves with 'executed' after the real execution.
 */
export declare class DebounceManager {
    private pending;
    /** Waiters that were superseded and should resolve as 'debounced' */
    private superseded;
    /** Keys currently executing — prevents parallel runs */
    private executing;
    /**
     * Enqueue an execution. Returns 'executed' if this invocation won the
     * debounce race, or 'debounced' if it was superseded by a later one
     * or if the function is already executing for this key.
     */
    enqueue(key: string, debounceMs: number, fn: () => Promise<unknown>): Promise<{
        outcome: 'executed';
        result: unknown;
    } | {
        outcome: 'debounced';
    }>;
    /** Cancel a pending debounce. All waiters resolve as 'debounced'. */
    cancel(key: string): boolean;
    /** Cancel all pending debounces. */
    clear(): void;
    /** Number of pending debounce keys. */
    get size(): number;
    /** Check if a key is currently executing. */
    isExecuting(key: string): boolean;
}
export declare function getDebounceManager(): DebounceManager;
export declare function resetDebounceManager(): void;
//# sourceMappingURL=debounce-manager.d.ts.map