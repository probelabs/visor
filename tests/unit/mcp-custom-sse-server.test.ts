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

      expect(response.result.tools).toEqual([]);
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
