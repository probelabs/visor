/**
 * End-to-end test for graceful_stop MCP tool propagation.
 *
 * Simulates the real-world scenario:
 *   Parent ProbeAgent (assistant) ──MCP──▶ Visor SSE Server ──▶ sub-workflow (engineer)
 *                                                ▲
 *              graceful_stop call ────────────────┘
 *
 * When graceful_stop is called:
 * 1. executionContext.deadline is shortened (30s wind-down window)
 * 2. All active ProbeAgent sessions get triggerGracefulWindDown()
 * 3. Currently-running workflow tool sees shortened deadline at next check dispatch
 * 4. The sub-workflow's AI step receives the wind-down signal
 */

import { CustomToolsSSEServer } from '../../src/providers/mcp-custom-sse-server';
import { CustomToolDefinition } from '../../src/types/config';
import { SessionRegistry } from '../../src/session-registry';
import http from 'http';

// ---------------------------------------------------------------------------
// Mock ProbeAgent that tracks graceful wind-down calls
// ---------------------------------------------------------------------------
class MockProbeAgent {
  public sessionId: string;
  public windDownTriggered = false;
  public maxOperationTimeout?: number;
  private _gracefulTimeoutState = { triggered: false };

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  triggerGracefulWindDown() {
    this._gracefulTimeoutState.triggered = true;
    this.windDownTriggered = true;
  }

  get gracefulTimeoutTriggered() {
    return this._gracefulTimeoutState.triggered;
  }

  cleanup() {
    // no-op for test
  }
}

// ---------------------------------------------------------------------------
// Mock workflow tool that simulates a long-running sub-workflow with an AI step.
// It checks executionContext.deadline between "steps" and returns partial results
// if the deadline is shortened.
// ---------------------------------------------------------------------------
function createLongRunningWorkflowTool(): CustomToolDefinition & {
  getState: () => { running: boolean; stepsCompleted: number; interrupted: boolean };
  setExecutionContext: (ctx: { deadline?: number }) => void;
} {
  const state = {
    running: false,
    stepsCompleted: 0,
    interrupted: false,
    executionContext: null as { deadline?: number } | null,
  };

  const tool: any = {
    name: 'engineer',
    description: 'Run the engineer sub-workflow (simulated)',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    },
    // exec is used by CustomToolExecutor, but we'll intercept via jest mock
  };

  tool.getState = () => ({
    running: state.running,
    stepsCompleted: state.stepsCompleted,
    interrupted: state.interrupted,
  });

  tool.setExecutionContext = (ctx: { deadline?: number }) => {
    state.executionContext = ctx;
  };

  // The actual long-running handler that checks deadline between steps
  tool._handler = async () => {
    state.running = true;
    state.stepsCompleted = 0;
    state.interrupted = false;

    for (let i = 0; i < 20; i++) {
      // Check deadline (mirrors execution-invoker.ts deadline check)
      if (state.executionContext?.deadline) {
        const remaining = state.executionContext.deadline - Date.now();
        if (remaining <= 0) {
          state.interrupted = true;
          state.running = false;
          return `Interrupted after ${state.stepsCompleted} steps: deadline exceeded`;
        }
      }

      state.stepsCompleted++;
      // Simulate work (50ms per step = 1000ms total if uninterrupted)
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    state.running = false;
    return `Completed all ${state.stepsCompleted} steps`;
  };

  return tool;
}

