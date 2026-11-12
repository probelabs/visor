/**
 * Legacy compatibility layer
 *
 * This file re-exports StateMachineExecutionEngine as CheckExecutionEngine
 * to maintain backward compatibility with existing test files.
 *
 * @deprecated Use StateMachineExecutionEngine directly from state-machine-execution-engine.ts
 *
 * Migration path:
 * - Old: import { CheckExecutionEngine } from './check-execution-engine'
 * - New: import { StateMachineExecutionEngine } from './state-machine-execution-engine'
 *
 * This compatibility layer will be removed in a future version once all tests
 * have been migrated to use the new state machine engine directly.
 */
export { StateMachineExecutionEngine as CheckExecutionEngine } from './state-machine-execution-engine';
export type { CheckExecutionOptions, ExecutionResult, CheckExecutionStats, ExecutionStatistics, } from './types/execution';
/**
 * Mock Octokit interface for testing
 *
 * @deprecated This type is preserved for backward compatibility but should not be used.
 * Use createMockOctokit() from test utilities instead.
 */
export interface MockOctokit {
    rest: {
        pulls: {
            get: () => Promise<{
                data: Record<string, unknown>;
            }>;
            listFiles: () => Promise<{
                data: Record<string, unknown>[];
            }>;
        };
        issues: {
            listComments: () => Promise<{
                data: Record<string, unknown>[];
            }>;
            createComment: () => Promise<{
                data: Record<string, unknown>;
            }>;
        };
    };
    request: () => Promise<{
        data: Record<string, unknown>;
    }>;
    graphql: () => Promise<Record<string, unknown>>;
    log: {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
    hook: {
        before: (...args: unknown[]) => void;
        after: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
        wrap: (...args: unknown[]) => void;
    };
    auth: () => Promise<{
        token: string;
    }>;
}
