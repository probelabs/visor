import type { Runner } from './runner';
import type { VisorConfig } from '../types/config';
import type { TaskStore } from '../agent-protocol/task-store';
import type { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { validateBearerToken, SERVER_INFO } from '../mcp-server';
import { withVisorRun, getVisorRunAttributes } from '../telemetry/trace-helpers';

export interface McpFrontendOptions {
  /** Port for HTTP transport (default: 8080). */
  port?: number;
  /** Host/bind address (default: '0.0.0.0'). */
  host?: string;
  /** Bearer token for authentication. */
  authToken?: string;
  /** Env var name containing the bearer token. */
  authTokenEnv?: string;
  /** Path to TLS certificate PEM. */
  tlsCert?: string;
  /** Path to TLS private key PEM. */
  tlsKey?: string;
  /** Tool name (default: 'send_message'). */
  toolName?: string;
  /** Tool description. */
  toolDescription?: string;
  /** Enable async job mode (start_job/get_job instead of blocking tool). */
  asyncMode?: boolean;
}

/**
 * Read and parse JSON body from an HTTP request.
 */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk));
    req.on('end', () => {
      if (!data.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * MCP Frontend Runner — exposes the Visor assistant as an MCP tool.
 *
 * Unlike the standalone `visor mcp-server` (which calls runChecks from the SDK),
 * this runner dispatches messages through the StateMachineExecutionEngine just like
 * the Slack/Telegram runners do. This means `{{ conversation.current.text }}` works,
 * the full workflow config is used, and responses flow back through the engine.
 */
export class McpServerRunner implements Runner {
  readonly name = 'mcp';
  private httpServer: http.Server | https.Server | null = null;
  private transports = new Map<string, StreamableHTTPServerTransport>();
  private taskStore?: TaskStore;
  private configPath?: string;
  private activeRequests = 0;
  private draining = false;

  constructor(
    private engine: StateMachineExecutionEngine,
    private cfg: VisorConfig,
    private options: McpFrontendOptions
  ) {}

  async start(): Promise<void> {
    const port = this.options.port || 8080;
    const host = this.options.host || '0.0.0.0';

    // Resolve auth token
    const authToken =
      this.options.authToken ||
      (this.options.authTokenEnv ? process.env[this.options.authTokenEnv] : undefined);
    if (!authToken) {
      throw new Error(
        'MCP HTTP transport requires an auth token (--mcp-auth-token or VISOR_MCP_AUTH_TOKEN). ' +
          'Refusing to start an unauthenticated remote MCP endpoint.'
      );
    }

    // Create MCP server with send_message tool
    const mcpServer = new McpServer(
      { name: SERVER_INFO.name, version: SERVER_INFO.version },
      { capabilities: { tools: {} } }
    );

    const toolName = this.options.toolName || 'send_message';
    const toolDescription =
      this.options.toolDescription ||
      'Send a message to the Visor assistant. The assistant will process your message ' +
        'through the configured workflow and return a response. Use this for conversations, ' +
        'questions, task requests, and any interaction with the assistant.';

    if (this.options.asyncMode) {
      // Async job mode: register start_job and get_job instead of blocking tool
      const { JobManager } = await import('../mcp-job-manager');
      const jobManager = new JobManager();

      const startJobName = toolName === 'send_message' ? 'start_job' : `start_${toolName}`;

      (mcpServer as any).tool(
        startJobName,
        'Start a long-running job. Returns immediately with a job_id. ' +
          'You MUST then call get_job with this job_id repeatedly (every 10 seconds) until done is true.',
        {
          message: z.string().describe('The message to send to the assistant.'),
          session_id: z
            .string()
            .optional()
            .describe(
              'Optional conversation session ID for maintaining context across messages. ' +
                'If omitted, a new session is created.'
            ),
          idempotency_key: z
            .string()
            .optional()
            .describe('Optional stable key to prevent duplicate jobs for the same request.'),
        },
        async (args: { message: string; session_id?: string; idempotency_key?: string }) => {
          const response = jobManager.startJob(
            async () => this.handleMessage(args.message, args.session_id),
            args.idempotency_key
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
        }
      );

      (mcpServer as any).tool(
        'get_job',
        'Check the status of a running job. Returns the current progress and, when done, the final result. ' +
          'Call this every 10 seconds until done is true.',
        {
          job_id: z.string().describe('The job ID returned by start_job.'),
        },
        async (args: { job_id: string }) => {
          const response = jobManager.getJob(args.job_id);
          return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
        }
      );

      console.error(`Visor MCP frontend started in async job mode`);
    } else {
      (mcpServer as any).tool(
        toolName,
        toolDescription,
        {
          message: z.string().describe('The message to send to the assistant.'),
          session_id: z
            .string()
            .optional()
            .describe(
              'Optional conversation session ID for maintaining context across messages. ' +
                'If omitted, a new session is created. Re-use the same session_id for follow-up messages.'
            ),
        },
        async (args: { message: string; session_id?: string }) => {
          return this.handleMessage(args.message, args.session_id);
        }
      );
    }

    const { transports } = this;

    const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      try {
        // CORS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
          });
          res.end();
          return;
        }

        // Auth check (per MCP spec → OAuth 2.1 § 5.3 → RFC 6750 § 3)
        if (!validateBearerToken(req, authToken)) {
          const hasAuthHeader = !!req.headers['authorization'];
          const wwwAuth = hasAuthHeader
            ? 'Bearer error="invalid_token", error_description="The access token is invalid or expired"'
            : 'Bearer';
          res.writeHead(401, {
            'WWW-Authenticate': wwwAuth,
            'Content-Type': 'application/json',
          });
          res.end(
            JSON.stringify({
              error: hasAuthHeader ? 'invalid_token' : 'unauthorized',
              error_description: hasAuthHeader
                ? 'The access token is invalid or expired'
                : 'Authentication required. Provide a Bearer token in the Authorization header.',
            })
          );
          return;
        }

        // Only serve /mcp endpoint
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (url.pathname !== '/mcp') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (req.method === 'POST' && !sessionId) {
          // New session
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await mcpServer.connect(transport);
          const body = await readBody(req);
          await transport.handleRequest(req, res, body);
          if (transport.sessionId) transports.set(transport.sessionId, transport);
          return;
        }

        if (sessionId) {
          const transport = transports.get(sessionId);
          if (!transport) {
            if (req.method === 'DELETE') {
              // Nothing to close after restart; just acknowledge
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            // Session lost (e.g. server restart). Return 404 per MCP spec
            // so the client re-initializes with a fresh session. Also include
            // a JSON-RPC error response so clients that parse the body can
            // detect the "session expired" condition and auto-reconnect.
            const body = await readBody(req);
            const requestId = (body as any)?.id ?? null;
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                error: {
                  code: -32000,
                  message: 'Session expired. Please reconnect with a new session.',
                },
              })
            );
            return;
          }
          if (req.method === 'DELETE') {
            await transport.handleRequest(req, res);
            return;
          }
          const body = await readBody(req);
          await transport.handleRequest(req, res, body);
          return;
        }

        // GET without session (standalone SSE stream)
        if (req.method === 'GET') {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
          if (transport.sessionId) transports.set(transport.sessionId, transport);
          return;
        }

        res.writeHead(405);
        res.end('Method not allowed');
      } catch (err) {
        console.error(`[MCP] Request handler error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    };

    // Create HTTP or HTTPS server
    if (this.options.tlsCert && this.options.tlsKey) {
      const cert = fs.readFileSync(this.options.tlsCert);
      const key = fs.readFileSync(this.options.tlsKey);
      this.httpServer = https.createServer({ cert, key }, handleRequest);
      console.error(`Visor MCP frontend (HTTPS) listening on ${host}:${port}`);
    } else {
      this.httpServer = http.createServer(handleRequest);
      console.error(`Visor MCP frontend (HTTP) listening on ${host}:${port}`);
      if (host !== '127.0.0.1' && host !== 'localhost') {
        console.error(
          '⚠️  WARNING: Running without TLS on a non-localhost address. Use TLS for production.'
        );
      }
    }

    this.httpServer.listen(port, host);
  }

  /**
   * Stop listening for new connections and free the port so a new process can bind.
   * Existing in-flight requests continue processing (tracked via activeRequests).
   */
  async stopListening(): Promise<void> {
    this.draining = true;
    if (this.httpServer) {
      const server = this.httpServer;
      // Drop idle keep-alive connections so the port is freed quickly
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      // Wait for the server to fully close and release the port
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  /**
   * Enter drain mode: stop accepting new connections, wait for active requests to finish.
   * @param timeoutMs - Max wait time. 0 = unlimited (default).
   */
  async drain(timeoutMs = 0): Promise<void> {
    if (!this.draining) {
      await this.stopListening();
    }

    const startedAt = Date.now();
    while (this.activeRequests > 0) {
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Clean up transports
    for (const transport of this.transports.values()) {
      transport.close();
    }
    this.transports.clear();
    this.httpServer = null;
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) {
      transport.close();
    }
    this.transports.clear();
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  updateConfig(cfg: VisorConfig): void {
    this.cfg = cfg;
  }

  setTaskStore(store: TaskStore, configPath?: string): void {
    this.taskStore = store;
    this.configPath = configPath;
  }

  /**
   * Handle an incoming message by dispatching it through the engine,
   * following the same pattern as Slack/Telegram runners.
   */
  private async handleMessage(
    message: string,
    sessionId?: string
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    if (this.draining) {
      return {
        content: [
          { type: 'text' as const, text: 'The server is restarting. Please retry shortly.' },
        ],
        isError: true,
      };
    }
    this.activeRequests++;
    try {
      const { StateMachineExecutionEngine: SMEngine } = await import(
        '../state-machine-execution-engine'
      );
      const { createHash } = await import('crypto');

      // Create a dedicated engine for this run (same pattern as Slack)
      const runEngine = new SMEngine();

      // Propagate execution context from parent engine
      try {
        const parentCtx: any = (this.engine as any).getExecutionContext?.() || {};
        const prevCtx: any = (runEngine as any).getExecutionContext?.() || {};
        (runEngine as any).setExecutionContext?.({
          ...parentCtx,
          ...prevCtx,
        });
      } catch {}

      // Build conversation context (same structure as Slack/Telegram)
      const convSessionId = sessionId || crypto.randomUUID();
      const now = Date.now();
      const conversationContext = {
        transport: 'mcp',
        thread: { id: convSessionId },
        current: {
          user: 'mcp-client',
          text: message,
          timestamp: now,
        },
        messages: [
          {
            role: 'user',
            text: message,
            timestamp: now,
          },
        ],
      };

      // Build webhook payload (same pattern as Slack's payloadForContext)
      const endpoint = '/bots/mcp/message';
      const payload = {
        event: {
          type: 'message',
          text: message,
          user: 'mcp-client',
          timestamp: now,
        },
        mcp_conversation: conversationContext,
      };

      const webhookData = new Map<string, unknown>();
      webhookData.set(endpoint, payload);

      // Get all checks from config
      const allChecks = Object.keys(this.cfg.checks || {});
      if (allChecks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No checks configured in workflow.' }],
          isError: true,
        };
      }

      // Prepare config for run
      const cfgForRun: VisorConfig = (() => {
        try {
          const cfg = JSON.parse(JSON.stringify(this.cfg));
          return cfg;
        } catch {
          return this.cfg;
        }
      })();

      // Derive stable workspace name from session
      const hash = createHash('sha256').update(convSessionId).digest('hex').slice(0, 8);
      if (!(cfgForRun as any).workspace) {
        (cfgForRun as any).workspace = {};
      }
      (cfgForRun as any).workspace.name = `mcp-${hash}`;
      (cfgForRun as any).workspace.cleanup_on_exit = false;

      // Execute through the engine, wrapped in OTel tracing
      const execFn = () =>
        runEngine.executeChecks({
          checks: allChecks,
          showDetails: true,
          outputFormat: 'json',
          config: cfgForRun,
          webhookContext: { webhookData, eventType: 'manual' },
          debug: process.env.VISOR_DEBUG === 'true',
        } as any);

      const result = await withVisorRun(
        {
          ...getVisorRunAttributes(),
          'visor.run.source': 'mcp',
          'mcp.session_id': convSessionId,
          'mcp.message_length': message.length,
        },
        {
          source: 'mcp',
          workflowId: allChecks.join(','),
        },
        async () => {
          if (this.taskStore) {
            const { trackExecution } = await import('../agent-protocol/track-execution');
            return trackExecution(
              {
                taskStore: this.taskStore,
                source: 'mcp',
                workflowId: allChecks.join(','),
                configPath: this.configPath,
                messageText: message,
                metadata: { mcp_session: convSessionId },
              },
              execFn
            );
          }
          return execFn();
        }
      );

      // Extract response text from results
      // trackExecution wraps the result in { task, result } — unwrap if needed
      const rawResult = (result as any)?.result ?? result;
      const responseText = this.extractResponseText(rawResult);

      return {
        content: [
          {
            type: 'text' as const,
            text: responseText,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
        isError: true,
      };
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Extract a human-readable response from engine execution results.
   *
   * The result from executeChecks() has this structure:
   * {
   *   repositoryInfo, reviewSummary: { issues, history: Record<checkId, output[]> },
   *   executionStatistics: { checks: [...], groupedResults: { group: CheckResult[] } },
   *   checksExecuted: string[]
   * }
   *
   * The assistant response text is typically in:
   * 1. reviewSummary.history.<checkId>[last].text  (output history from journal)
   * 2. executionStatistics.groupedResults.<group>[].output.text (grouped check results)
   */
  private extractResponseText(result: any): string {
    if (!result) return 'No response from workflow.';

    // The output history (reviewSummary.history) contains outputs keyed by step ID.
    // For assistant workflows the steps are e.g. chat.route-intent, chat.build-config,
    // chat.generate-response. The final AI response is the LAST step that has a .text
    // field with substantial content (not a short routing label).
    const history = result?.reviewSummary?.history;
    if (history && typeof history === 'object') {
      // Collect all candidate text outputs, keeping the last (deepest) one
      let bestText = '';
      for (const [, outputs] of Object.entries(history)) {
        if (!Array.isArray(outputs)) continue;
        for (const item of outputs as any[]) {
          const text = item?.text ?? item?.output?.text;
          if (typeof text === 'string' && text.length > bestText.length) {
            bestText = text;
          }
        }
      }
      if (bestText) return bestText;
    }

    // Grouped results from execution statistics
    const grouped = result?.executionStatistics?.groupedResults;
    if (grouped && typeof grouped === 'object') {
      let bestText = '';
      for (const checkResults of Object.values(grouped)) {
        if (!Array.isArray(checkResults)) continue;
        for (const cr of checkResults as any[]) {
          const text =
            cr?.output?.text ??
            (typeof cr?.output === 'string' ? cr.output : null) ??
            (typeof cr?.content === 'string' && cr.content.trim() ? cr.content : null);
          if (typeof text === 'string' && text.length > bestText.length) {
            bestText = text;
          }
        }
      }
      if (bestText) return bestText;
    }

    // Direct properties on result
    if (result?.text) return String(result.text);
    if (result?.output?.text) return String(result.output.text);

    // Fallback: JSON dump (compact to avoid huge responses)
    try {
      const compact = history || grouped || result;
      return JSON.stringify(compact, null, 2);
    } catch {
      return 'Workflow completed but could not format response.';
    }
  }
}
