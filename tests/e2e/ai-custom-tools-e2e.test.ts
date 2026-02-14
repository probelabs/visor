/**
 * E2E Test: AI Custom Tools Workflow
 *
 * This test demonstrates the full workflow of using custom tools
 * with AI checks via ephemeral SSE MCP servers.
 *
 * Scenario:
 * 1. Define custom tools in visor config (grep-pattern, check-secrets)
 * 2. Configure AI check with ai_custom_tools option
 * 3. AI uses custom tools to analyze code
 * 4. Server automatically starts, executes tools, and cleans up
 */

import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { CustomToolDefinition } from '../../src/types/config';
import { CustomToolsSSEServer } from '../../src/providers/mcp-custom-sse-server';
import http from 'http';

describe('AI Custom Tools E2E Workflow', () => {
  // Skip if no AI provider is configured
  const hasAIProvider =
    process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY;

  const testCondition = hasAIProvider ? it : it.skip;

  // Reserved for future use in AI-powered tests
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mockPRInfo: PRInfo = {
    number: 123,
    title: 'Add new authentication feature',
    body: 'This PR adds OAuth2 authentication support',
    author: 'developer',
    head: 'feature/oauth',
    base: 'main',
    files: [
      {
        filename: 'src/auth.ts',
        status: 'added',
        additions: 50,
        deletions: 0,
        changes: 50,
        patch: `
+export function authenticate(token: string) {
+  const secret = "hardcoded-secret-123"; // TODO: Move to env
+  return validateToken(token, secret);
+}
        `,
      },
    ],
    isIncremental: false,
    isIssue: false,
    totalAdditions: 50,
    totalDeletions: 0,
  };

  describe('Full Workflow with Custom Tools', () => {
    testCondition(
      'should execute AI check with custom grep tool',
      async () => {
        const customTools: Record<string, CustomToolDefinition> = {
          'grep-pattern': {
            name: 'grep-pattern',
            description: 'Search for patterns in code',
            inputSchema: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'Pattern to search for' },
              },
              required: ['pattern'],
            },
            exec: 'echo "Found TODO comment at line 2"',
            parseJson: false,
          },
        };

        const provider = new AICheckProvider();
        const config: CheckProviderConfig = {
          type: 'ai',
          prompt: `
You are a code reviewer. You have access to the grep-pattern tool.

Use the grep-pattern tool to find all TODO comments in the code.
Report any TODOs you find as issues.
        `.trim(),
          checkName: 'find-todos',
          ai_custom_tools: ['grep-pattern'],
          __globalTools: customTools,
          ai: {
            provider: 'mock' as any,
            debug: true,
          },
        } as any;

        const isValid = await provider.validateConfig(config);
        expect(isValid).toBe(true);

        // Note: Full execution would require mocking AI service
        // This test validates the configuration is correct
      },
      15000
    );

    it('should demonstrate SSE server lifecycle', async () => {
      const customTools = new Map<string, CustomToolDefinition>([
        [
          'check-secrets',
          {
            name: 'check-secrets',
            description: 'Check for hardcoded secrets',
            inputSchema: {
              type: 'object',
              properties: {
                file: { type: 'string' },
              },
              required: ['file'],
            },
            exec: 'echo "Warning: Found hardcoded secret at src/auth.ts:2"',
          },
        ],
      ]);

      const server = new CustomToolsSSEServer(customTools, 'e2e-test', true);

      // 1. Start server
      const port = await server.start();
      expect(port).toBeGreaterThan(0);

      console.log(`✓ SSE server started on port ${port}`);

      // 2. Get server URL
      const url = server.getUrl();
      expect(url).toBe(`http://localhost:${port}/sse`);

      console.log(`✓ SSE endpoint available at ${url}`);

      // 3. Test tools/list
      const toolsList = await callMCPMethod(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      });

      expect(toolsList.result.tools).toHaveLength(1);
      expect(toolsList.result.tools[0].name).toBe('check-secrets');

      console.log(`✓ Tools list retrieved: ${toolsList.result.tools.length} tools`);

      // 4. Test tools/call
      const callResult = await callMCPMethod(port, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'check-secrets',
          arguments: {
            file: 'src/auth.ts',
          },
        },
      });

      expect(callResult.result).toBeDefined();
      expect(callResult.result.content[0].text).toContain('hardcoded secret');

      console.log(`✓ Tool executed successfully`);

      // 5. Stop server
      await server.stop();

      console.log(`✓ SSE server stopped cleanly`);

      // 6. Verify server is stopped
      await expect(
        callMCPMethod(port, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
        })
      ).rejects.toThrow();

      console.log(`✓ Server cleanup verified`);
    }, 15000);
  });

  describe('Concurrent Execution Scenario', () => {
    it('should handle multiple AI checks with separate SSE servers', async () => {
      const tools1 = new Map<string, CustomToolDefinition>([
        [
          'tool-a',
          {
            name: 'tool-a',
            description: 'Tool A',
            exec: 'echo "Tool A output"',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      ]);

      const tools2 = new Map<string, CustomToolDefinition>([
        [
          'tool-b',
          {
            name: 'tool-b',
            description: 'Tool B',
            exec: 'echo "Tool B output"',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      ]);

      const server1 = new CustomToolsSSEServer(tools1, 'check-1', false);
      const server2 = new CustomToolsSSEServer(tools2, 'check-2', false);

      try {
        // Start both servers
        const port1 = await server1.start();
        const port2 = await server2.start();

        console.log(`✓ Server 1 started on port ${port1}`);
        console.log(`✓ Server 2 started on port ${port2}`);

        // Verify they got different ports
        expect(port1).not.toBe(port2);

        // Verify each server has its own tools
        const list1 = await callMCPMethod(port1, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        });

        const list2 = await callMCPMethod(port2, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        });

        expect(list1.result.tools[0].name).toBe('tool-a');
        expect(list2.result.tools[0].name).toBe('tool-b');

        console.log(`✓ Each server serving different tools correctly`);

        // Execute tools concurrently
        const [result1, result2] = await Promise.all([
          callMCPMethod(port1, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'tool-a',
              arguments: {},
            },
          }),
          callMCPMethod(port2, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'tool-b',
              arguments: {},
            },
          }),
        ]);

        expect(result1.result.content[0].text).toContain('Tool A output');
        expect(result2.result.content[0].text).toContain('Tool B output');

        console.log(`✓ Concurrent tool execution successful`);
      } finally {
        await Promise.all([server1.stop(), server2.stop()]);
        console.log(`✓ Both servers stopped cleanly`);
      }
    }, 15000);
  });

  describe('Error Scenarios', () => {
    it('should handle tool execution errors gracefully', async () => {
      const failingTool = new Map<string, CustomToolDefinition>([
        [
          'failing-tool',
          {
            name: 'failing-tool',
            description: 'A tool that fails',
            exec: 'exit 1',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      ]);

      const server = new CustomToolsSSEServer(failingTool, 'error-test', false);

      try {
        const port = await server.start();

        const result = await callMCPMethod(port, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'failing-tool',
            arguments: {},
          },
        });

        // Should return error, not throw
        expect(result.error).toBeDefined();
        expect(result.error.code).toBe(-32603);

        console.log(`✓ Tool execution error handled gracefully`);
      } finally {
        await server.stop();
      }
    }, 10000);

    it('should validate tool arguments against schema', async () => {
      const strictTool = new Map<string, CustomToolDefinition>([
        [
          'strict-tool',
          {
            name: 'strict-tool',
            description: 'Tool with strict schema',
            inputSchema: {
              type: 'object',
              properties: {
                required_field: { type: 'string' },
              },
              required: ['required_field'],
            },
            exec: 'echo "{{ args.required_field }}"',
          },
        ],
      ]);

      const server = new CustomToolsSSEServer(strictTool, 'validation-test', false);

      try {
        const port = await server.start();

        // Call with missing required field
        const result = await callMCPMethod(port, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'strict-tool',
            arguments: {}, // Missing required_field
          },
        });

        // Expect an error response (JSON-RPC error or result with error content)
        const errorMsg =
          result.error?.data?.error ||
          result.error?.message ||
          result.result?.content?.[0]?.text ||
          '';
        expect(errorMsg).toMatch(/validation failed|required/i);

        console.log(`✓ Schema validation working correctly`);
      } finally {
        await server.stop();
      }
    }, 10000);
  });

  describe('Example Use Case: Security Review', () => {
    it('should demonstrate security review workflow with custom tools', async () => {
      const securityTools = new Map<string, CustomToolDefinition>([
        [
          'scan-secrets',
          {
            name: 'scan-secrets',
            description: 'Scan for potential secrets in code',
            inputSchema: {
              type: 'object',
              properties: {
                patterns: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
            exec: 'echo "Found 1 potential secret: hardcoded API key"',
          },
        ],
        [
          'check-dependencies',
          {
            name: 'check-dependencies',
            description: 'Check for vulnerable dependencies',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            exec: 'echo "No vulnerable dependencies found"',
          },
        ],
      ]);

      const server = new CustomToolsSSEServer(securityTools, 'security-review', true);

      try {
        const port = await server.start();

        console.log('\n=== Security Review Workflow ===');
        console.log(`Starting security review tools on port ${port}`);

        // 1. List available security tools
        const toolsList = await callMCPMethod(port, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        });

        console.log(`\nAvailable security tools:`);
        toolsList.result.tools.forEach((tool: any) => {
          console.log(`  - ${tool.name}: ${tool.description}`);
        });

        // 2. Run secret scan
        const secretScan = await callMCPMethod(port, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'scan-secrets',
            arguments: {
              patterns: ['api[_-]key', 'secret', 'password'],
            },
          },
        });

        console.log(`\nSecret scan result:`);
        console.log(`  ${secretScan.result.content[0].text}`);

        // 3. Check dependencies
        const depCheck = await callMCPMethod(port, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'check-dependencies',
            arguments: {},
          },
        });

        console.log(`\nDependency check result:`);
        console.log(`  ${depCheck.result.content[0].text}`);

        console.log(`\n✓ Security review completed successfully`);
        console.log('=================================\n');

        expect(secretScan.result).toBeDefined();
        expect(depCheck.result).toBeDefined();
      } finally {
        await server.stop();
      }
    }, 15000);
  });
});

/**
 * Helper to call MCP method via HTTP SSE
 */
async function callMCPMethod(port: number, message: any): Promise<any> {
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

        res.on('data', chunk => {
          responseData += chunk.toString();

          // Parse SSE messages
          const lines = responseData.split('\n\n');

          for (const line of lines) {
            const dataMatch = line.match(/^data: (.+)$/m);

            if (dataMatch) {
              try {
                const parsed = JSON.parse(dataMatch[1]);
                if (parsed.id === message.id) {
                  resolve(parsed);
                  req.destroy();
                  return;
                }
              } catch (_e) {
                // Continue parsing
              }
            }
          }
        });

        res.on('end', () => {
          reject(new Error('Connection closed without response'));
        });
      }
    );

    req.on('error', reject);
    req.write(postData);
    req.end();

    setTimeout(() => {
      req.destroy();
      reject(new Error('Request timeout'));
    }, 10000);
  });
}
