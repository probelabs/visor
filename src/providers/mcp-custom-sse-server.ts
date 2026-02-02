import { CustomToolDefinition } from '../types/config';
import { CustomToolExecutor } from './custom-tool-executor';
import { logger } from '../logger';
import http from 'http';
import { EventEmitter } from 'events';
import {
  isWorkflowTool,
  executeWorkflowAsTool,
  WorkflowToolDefinition,
  WorkflowToolContext,
} from './workflow-tool-executor';

/**
 * MCP Protocol message types
 */
interface MCPMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * MCP Tools List Response
 */
interface MCPToolsListResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: {
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    }>;
  };
}

/**
 * MCP Tool Call Request
 */
interface MCPToolCallRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * MCP Tool Call Response
 */
interface MCPToolCallResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: {
    content: Array<{
      type: 'text';
      text: string;
    }>;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * SSE Client Connection
 */
interface SSEConnection {
  response: http.ServerResponse;
  id: string;
}

/**
 * Custom MCP Server interface
 */
export interface CustomMCPServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  getUrl(): string;
}

/**
 * SSE-based MCP server that exposes custom tools from YAML configuration
 * Implements the Model Context Protocol over Server-Sent Events
 */
export class CustomToolsSSEServer implements CustomMCPServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private connections: Set<SSEConnection> = new Set();
  private toolExecutor: CustomToolExecutor;
  private sessionId: string;
  private debug: boolean;
  private eventBus: EventEmitter;
  private messageQueue: Map<string, MCPMessage[]> = new Map();
  private tools: Map<string, CustomToolDefinition>;
  private workflowContext?: WorkflowToolContext;

  constructor(
    tools: Map<string, CustomToolDefinition>,
    sessionId: string,
    debug: boolean = false,
    workflowContext?: WorkflowToolContext
  ) {
    this.sessionId = sessionId;
    this.debug = debug;
    this.eventBus = new EventEmitter();
    this.tools = tools;
    this.workflowContext = workflowContext;

    // Convert Map to Record for CustomToolExecutor (only for non-workflow tools)
    const toolsRecord: Record<string, CustomToolDefinition> = {};
    const workflowToolNames: string[] = [];
    for (const [name, tool] of tools.entries()) {
      // Skip workflow tools - they're handled separately
      if (!isWorkflowTool(tool)) {
        toolsRecord[name] = tool;
      } else {
        workflowToolNames.push(name);
      }
    }

    // Warn if workflow tools are present but no context is provided
    if (workflowToolNames.length > 0 && !workflowContext) {
      logger.warn(
        `[CustomToolsSSEServer:${sessionId}] ${workflowToolNames.length} workflow tool(s) registered but no workflowContext provided. ` +
          `Tools [${workflowToolNames.join(', ')}] will fail at runtime. ` +
          `Pass workflowContext to enable workflow tool execution.`
      );
    }

    this.toolExecutor = new CustomToolExecutor(toolsRecord);

    if (this.debug) {
      const workflowToolCount = workflowToolNames.length;
      const regularToolCount = tools.size - workflowToolCount;
      logger.debug(
        `[CustomToolsSSEServer:${sessionId}] Initialized with ${regularToolCount} regular tools and ${workflowToolCount} workflow tools`
      );
    }
  }

  /**
   * Start the SSE server on an ephemeral port
   * Returns the actual bound port number
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server
        this.server = http.createServer((req, res) => {
          this.handleRequest(req, res).catch(error => {
            logger.error(
              `[CustomToolsSSEServer:${this.sessionId}] Request handler error: ${error}`
            );
          });
        });

        // Error handler
        this.server.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            // Port in use, let the OS pick another one
            if (this.debug) {
              logger.debug(
                `[CustomToolsSSEServer:${this.sessionId}] Port ${this.port} in use, retrying with new port`
              );
            }
            reject(new Error(`Port ${this.port} already in use`));
          } else {
            reject(error);
          }
        });

        // Listen on ephemeral port (0 = OS assigns)
        this.server.listen(0, 'localhost', () => {
          const address = this.server!.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to bind to port'));
            return;
          }

          this.port = address.port;
          if (this.debug) {
            logger.debug(
              `[CustomToolsSSEServer:${this.sessionId}] Started on http://localhost:${this.port}/sse`
            );
          }

          resolve(this.port);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server and cleanup resources
   */
  async stop(): Promise<void> {
    if (this.debug) {
      logger.debug(`[CustomToolsSSEServer:${this.sessionId}] Stopping server...`);
    }

    // Close all SSE connections
    for (const connection of this.connections) {
      try {
        connection.response.end();
      } catch (error) {
        if (this.debug) {
          logger.debug(
            `[CustomToolsSSEServer:${this.sessionId}] Error closing connection: ${error}`
          );
        }
      }
    }
    this.connections.clear();

    // Stop the HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // Force close after 5s
          if (this.debug) {
            logger.debug(
              `[CustomToolsSSEServer:${this.sessionId}] Force closing server after timeout`
            );
          }
          this.server?.close(() => resolve());
        }, 5000);

        this.server!.close(error => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      this.server = null;
    }

    if (this.debug) {
      logger.debug(`[CustomToolsSSEServer:${this.sessionId}] Server stopped`);
    }
  }

  /**
   * Get the SSE endpoint URL
   */
  getUrl(): string {
    if (!this.port) {
      throw new Error('Server not started');
    }
    return `http://localhost:${this.port}/sse`;
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      this.handleCORS(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /sse - Establish SSE connection (MCP standard pattern)
    if (req.method === 'GET' && url.pathname === '/sse') {
      this.handleSSEConnection(req, res);
      return;
    }

    // POST /sse - Combined SSE connection with initial message (legacy pattern for tests)
    if (req.method === 'POST' && url.pathname === '/sse') {
      await this.handleLegacySSEPost(req, res);
      return;
    }

    // POST /message - Handle MCP messages (MCP standard pattern)
    if (req.method === 'POST' && url.pathname === '/message') {
      await this.handleMessage(req, res);
      return;
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /**
   * Handle legacy POST /sse pattern (connection + message in one request)
   * This maintains backward compatibility with tests
   */
  private async handleLegacySSEPost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Setup SSE headers
    this.handleCORS(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Create connection
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const connection: SSEConnection = {
      response: res,
      id: connectionId,
    };
    this.connections.add(connection);

    if (this.debug) {
      logger.debug(
        `[CustomToolsSSEServer:${this.sessionId}] Legacy SSE POST connection: ${connectionId}`
      );
    }

    // Parse request body and handle message
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        if (body.trim()) {
          const message = JSON.parse(body) as MCPMessage;
          await this.handleMCPMessage(connection, message);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        if (this.debug) {
          logger.error(
            `[CustomToolsSSEServer:${this.sessionId}] Error in legacy SSE POST: ${errorMsg}`
          );
        }
        this.sendErrorResponse(connection, null, -32700, 'Parse error', { error: errorMsg });
      }
    });

    // Handle disconnect
    req.on('close', () => {
      this.connections.delete(connection);
    });
  }

  /**
   * Handle SSE connection establishment (GET /sse)
   */
  private handleSSEConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Setup SSE headers
    this.handleCORS(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Create connection ID
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    // Register connection
    const connection: SSEConnection = {
      response: res,
      id: connectionId,
    };
    this.connections.add(connection);

    if (this.debug) {
      logger.debug(`[CustomToolsSSEServer:${this.sessionId}] New SSE connection: ${connectionId}`);
    }

    // Send initial endpoint message with session ID for message routing
    this.sendSSE(
      connection,
      'endpoint',
      `http://localhost:${this.port}/message?sessionId=${connectionId}`
    );

    // Handle client disconnect
    req.on('close', () => {
      if (this.debug) {
        logger.debug(`[CustomToolsSSEServer:${this.sessionId}] Connection closed: ${connectionId}`);
      }
      this.connections.delete(connection);
    });
  }

  /**
   * Handle MCP message (POST /message)
   */
  private async handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const sessionId = url.searchParams.get('sessionId');

    // Find the connection for this session
    let connection: SSEConnection | undefined;
    for (const conn of this.connections) {
      if (conn.id === sessionId) {
        connection = conn;
        break;
      }
    }

    if (!connection) {
      // If no specific connection found, use the first available (for backwards compatibility)
      connection = this.connections.values().next().value;
    }

    if (!connection) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active SSE connection' }));
      return;
    }

    // Parse request body
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const message = JSON.parse(body) as MCPMessage;

        if (this.debug) {
          logger.debug(
            `[CustomToolsSSEServer:${this.sessionId}] Received message: ${JSON.stringify(message)}`
          );
        }

        await this.handleMCPMessage(connection!, message);

        // Acknowledge the POST request
        this.handleCORS(res);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        if (this.debug) {
          logger.error(
            `[CustomToolsSSEServer:${this.sessionId}] Error parsing message: ${errorMsg}`
          );
        }
        this.sendErrorResponse(connection!, null, -32700, 'Parse error', { error: errorMsg });

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Parse error', details: errorMsg }));
      }
    });
  }

  /**
   * Handle CORS headers
   */
  private handleCORS(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  /**
   * Send SSE message to client
   */
  private sendSSE(connection: SSEConnection, event: string, data: unknown): void {
    try {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

      // Log SSE message being sent (important for debugging MCP communication)
      const preview =
        dataStr.length > 300
          ? `${dataStr.substring(0, 150)}...${dataStr.substring(dataStr.length - 150)}`
          : dataStr;
      logger.debug(
        `[CustomToolsSSEServer:${this.sessionId}] Sending SSE event='${event}' size=${dataStr.length} preview=${preview}`
      );

      connection.response.write(`event: ${event}\n`);
      connection.response.write(`data: ${dataStr}\n\n`);

      logger.debug(
        `[CustomToolsSSEServer:${this.sessionId}] SSE message sent successfully, event='${event}'`
      );
    } catch (error) {
      logger.error(`[CustomToolsSSEServer:${this.sessionId}] Error sending SSE: ${error}`);
    }
  }

  /**
   * Handle MCP protocol messages
   */
  private async handleMCPMessage(connection: SSEConnection, message: MCPMessage): Promise<void> {
    if (this.debug) {
      logger.debug(
        `[CustomToolsSSEServer:${this.sessionId}] Received MCP message: ${JSON.stringify(message)}`
      );
    }

    // Handle tools/list request
    if (message.method === 'tools/list') {
      const response = await this.handleToolsList(message.id!);
      this.sendSSE(connection, 'message', response);
      return;
    }

    // Handle tools/call request
    if (message.method === 'tools/call') {
      const request = message as MCPToolCallRequest;
      const argsPreview = JSON.stringify(request.params.arguments).substring(0, 200);
      logger.info(
        `[CustomToolsSSEServer:${this.sessionId}] Received tools/call for '${request.params.name}' id=${request.id} args=${argsPreview}`
      );

      const response = await this.handleToolCall(
        request.id,
        request.params.name,
        request.params.arguments
      );

      logger.info(
        `[CustomToolsSSEServer:${this.sessionId}] Sending response for '${request.params.name}' id=${request.id} hasError=${!!response.error}`
      );
      this.sendSSE(connection, 'message', response);
      return;
    }

    // Handle initialize request
    if (message.method === 'initialize') {
      const response: MCPMessage = {
        jsonrpc: '2.0',
        id: message.id!,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'visor-custom-tools',
            version: '1.0.0',
          },
        },
      };
      this.sendSSE(connection, 'message', response);
      return;
    }

    // Handle notifications/initialized
    if (message.method === 'notifications/initialized') {
      // No response needed for notifications
      return;
    }

    // Unknown method
    this.sendErrorResponse(connection, message.id!, -32601, 'Method not found');
  }

  /**
   * Handle tools/list MCP request
   */
  private async handleToolsList(id: number | string): Promise<MCPToolsListResponse> {
    // Get all tools from the tools map (includes both regular and workflow tools)
    const allTools = Array.from(this.tools.values());

    if (this.debug) {
      logger.debug(
        `[CustomToolsSSEServer:${this.sessionId}] Listing ${allTools.length} tools: ${allTools.map(t => t.name).join(', ')}`
      );
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: allTools.map(tool => ({
          name: tool.name,
          description: tool.description || `Execute ${tool.name}`,
          inputSchema: tool.inputSchema || {
            type: 'object',
            properties: {},
            required: [],
          },
        })),
      },
    };
  }

  /**
   * Handle tools/call MCP request
   */
  private async handleToolCall(
    id: number | string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResponse> {
    try {
      if (this.debug) {
        logger.debug(
          `[CustomToolsSSEServer:${this.sessionId}] Executing tool: ${toolName} with args: ${JSON.stringify(args)}`
        );
      }

      let result: unknown;

      // Check if this is a workflow tool
      const tool = this.tools.get(toolName);
      if (tool && isWorkflowTool(tool)) {
        // Execute workflow tool
        if (!this.workflowContext) {
          throw new Error(
            `Workflow tool '${toolName}' requires workflow context but none was provided`
          );
        }

        if (this.debug) {
          logger.debug(
            `[CustomToolsSSEServer:${this.sessionId}] Executing workflow tool: ${toolName}`
          );
        }

        const workflowTool = tool as WorkflowToolDefinition;
        result = await executeWorkflowAsTool(
          workflowTool.__workflowId,
          args,
          this.workflowContext,
          workflowTool.__argsOverrides
        );
      } else {
        // Execute regular custom tool
        result = await this.toolExecutor.execute(toolName, args);
      }

      // Format result as MCP response
      const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // Always log tool completion with result details (important for debugging MCP issues)
      const resultPreview =
        resultText.length > 500
          ? `${resultText.substring(0, 250)}...TRUNCATED(${resultText.length} chars)...${resultText.substring(resultText.length - 250)}`
          : resultText;
      logger.info(
        `[CustomToolsSSEServer:${this.sessionId}] Tool ${toolName} completed. Result size: ${resultText.length} chars`
      );
      logger.debug(
        `[CustomToolsSSEServer:${this.sessionId}] Tool ${toolName} result preview: ${resultPreview}`
      );

      const response: MCPToolCallResponse = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        },
      };

      logger.debug(
        `[CustomToolsSSEServer:${this.sessionId}] Returning MCP response for ${toolName}, id=${id}, content_length=${resultText.length}`
      );

      return response;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        `[CustomToolsSSEServer:${this.sessionId}] Tool execution failed: ${toolName} - ${errorMsg}`
      );

      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: {
            tool: toolName,
            error: errorMsg,
          },
        },
      };
    }
  }

  /**
   * Send error response via SSE
   */
  private sendErrorResponse(
    connection: SSEConnection,
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown
  ): void {
    const errorResponse: MCPMessage = {
      jsonrpc: '2.0',
      id: id ?? 'error',
      error: {
        code,
        message,
        data,
      },
    };

    this.sendSSE(connection, 'message', errorResponse);
  }
}
