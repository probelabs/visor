/**
 * A2A Check Provider — calls external A2A-compatible agents from Visor checks.
 *
 * Configuration:
 *   type: a2a
 *   agent_card: "https://agent.example.com/.well-known/agent-card.json"
 *   # OR agent_url: "http://localhost:9001"
 *   auth:
 *     scheme: "bearer"
 *     token_env: "AGENT_TOKEN"
 *   message: |
 *     Review this PR for compliance.
 *     Repo: {{ pr.repo }}
 *   blocking: true
 *   timeout: 300000
 *   poll_interval: 2000
 *   max_turns: 3
 *   on_input_required: |
 *     Additional context: {{ pr.description }}
 */
import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import type { AgentCard } from '../agent-protocol/types';
export declare class AgentCardCache {
    private cache;
    private ttlMs;
    constructor(ttlMs?: number);
    fetch(url: string): Promise<AgentCard>;
    invalidate(url: string): void;
    clear(): void;
}
export declare class A2ACheckProvider extends CheckProvider {
    private liquid;
    private sandbox?;
    private createSecureSandbox;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    private sendMessage;
    private getTask;
    private taskToReviewSummary;
    private messageToReviewSummary;
    /**
     * Extract structured ReviewIssue objects from a data part.
     * Accepts a single issue object or an array of issue objects.
     * Each object should have at least a `message` field to be recognized as an issue.
     */
    private extractIssuesFromData;
    private normalizeSeverity;
    private normalizeCategory;
}
//# sourceMappingURL=a2a-check-provider.d.ts.map