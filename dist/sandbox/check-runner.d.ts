/**
 * CheckRunner — serializes check execution into a sandbox container.
 * Builds the CheckRunPayload, invokes child visor via sandbox exec,
 * and parses the JSON result from stdout.
 */
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { CheckConfig } from '../types/config';
import { SandboxManager } from './sandbox-manager';
import { SandboxConfig } from './types';
export declare class CheckRunner {
    /**
     * Execute a check inside a sandbox container.
     *
     * 1. Build CheckRunPayload JSON
     * 2. Filter env vars through EnvFilter
     * 3. Exec `node <visor_path>/cli-main.js --run-check` inside the sandbox
     * 4. Parse CheckRunResult from stdout JSON
     * 5. Return as ReviewSummary
     */
    static runCheck(sandboxManager: SandboxManager, sandboxName: string, sandboxConfig: SandboxConfig, checkConfig: CheckConfig, prInfo: PRInfo, dependencyResults?: Map<string, ReviewSummary>, timeoutMs?: number, workspaceDefaults?: {
        env_passthrough?: string[];
    }, serviceEnvVars?: Record<string, string>): Promise<ReviewSummary>;
}
//# sourceMappingURL=check-runner.d.ts.map