import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Provider that executes JavaScript in a secure sandbox using
 * a first-class step: `type: 'script'` + `content: | ...`.
 *
 * When `tools`, `tools_js`, or `mcp_servers` are configured, tools are
 * exposed as raw async functions in the sandbox (by name). An AST
 * transformer auto-injects `await` so users write synchronous-looking code.
 */
export declare class ScriptCheckProvider extends CheckProvider {
    private liquid;
    constructor();
    private createSecureSandbox;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig & {
        content?: string;
    }, dependencyResults?: Map<string, ReviewSummary>, _sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    } & ExecutionContext): Promise<ReviewSummary>;
    /**
     * Resolve tool items from static config and optional JS expression.
     */
    private resolveToolItems;
    /**
     * Connect to MCP servers and discover their tools.
     */
    private connectMcpServers;
    /**
     * Disconnect all MCP clients.
     */
    private disconnectMcpClients;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=script-check-provider.d.ts.map