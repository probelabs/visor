import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Memory operation types
 */
export type MemoryOperation = 'get' | 'set' | 'append' | 'increment' | 'delete' | 'clear' | 'list' | 'exec_js';
/**
 * Check provider for memory/state management
 * Supports in-memory and persistent storage with namespace isolation
 */
export declare class MemoryCheckProvider extends CheckProvider {
    private liquid;
    private sandbox?;
    constructor();
    /**
     * Create a secure sandbox for JavaScript execution
     */
    private createSecureSandbox;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, _sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    }): Promise<ReviewSummary>;
    private handleGet;
    private handleSet;
    private handleAppend;
    private handleIncrement;
    private handleDelete;
    private handleClear;
    private handleList;
    private handleExecJs;
    /**
     * Compute value from config using value, value_js, transform, or transform_js
     */
    private computeValue;
    /**
     * Evaluate JavaScript expression in context using SandboxJS for secure execution
     */
    private evaluateJavaScript;
    /**
     * Evaluate JavaScript block (multi-line script) using SandboxJS for secure execution
     * Unlike evaluateJavaScript, this supports full scripts with statements, not just expressions
     */
    private evaluateJavaScriptBlock;
    /**
     * Build template context for Liquid and JS evaluation
     */
    private buildTemplateContext;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=memory-check-provider.d.ts.map