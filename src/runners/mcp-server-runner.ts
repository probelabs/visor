import type { Runner } from './runner';
import type { VisorConfig } from '../types/config';
import { createHttpMcpServer, type McpServerOptions, type McpServerHandle } from '../mcp-server';

/**
 * Runner wrapper that exposes the MCP HTTP server as a composable Runner.
 *
 * The MCP server always runs in HTTP mode when used as a runner
 * (stdio is exclusive and incompatible with parallel runners).
 */
export class McpServerRunner implements Runner {
  readonly name = 'mcp';
  private handle: McpServerHandle | null = null;

  constructor(private options: McpServerOptions) {
    // Force HTTP transport when running as a composable runner
    this.options.transport = 'http';
  }

  async start(): Promise<void> {
    this.handle = await createHttpMcpServer(this.options);
    const port = this.options.port || 8080;
    const host = this.options.host || '0.0.0.0';
    console.log(`MCP HTTP server running on ${host}:${port}`);
  }

  async stop(): Promise<void> {
    if (this.handle) {
      this.handle.close();
      this.handle = null;
    }
  }

  updateConfig(_cfg: VisorConfig): void {
    // MCP server doesn't hot-reload config — it re-reads workflow on each tool call
  }
}
