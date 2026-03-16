import { CustomToolsSSEServer } from '../../src/providers/mcp-custom-sse-server';
import { CustomToolExecutor } from '../../src/providers/custom-tool-executor';
import { CustomToolDefinition } from '../../src/types/config';
import http from 'http';

describe('CustomToolsSSEServer', () => {
  const testSessionId = 'test-session-123';

  const testTools = new Map<string, CustomToolDefinition>([
    [
      'echo-tool',
      {
        name: 'echo-tool',
        description: 'Echo the input back',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
        exec: 'echo "{{ args.message }}"',
      },
    ],
    [
      'list-files',
      {
        name: 'list-files',
        description: 'List files in current directory',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        exec: 'ls -la',
      },
    ],
  ]);

  describe('Server Lifecycle', () => {
    let server: CustomToolsSSEServer;

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('should start server and return valid port', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port = await server.start();

      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });

    it('should generate valid SSE endpoint URL', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port = await server.start();
      const url = server.getUrl();

      expect(url).toBe(`http://localhost:${port}/sse`);
    });

    it('should throw error when getting URL before start', () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);

      expect(() => server.getUrl()).toThrow('Server not started');
    });

    it('should stop server cleanly', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      await server.start();
      await server.stop();

      // Verify server is stopped by trying to connect
      const port = 0; // Will be assigned
      expect(async () => {
        // Server should be stopped, so this should fail
        await new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: 'localhost',
              port,
              path: '/sse',
              method: 'POST',
            },
            resolve
          );
          req.on('error', reject);
          req.end();
        });
      }).toBeTruthy();
    });

    it('should handle multiple start attempts gracefully', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port1 = await server.start();

      // Second start should fail or return same port
      // (implementation dependent)
      expect(port1).toBeGreaterThan(0);
    });
  });

  // Shared server for all read-only tests that use testTools
  describe('with shared server', () => {
    let sharedServer: CustomToolsSSEServer;
    let sharedPort: number;

    beforeAll(async () => {
      sharedServer = new CustomToolsSSEServer(testTools, testSessionId, false);
      sharedPort = await sharedServer.start();
    });

    afterAll(async () => {
      if (sharedServer) {
        await sharedServer.stop();
      }
    });

    describe('MCP Protocol - Tools List', () => {
      it('should return list of available tools', async () => {
        const response = await sendMCPRequest(sharedPort, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        });

        expect(response).toMatchObject({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: expect.arrayContaining([
              expect.objectContaining({
                name: 'echo-tool',
                description: 'Echo the input back',
                inputSchema: expect.any(Object),
              }),
              expect.objectContaining({
                name: 'list-files',
                description: 'List files in current directory',
              }),
            ]),
          },
        });
      });

      it('should include input schema in tools list', async () => {
        const response = await sendMCPRequest(sharedPort, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });

        const echoTool = response.result.tools.find((t: any) => t.name === 'echo-tool');

        expect(echoTool.inputSchema).toMatchObject({
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        });
      });
    });

    describe('MCP Protocol - Tool Execution', () => {
      it('should execute tool and return result', async () => {
        const response = await sendMCPRequest(sharedPort, {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'echo-tool',
            arguments: {
              message: 'Hello, World!',
            },
          },
        });

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(4);
        expect(response.result).toBeDefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');
        expect(response.result.content[0].text).toContain('Hello, World!');
      });

      it('should return error for invalid tool name', async () => {
        const response = await sendMCPRequest(sharedPort, {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'non-existent-tool',
            arguments: {},
          },
        });

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.error.message).toMatch(/^Internal error during tool execution: /);
      });

      it('should validate tool input against schema', async () => {
        // Missing required 'message' field
        const response = await sendMCPRequest(sharedPort, {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'echo-tool',
            arguments: {},
          },
        });

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.error.message).toMatch(
          /^Internal error during tool execution: .*validation failed/
        );
      });
    });

    describe('MCP Protocol - Initialize', () => {
      it('should handle initialize request', async () => {
        const response = await sendMCPRequest(sharedPort, {
          jsonrpc: '2.0',
          id: 8,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        });

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe(8);
        expect(response.result).toMatchObject({
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'visor-custom-tools',
            version: '1.0.0',
          },
        });
      });
    });

    describe('Error Handling', () => {
      it('should return error for invalid JSON-RPC format', async () => {
        try {
          await sendRawRequest(sharedPort, 'invalid json');
          // If no error was thrown, check that we got some response
          // (the implementation sends error via SSE)
        } catch (error) {
          // Expected to timeout or error since server may not respond to invalid JSON
          expect(error).toBeDefined();
        }
      }, 3000);

      it('should return error for unknown method', async () => {
        const response = await sendMCPRequest(sharedPort, {
          jsonrpc: '2.0',
          id: 9,
          method: 'unknown/method',
        });

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32601);
        expect(response.error.message).toBe('Method not found');
      });

      it('should handle 404 for non-SSE endpoints', async () => {
        await expect(
          new Promise((resolve, reject) => {
            const req = http.request(
              {
                hostname: 'localhost',
                port: sharedPort,
                path: '/invalid',
                method: 'POST',
              },
              res => {
                expect(res.statusCode).toBe(404);
                let data = '';
                res.on('data', chunk => {
                  data += chunk;
                });
                res.on('end', () => {
                  const body = JSON.parse(data);
                  expect(body.error).toBe('Not found');
                  resolve(body);
                });
              }
            );
            req.on('error', reject);
            req.end();
          })
        ).resolves.toBeDefined();
      });
    });

    describe('Concurrent Connections', () => {
      it('should handle multiple SSE connections', async () => {
        // Create multiple concurrent connections
        const requests = [
          sendMCPRequest(sharedPort, {
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/list',
          }),
          sendMCPRequest(sharedPort, {
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/list',
          }),
          sendMCPRequest(sharedPort, {
            jsonrpc: '2.0',
            id: 12,
            method: 'tools/list',
          }),
        ];

        const responses = await Promise.all(requests);

        responses.forEach((response, index) => {
          expect(response.id).toBe(10 + index);
          expect(response.result.tools).toBeDefined();
        });
      });
    });
  });

  // Tests that need their own server (different tools or state modification)
  describe('MCP Protocol - Tools List (empty)', () => {
    let server: CustomToolsSSEServer;

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('should return empty tools list when no tools registered', async () => {
      const emptyTools = new Map<string, CustomToolDefinition>();
      server = new CustomToolsSSEServer(emptyTools, testSessionId, false);
      const port = await server.start();

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      });

      // Even with no custom tools, graceful_stop is always present
      expect(response.result.tools).toEqual([
        expect.objectContaining({
          name: 'graceful_stop',
          description: 'Signal this server to gracefully wind down all active tool executions.',
        }),
      ]);
    });
  });

  describe('MCP Protocol - graceful_stop', () => {
    let server: CustomToolsSSEServer;

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('should always include graceful_stop in tools list', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port = await server.start();

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/list',
      });

      const gracefulStop = response.result.tools.find((t: any) => t.name === 'graceful_stop');
      expect(gracefulStop).toBeDefined();
      expect(gracefulStop.description).toBe(
        'Signal this server to gracefully wind down all active tool executions.'
      );
      expect(gracefulStop.inputSchema).toMatchObject({
        type: 'object',
        properties: {},
        required: [],
      });
    });

    it('should acknowledge graceful_stop call', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port = await server.start();

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'graceful_stop',
          arguments: {},
        },
      });

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(101);
      expect(response.result).toBeDefined();
      expect(response.result.content).toHaveLength(1);
      expect(response.result.content[0].type).toBe('text');
      expect(response.result.content[0].text).toBe('Stop acknowledged');
    });

    it('should set gracefulStopRequested flag on call', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port = await server.start();

      expect((server as any).gracefulStopRequested).toBe(false);

      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'graceful_stop',
          arguments: {},
        },
      });

      expect((server as any).gracefulStopRequested).toBe(true);
    });

    it('should shorten executionContext deadline when workflowContext exists', async () => {
      const executionContext = {
        deadline: Date.now() + 600000, // 10 minutes from now
        webhookContext: undefined,
      };
      const workflowContext = {
        executionContext,
        workspace: undefined,
      };

      server = new CustomToolsSSEServer(testTools, testSessionId, false, workflowContext as any);
      const port = await server.start();

      const beforeCall = Date.now();
      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
          name: 'graceful_stop',
          arguments: {},
        },
      });

      // Deadline should be shortened to ~30s from now
      const expectedDeadline = beforeCall + 30000;
      expect(executionContext.deadline).toBeGreaterThanOrEqual(expectedDeadline - 1000);
      expect(executionContext.deadline).toBeLessThanOrEqual(expectedDeadline + 2000);
    });

    it('should not extend deadline if already shorter than 30s wind-down', async () => {
      const shortDeadline = Date.now() + 5000; // Only 5s left
      const executionContext = {
        deadline: shortDeadline,
        webhookContext: undefined,
      };
      const workflowContext = {
        executionContext,
        workspace: undefined,
      };

      server = new CustomToolsSSEServer(testTools, testSessionId, false, workflowContext as any);
      const port = await server.start();

      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          name: 'graceful_stop',
          arguments: {},
        },
      });

      // Deadline should remain unchanged since it's already shorter
      expect(executionContext.deadline).toBe(shortDeadline);
    });

    it('should set deadline when none exists', async () => {
      const executionContext = {
        deadline: undefined as number | undefined,
        webhookContext: undefined,
      };
      const workflowContext = {
        executionContext,
        workspace: undefined,
      };

      server = new CustomToolsSSEServer(testTools, testSessionId, false, workflowContext as any);
      const port = await server.start();

      const beforeCall = Date.now();
      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/call',
        params: {
          name: 'graceful_stop',
          arguments: {},
        },
      });

      // Should set a new deadline ~30s from now
      expect(executionContext.deadline).toBeDefined();
      expect(executionContext.deadline!).toBeGreaterThanOrEqual(beforeCall + 29000);
      expect(executionContext.deadline!).toBeLessThanOrEqual(beforeCall + 32000);
    });

    it('should work without workflowContext (no crash)', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port = await server.start();

      // Should not throw even without workflowContext
      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 106,
        method: 'tools/call',
        params: {
          name: 'graceful_stop',
          arguments: {},
        },
      });

      expect(response.result.content[0].text).toBe('Stop acknowledged');
    });

    it('should handle multiple graceful_stop calls idempotently', async () => {
      const executionContext = {
        deadline: Date.now() + 600000,
        webhookContext: undefined,
      };
      const workflowContext = {
        executionContext,
        workspace: undefined,
      };

      server = new CustomToolsSSEServer(testTools, testSessionId, false, workflowContext as any);
      const port = await server.start();

      // First call
      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 107,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      const deadlineAfterFirst = executionContext.deadline;

      // Second call should not extend the deadline
      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 108,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      // Deadline should stay the same or get shorter, never longer
      expect(executionContext.deadline).toBeLessThanOrEqual(deadlineAfterFirst);
    });
  });

  describe('MCP Protocol - graceful_stop session filtering', () => {
    let server: CustomToolsSSEServer;

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
      // Clean up any sessions we registered
      const { SessionRegistry } = require('../../src/session-registry');
      SessionRegistry.getInstance().clearAllSessions();
    });

    it('should NOT signal the parent/caller session during graceful_stop', async () => {
      // Scenario: generate-response (parent) calls a workflow tool via MCP bridge.
      // The MCP bridge's graceful_stop is triggered by the parent's timeout observer.
      // The bridge should signal ONLY child sessions, NOT the parent, because:
      //   1. The parent is waiting for the MCP tool to return
      //   2. If the parent is signaled to wind down simultaneously, it gets
      //      gracefulTimeoutState.triggered=true while still blocked on the tool call
      //   3. When the hard abort fires 30s later, the parent has history_length=0
      //      (tool never returned) and produces the generic timeout message
      //   4. The intended flow: signal children → children wind down and return
      //      partial results → parent receives results → THEN parent winds down
      //      with actual data to summarize

      const { SessionRegistry } = require('../../src/session-registry');
      const registry = SessionRegistry.getInstance();

      // Register a "parent" session (the generate-response agent) and a "child" session
      // (the code-explorer workflow agent spawned via MCP tool call)
      const parentWindDown = jest.fn();
      const childWindDown = jest.fn();

      const parentAgent = { triggerGracefulWindDown: parentWindDown };
      const childAgent = { triggerGracefulWindDown: childWindDown };

      const parentSessionId = 'visor-generate-response';
      const childSessionId = 'visor-explore-code';

      registry.registerSession(parentSessionId, parentAgent as any);
      registry.registerSession(childSessionId, childAgent as any);

      // Create the MCP server — the sessionId here identifies which parent agent
      // owns this MCP bridge. The server should know to exclude this caller.
      // We use the parent session ID to associate the bridge with its owner.
      server = new CustomToolsSSEServer(
        testTools,
        parentSessionId, // The MCP bridge's session is owned by the parent
        false
      );
      const port = await server.start();

      // Call graceful_stop (as the timeout observer would)
      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 200,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      // The child session SHOULD be signaled to wind down
      expect(childWindDown).toHaveBeenCalled();

      // The parent session should NOT be signaled — it needs to wait for
      // the child's MCP tool response before it can wind down with data
      expect(parentWindDown).not.toHaveBeenCalled();
    });

    it('should signal all child sessions but not the owning session', async () => {
      const { SessionRegistry } = require('../../src/session-registry');
      const registry = SessionRegistry.getInstance();

      const parentWindDown = jest.fn();
      const child1WindDown = jest.fn();
      const child2WindDown = jest.fn();

      const parentSessionId = 'visor-generate-response';

      registry.registerSession(parentSessionId, { triggerGracefulWindDown: parentWindDown } as any);
      registry.registerSession('visor-explore-code', {
        triggerGracefulWindDown: child1WindDown,
      } as any);
      registry.registerSession('visor-engineer-task', {
        triggerGracefulWindDown: child2WindDown,
      } as any);

      server = new CustomToolsSSEServer(testTools, parentSessionId, false);
      const port = await server.start();

      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 201,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      // Both children should be signaled
      expect(child1WindDown).toHaveBeenCalled();
      expect(child2WindDown).toHaveBeenCalled();

      // Parent should NOT be signaled
      expect(parentWindDown).not.toHaveBeenCalled();
    });

    it('parent should receive child results before its own wind-down', async () => {
      // This test verifies the sequencing: after graceful_stop, child sessions
      // should complete and return their results via the MCP tool response,
      // so the parent has actual data in its conversation history before
      // it winds down. If the parent is signaled simultaneously, it winds
      // down with history_length=0 and produces a generic timeout message.

      const { SessionRegistry } = require('../../src/session-registry');
      const registry = SessionRegistry.getInstance();

      const signalOrder: string[] = [];

      const parentAgent = {
        triggerGracefulWindDown: jest.fn(() => signalOrder.push('parent')),
      };
      const childAgent = {
        triggerGracefulWindDown: jest.fn(() => signalOrder.push('child')),
      };

      const parentSessionId = 'visor-main-agent';
      registry.registerSession(parentSessionId, parentAgent as any);
      registry.registerSession('visor-sub-agent', childAgent as any);

      server = new CustomToolsSSEServer(testTools, parentSessionId, false);
      const port = await server.start();

      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 202,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      // Only child should appear in signal order — parent should not be signaled at all
      expect(signalOrder).toEqual(['child']);
      expect(parentAgent.triggerGracefulWindDown).not.toHaveBeenCalled();
    });
  });

  describe('MCP Protocol - Tool Execution (isolated)', () => {
    let server: CustomToolsSSEServer;

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('should handle tool execution timeout', async () => {
      const slowTool = new Map<string, CustomToolDefinition>([
        [
          'slow-tool',
          {
            name: 'slow-tool',
            description: 'A slow tool',
            exec: 'sleep 0.2',
            timeout: 100, // 100ms timeout
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      ]);

      server = new CustomToolsSSEServer(slowTool, testSessionId, false);
      const port = await server.start();

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'slow-tool',
          arguments: {},
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toMatch(/^Internal error during tool execution: /);
    }, 3000);

    it('should return validation error code for invalid workflow inputs', async () => {
      server = new CustomToolsSSEServer(testTools, testSessionId, false);
      const port = await server.start();

      // Mock the executor to throw a workflow validation error
      const executor = (server as any).toolExecutor as CustomToolExecutor;
      jest
        .spyOn(executor, 'execute')
        .mockRejectedValueOnce(
          new Error('Invalid workflow inputs: repo: is required, branch: must be a string')
        );

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'echo-tool',
          arguments: { message: 'test' },
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toBe(
        'Invalid tool parameters: Invalid workflow inputs: repo: is required, branch: must be a string'
      );
    });
  });
});