// ---------------------------------------------------------------------------
// Helper: send MCP request over HTTP (same as in mcp-custom-sse-server.test.ts)
// ---------------------------------------------------------------------------
async function sendMCPRequest(port: number, message: any, timeoutMs = 5000): Promise<any> {
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
          const lines = responseData.split('\n\n');
          responseData = lines.pop() || '';

          for (const line of lines) {
            const eventMatch = line.match(/^event: (.+)$/m);
            const dataMatch = line.match(/^data: (.+)$/m);

            if (eventMatch && eventMatch[1] === 'message' && dataMatch) {
              try {
                const parsed = JSON.parse(dataMatch[1]);
                clearTimeout(timeoutHandle);
                resolve(parsed);
                req.destroy();
              } catch {
                // Continue reading
              }
            }
          }
        });

        res.on('end', () => {
          clearTimeout(timeoutHandle);
          reject(new Error('Connection ended before response'));
        });
      }
    );

    req.on('error', err => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    req.write(postData);
    req.end();

    const timeoutHandle = setTimeout(() => {
      req.destroy();
      reject(new Error('Request timeout'));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('graceful_stop end-to-end propagation', () => {
  let server: CustomToolsSSEServer;
  let registry: SessionRegistry;

  beforeEach(() => {
    // Get a fresh registry for each test
    registry = SessionRegistry.getInstance();
    // Clear any leftover sessions
    registry.clearAllSessions();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    registry.clearAllSessions();
  });

  describe('Scenario: Assistant → Engineer sub-workflow', () => {
    it('graceful_stop shortens deadline AND signals active ProbeAgent sessions', async () => {
      // Setup: shared execution context (simulates the parent engine context)
      const executionContext = {
        deadline: Date.now() + 600000, // 10 minutes from now
      };
      const workflowContext = {
        executionContext,
        workspace: undefined,
        prInfo: { number: 1, title: 'test', author: 'test', files: [], commits: [] },
      };

      // Setup: register mock ProbeAgent sessions (simulates sub-workflow AI steps)
      const engineerAgent = new MockProbeAgent('engineer-session-001');
      const codeTalkAgent = new MockProbeAgent('code-talk-session-001');
      registry.registerSession('engineer-session-001', engineerAgent as any);
      registry.registerSession('code-talk-session-001', codeTalkAgent as any);

      // Setup: MCP server with a regular tool (the workflow tool would normally
      // be auto-registered, but for this test we just need any tool + graceful_stop)
      const tools = new Map<string, CustomToolDefinition>([
        [
          'echo',
          {
            name: 'echo',
            description: 'Echo test',
            inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
            exec: 'echo "{{ args.msg }}"',
          },
        ],
      ]);

      server = new CustomToolsSSEServer(tools, 'test-assistant', false, workflowContext as any);
      const port = await server.start();

      // Verify initial state
      expect(engineerAgent.windDownTriggered).toBe(false);
      expect(codeTalkAgent.windDownTriggered).toBe(false);
      expect(executionContext.deadline).toBeGreaterThan(Date.now() + 500000);

      // ACT: Parent ProbeAgent calls graceful_stop (simulating negotiated timeout decline)
      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      // ASSERT: MCP response is correct
      expect(response.result.content[0].text).toBe('Stop acknowledged');

      // ASSERT: Deadline was shortened to ~30s from now
      expect(executionContext.deadline).toBeLessThan(Date.now() + 35000);
      expect(executionContext.deadline).toBeGreaterThan(Date.now() + 25000);

      // ASSERT: Both active ProbeAgent sessions received wind-down signal
      expect(engineerAgent.windDownTriggered).toBe(true);
      expect(codeTalkAgent.windDownTriggered).toBe(true);
    });

    it('graceful_stop propagates even when only one session is active', async () => {
      const executionContext = { deadline: Date.now() + 600000 };
      const workflowContext = {
        executionContext,
        workspace: undefined,
        prInfo: { number: 1, title: 'test', author: 'test', files: [], commits: [] },
      };

      const singleAgent = new MockProbeAgent('active-session');
      registry.registerSession('active-session', singleAgent as any);

      const tools = new Map<string, CustomToolDefinition>();
      server = new CustomToolsSSEServer(tools, 'test-session', false, workflowContext as any);
      const port = await server.start();

      await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      expect(singleAgent.windDownTriggered).toBe(true);
    });

    it('graceful_stop works when no ProbeAgent sessions exist (pure deadline shortening)', async () => {
      const executionContext = { deadline: Date.now() + 600000 };
      const workflowContext = {
        executionContext,
        workspace: undefined,
        prInfo: { number: 1, title: 'test', author: 'test', files: [], commits: [] },
      };

      // No sessions registered — should not throw
      const tools = new Map<string, CustomToolDefinition>();
      server = new CustomToolsSSEServer(tools, 'test-session', false, workflowContext as any);
      const port = await server.start();

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      expect(response.result.content[0].text).toBe('Stop acknowledged');
      expect(executionContext.deadline).toBeLessThan(Date.now() + 35000);
    });
  });

  describe('Scenario: Concurrent workflow tool + graceful_stop', () => {
    it('graceful_stop interrupts a running workflow via deadline shortening', async () => {
      // Setup: shared execution context with a far-future deadline
      const executionContext = {
        deadline: Date.now() + 600000,
      };
      const workflowContext = {
        executionContext,
        workspace: undefined,
        prInfo: { number: 1, title: 'test', author: 'test', files: [], commits: [] },
      };

      // Create a long-running tool that checks the shared deadline between steps
      const workflowTool = createLongRunningWorkflowTool();
      workflowTool.setExecutionContext(executionContext);

      const tools = new Map<string, CustomToolDefinition>([['engineer', workflowTool as any]]);

      server = new CustomToolsSSEServer(tools, 'test-concurrent', false, workflowContext as any);
      const port = await server.start();

      // Mock the tool executor to use our custom handler
      const executor = (server as any).toolExecutor;
      jest.spyOn(executor, 'execute').mockImplementation(async (_name: string, _args: any) => {
        return workflowTool._handler();
      });

      // Start the long-running workflow tool (takes ~1000ms uninterrupted)
      const workflowPromise = sendMCPRequest(
        port,
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'engineer', arguments: { task: 'refactor auth module' } },
        },
        10000 // longer timeout since this is a concurrent test
      );

      // Wait for it to start running (a few steps)
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(workflowTool.getState().running).toBe(true);
      expect(workflowTool.getState().stepsCompleted).toBeGreaterThan(0);

      // ACT: Call graceful_stop — this shortens the deadline to ~30s from now
      const stopResponse = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      expect(stopResponse.result.content[0].text).toBe('Stop acknowledged');

      // Now manually shorten further so the test doesn't wait 30s
      // (In production the 30s is the actual wind-down window)
      (executionContext as any).deadline = Date.now() - 1;

      // Wait for the workflow to finish (it should see deadline exceeded)
      const workflowResponse = await workflowPromise;

      // ASSERT: The workflow was interrupted, not completed
      expect(workflowTool.getState().interrupted).toBe(true);
      expect(workflowTool.getState().stepsCompleted).toBeLessThan(20);
      expect(workflowResponse.result.content[0].text).toContain('Interrupted');
      expect(workflowResponse.result.content[0].text).toContain('deadline exceeded');
    });
  });

  describe('Scenario: graceful_stop skips agents without triggerGracefulWindDown', () => {
    it('should not crash on agents that lack triggerGracefulWindDown method', async () => {
      const executionContext = { deadline: Date.now() + 600000 };
      const workflowContext = {
        executionContext,
        workspace: undefined,
        prInfo: { number: 1, title: 'test', author: 'test', files: [], commits: [] },
      };

      // Register a "legacy" agent without triggerGracefulWindDown
      const legacyAgent = {
        sessionId: 'legacy-session',
        cleanup: jest.fn(),
        // No triggerGracefulWindDown method
      };
      registry.registerSession('legacy-session', legacyAgent as any);

      // Also register a proper agent
      const modernAgent = new MockProbeAgent('modern-session');
      registry.registerSession('modern-session', modernAgent as any);

      const tools = new Map<string, CustomToolDefinition>();
      server = new CustomToolsSSEServer(tools, 'test-compat', false, workflowContext as any);
      const port = await server.start();

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });

      // Should complete without error
      expect(response.result.content[0].text).toBe('Stop acknowledged');
      // Modern agent got the signal
      expect(modernAgent.windDownTriggered).toBe(true);
      // Legacy agent was simply skipped (no crash)
    });
  });

  describe('Scenario: workflow tool rejected after graceful_stop', () => {
    it('should reject a workflow tool invocation after graceful_stop was called', async () => {
      const executionContext = { deadline: Date.now() + 600000 };
      const workflowContext = {
        executionContext,
        workspace: undefined,
        prInfo: { number: 1, title: 'test', author: 'test', files: [], commits: [] },
      };

      // Register a workflow tool (has __workflowId marker)
      const tools = new Map<string, CustomToolDefinition>([
        [
          'engineer',
          {
            name: 'engineer',
            description: 'Run the engineer workflow',
            inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
            exec: 'echo "should not run"',
            __isWorkflowTool: true,
            __workflowId: 'engineer',
          } as any,
        ],
        [
          'slack-send-dm',
          {
            name: 'slack-send-dm',
            description: 'Send a Slack DM',
            inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
            exec: 'echo "sent"',
          },
        ],
      ]);

      server = new CustomToolsSSEServer(tools, 'test-reject', false, workflowContext as any);
      const port = await server.start();

      // Step 1: Call graceful_stop
      const stopResponse = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'graceful_stop', arguments: {} },
      });
      expect(stopResponse.result.content[0].text).toBe('Stop acknowledged');

      // Step 2: Try to invoke engineer workflow — should be REJECTED
      const engineerResponse = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'engineer', arguments: { task: 'do something' } },
      });
      expect(engineerResponse.result.content[0].text).toContain('REJECTED');
      expect(engineerResponse.result.content[0].text).toContain('graceful_stop');

      // Step 3: Short tools like slack-send-dm should still work
      const slackResponse = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'slack-send-dm', arguments: { msg: 'final update' } },
      });
      expect(slackResponse.result.content[0].text).toContain('sent');
    });
  });

  describe('Scenario: tools/list always includes graceful_stop', () => {
    it('should appear alongside workflow and regular tools', async () => {
      const tools = new Map<string, CustomToolDefinition>([
        [
          'search',
          {
            name: 'search',
            description: 'Search codebase',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            exec: 'grep -r "{{ args.query }}"',
          },
        ],
      ]);

      server = new CustomToolsSSEServer(tools, 'test-tools-list', false);
      const port = await server.start();

      const response = await sendMCPRequest(port, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      });

      const toolNames = response.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('graceful_stop');

      // Verify graceful_stop schema
      const gracefulStop = response.result.tools.find((t: any) => t.name === 'graceful_stop');
      expect(gracefulStop.inputSchema.type).toBe('object');
      expect(gracefulStop.inputSchema.required).toEqual([]);
    });
  });
});