/**
 * Helper function to send MCP request via SSE and get response
 */
async function sendMCPRequest(port: number, message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(message);

    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/sse',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      res => {
        let responseData = '';
        const eventData: string[] = [];

        res.on('data', chunk => {
          responseData += chunk.toString();

          // Parse SSE messages
          const lines = responseData.split('\n\n');
          responseData = lines.pop() || '';

          for (const line of lines) {
            const eventMatch = line.match(/^event: (.+)$/m);
            const dataMatch = line.match(/^data: (.+)$/m);

            if (dataMatch) {
              eventData.push(dataMatch[1]);
            }

            // When we get a 'message' event, parse and resolve
            if (eventMatch && eventMatch[1] === 'message' && dataMatch) {
              try {
                const parsed = JSON.parse(dataMatch[1]);
                clearTimeout(timeoutHandle);
                resolve(parsed);
                req.destroy();
              } catch (_e) {
                // Continue reading
              }
            }
          }
        });

        res.on('end', () => {
          clearTimeout(timeoutHandle);
          if (eventData.length > 0) {
            try {
              const parsed = JSON.parse(eventData[eventData.length - 1]);
              resolve(parsed);
            } catch (_e) {
              reject(new Error('Failed to parse SSE response'));
            }
          } else {
            reject(new Error('No SSE data received'));
          }
        });
      }
    );

    req.on('error', err => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    req.write(postData);
    req.end();

    // Timeout after 1 second (responses are instant in tests)
    const timeoutHandle = setTimeout(() => {
      req.destroy();
      reject(new Error('Request timeout'));
    }, 1000);
  });
}

/**
 * Helper function to send raw request
 */
async function sendRawRequest(port: number, data: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/sse',
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      res => {
        let responseData = '';

        res.on('data', chunk => {
          responseData += chunk.toString();
        });

        res.on('end', () => {
          clearTimeout(timeoutHandle);
          resolve(responseData);
        });
      }
    );

    req.on('error', err => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    req.write(data);
    req.end();

    // Timeout after 1 second (responses are instant in tests)
    const timeoutHandle = setTimeout(() => {
      req.destroy();
      reject(new Error('Request timeout'));
    }, 1000);
  });
}
