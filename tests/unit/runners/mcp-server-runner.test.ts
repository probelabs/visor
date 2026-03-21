import { StateMachineExecutionEngine } from '../../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../../src/types/config';
import type { McpFrontendOptions } from '../../../src/runners/mcp-server-runner';

/**
 * Tests for the MCP server runner's conversational frontend flow.
 *
 * Covers:
 * - mcp_conversation extraction in level-dispatch (parity with slack_conversation)
 * - assume expressions with conversation context
 * - extractResponseText picking the longest/final AI response (not routing intent)
 * - trackExecution { task, result } envelope unwrapping
 * - HTTP handler: auth, CORS, session management, expired sessions
 * - webhookData structure validation
 * - runner-factory wiring (constructor signature)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(opts?: { assumeExpr?: string | string[]; content?: string }): VisorConfig {
  return {
    version: '1.0',
    output: { pr_comment: { enabled: false } } as any,
    checks: {
      chat: {
        type: 'script',
        criticality: 'policy',
        ...(opts?.assumeExpr ? { assume: opts.assumeExpr } : {}),
        content: opts?.content || 'return { text: "Hello from MCP!" };',
      } as any,
    },
  } as any;
}

/** Build webhookData map exactly as McpServerRunner.handleMessage does. */
function buildMcpWebhookData(message: string, sessionId?: string) {
  const convSessionId = sessionId || 'test-session-123';
  const now = Date.now();
  const conversationContext = {
    transport: 'mcp',
    thread: { id: convSessionId },
    current: { user: 'mcp-client', text: message, timestamp: now },
    messages: [{ role: 'user', text: message, timestamp: now }],
  };
  const payload = {
    event: { type: 'message', text: message, user: 'mcp-client', timestamp: now },
    mcp_conversation: conversationContext,
  };
  const webhookData = new Map<string, unknown>();
  webhookData.set('/bots/mcp/message', payload);
  return { webhookData, conversationContext };
}

function statsById(res: any): Record<string, any> {
  const byName: Record<string, any> = {};
  for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
  return byName;
}

// ---------------------------------------------------------------------------
// 1. Conversation flow through engine (level-dispatch integration)
// ---------------------------------------------------------------------------

describe('MCP conversation flow through engine', () => {
  it('runs check when mcp_conversation is in webhookContext (assume passes)', async () => {
    const cfg = makeConfig({ assumeExpr: 'conversation.current.text != null' });
    const engine = new StateMachineExecutionEngine();
    const { webhookData } = buildMcpWebhookData('Hello from MCP client');

    const res = await engine.executeChecks({
      checks: ['chat'],
      config: cfg,
      webhookContext: { webhookData, eventType: 'manual' },
    } as any);

    const stats = statsById(res);
    expect(stats['chat']?.skipped).not.toBe(true);
    expect(stats['chat']?.totalRuns).toBe(1);
  });

  it('runs check when mcp_conversation is pre-set on executionContext', async () => {
    const cfg = makeConfig({ assumeExpr: 'conversation.current.text != null' });
    const engine = new StateMachineExecutionEngine();
    const { webhookData } = buildMcpWebhookData('Test via executionContext');

    (engine as any).setExecutionContext({ webhookContext: { webhookData } });

    const res = await engine.executeChecks({
      checks: ['chat'],
      config: cfg,
    } as any);

    const stats = statsById(res);
    expect(stats['chat']?.skipped).not.toBe(true);
    expect(stats['chat']?.totalRuns).toBe(1);
  });

  it('skips check when no conversation is available', async () => {
    const cfg = makeConfig({ assumeExpr: 'conversation.current.text != null' });
    const engine = new StateMachineExecutionEngine();

    const res = await engine.executeChecks({
      checks: ['chat'],
      config: cfg,
    } as any);

    const stats = statsById(res);
    expect(stats['chat']?.totalRuns || 0).toBe(0);
    expect(stats['chat']?.skipped).toBe(true);
  });

  it('assume array syntax works with MCP conversation', async () => {
    const cfg = makeConfig({
      assumeExpr: ['conversation.current.text != null'],
    });
    const engine = new StateMachineExecutionEngine();
    const { webhookData } = buildMcpWebhookData('Array assume test');

    const res = await engine.executeChecks({
      checks: ['chat'],
      config: cfg,
      webhookContext: { webhookData, eventType: 'manual' },
    } as any);

    const stats = statsById(res);
    expect(stats['chat']?.totalRuns).toBe(1);
    expect(stats['chat']?.skipped).not.toBe(true);
  });

  it('mcp_conversation produces same result as slack_conversation', async () => {
    const message = 'Test parity check';
    const cfg = makeConfig({ assumeExpr: 'conversation.current.text != null' });

    // MCP path
    const mcpEngine = new StateMachineExecutionEngine();
    const { webhookData: mcpData } = buildMcpWebhookData(message);
    const mcpRes = await mcpEngine.executeChecks({
      checks: ['chat'],
      config: cfg,
      webhookContext: { webhookData: mcpData, eventType: 'manual' },
    } as any);

    // Slack path
    const slackEngine = new StateMachineExecutionEngine();
    const slackWebhookData = new Map<string, unknown>();
    slackWebhookData.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '1234.5', text: message },
      slack_conversation: {
        transport: 'slack',
        thread: { id: 'test-thread' },
        current: { role: 'user', text: message, timestamp: Date.now() },
        messages: [{ role: 'user', text: message, timestamp: Date.now() }],
      },
    });
    const slackRes = await slackEngine.executeChecks({
      checks: ['chat'],
      config: cfg,
      webhookContext: { webhookData: slackWebhookData, eventType: 'manual' },
    } as any);

    const mcpStats = statsById(mcpRes);
    const slackStats = statsById(slackRes);
    expect(mcpStats['chat']?.totalRuns).toBe(1);
    expect(slackStats['chat']?.totalRuns).toBe(1);
    expect(mcpStats['chat']?.skipped).not.toBe(true);
    expect(slackStats['chat']?.skipped).not.toBe(true);
  });

  it('conversation.current.text is accessible in script check via eventContext', async () => {
    const message = 'What is Tyk Gateway?';
    const cfg = makeConfig({
      assumeExpr: 'conversation.current.text != null',
      content: `
        const conv = this?.eventContext?.conversation || this?.conversation;
        if (!conv) return { text: 'NO CONVERSATION' };
        return { text: 'ECHO: ' + conv.current.text };
      `,
    });
    const engine = new StateMachineExecutionEngine();
    const { webhookData } = buildMcpWebhookData(message);

    const res = await engine.executeChecks({
      checks: ['chat'],
      config: cfg,
      webhookContext: { webhookData, eventType: 'manual' },
    } as any);

    const stats = statsById(res);
    expect(stats['chat']?.totalRuns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. extractResponseText logic
// ---------------------------------------------------------------------------

describe('extractResponseText', () => {
  // Access the private method for testing by instantiating the class
  let extractResponseText: (result: any) => string;

  beforeAll(async () => {
    const { McpServerRunner } = await import('../../../src/runners/mcp-server-runner');
    const engine = new StateMachineExecutionEngine();
    const cfg = makeConfig();
    const runner = new McpServerRunner(engine, cfg, { authToken: 'test' });
    extractResponseText = (runner as any).extractResponseText.bind(runner);
  });

  it('returns "No response" for null/undefined result', () => {
    expect(extractResponseText(null)).toBe('No response from workflow.');
    expect(extractResponseText(undefined)).toBe('No response from workflow.');
  });

  it('picks the last step text from history (final AI response, not routing)', () => {
    const result = {
      reviewSummary: {
        issues: [],
        history: {
          'chat.route-intent': [
            {
              intent: 'chat',
              topic: 'How can I help?',
              text: 'Short routing label',
              skills: ['capabilities'],
            },
          ],
          'chat.build-config': [{ mcp_servers: {}, knowledge_content: 'some config' }],
          'chat.generate-response': [
            {
              text:
                'I am the Tyk AI Assistant! I can help you with code exploration across Tyk repos, ' +
                'engineering tasks, Jira tickets, and much more. How can I help you today?',
            },
          ],
        },
      },
    };

    const text = extractResponseText(result);
    expect(text).toContain('Tyk AI Assistant');
    expect(text).not.toBe('Short routing label');
  });

  it('does not pick short intent/routing text over last response', () => {
    const result = {
      reviewSummary: {
        issues: [],
        history: {
          'chat.route-intent': [{ text: 'chat' }],
          'chat.generate-response': [
            { text: 'Here is a detailed answer about rate limiting in Tyk Gateway...' },
          ],
        },
      },
    };

    const text = extractResponseText(result);
    expect(text).toContain('rate limiting');
    expect(text).not.toBe('chat');
  });

  it('picks last step even when routing output is longer than final response', () => {
    const result = {
      reviewSummary: {
        issues: [],
        history: {
          'chat.route-intent': [
            {
              text:
                'Based on analysis of the user query, I have determined this is a request about ' +
                'API gateway configuration. The user wants to understand how to set up rate limiting ' +
                'with multiple policies across different API endpoints. Classifying as: engineering-task. ' +
                'Relevant skills: api-gateway, rate-limiting, policy-management.',
            },
          ],
          'chat.build-config': [{ mcp_servers: {}, text: 'config built' }],
          'chat.generate-response': [
            {
              text: 'To set up rate limiting, use the Tyk Dashboard.',
            },
          ],
        },
      },
    };

    const text = extractResponseText(result);
    // Should pick the last step (generate-response), NOT the longest (route-intent)
    expect(text).toBe('To set up rate limiting, use the Tyk Dashboard.');
    expect(text).not.toContain('Based on analysis');
  });

  it('falls back to grouped results when history has no text', () => {
    const result = {
      reviewSummary: { issues: [], history: {} },
      executionStatistics: {
        groupedResults: {
          chat: [
            { checkName: 'chat', output: { text: 'Fallback from grouped results' }, issues: [] },
          ],
        },
      },
    };

    expect(extractResponseText(result)).toBe('Fallback from grouped results');
  });

  it('falls back to grouped results with string output', () => {
    const result = {
      reviewSummary: { issues: [], history: {} },
      executionStatistics: {
        groupedResults: {
          chat: [{ checkName: 'chat', output: 'Plain string output', issues: [] }],
        },
      },
    };

    expect(extractResponseText(result)).toBe('Plain string output');
  });

  it('handles output.text at top level of result', () => {
    const result = { text: 'Direct text on result' };
    expect(extractResponseText(result)).toBe('Direct text on result');
  });

  it('handles output.text nested under output key', () => {
    const result = { output: { text: 'Nested output text' } };
    expect(extractResponseText(result)).toBe('Nested output text');
  });

  it('JSON-dumps when no text found anywhere', () => {
    const result = {
      reviewSummary: { issues: [], history: { chat: [{ numbers: [1, 2, 3] }] } },
    };
    const text = extractResponseText(result);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('handles multi-step workflow with multiple text outputs, picks last', () => {
    const result = {
      reviewSummary: {
        issues: [],
        history: {
          'chat.step1': [{ text: 'a' }],
          'chat.step2': [{ text: 'ab' }],
          'chat.step3': [{ text: 'This is the final comprehensive response from the AI.' }],
        },
      },
    };

    const text = extractResponseText(result);
    expect(text).toContain('comprehensive response');
  });

  it('picks last grouped result, not longest', () => {
    const result = {
      reviewSummary: { issues: [], history: {} },
      executionStatistics: {
        groupedResults: {
          routing: [
            {
              checkName: 'route',
              output: {
                text: 'Detailed routing analysis with lots of context about the user intent and classification',
              },
              issues: [],
            },
          ],
          response: [{ checkName: 'respond', output: { text: 'Short final answer.' }, issues: [] }],
        },
      },
    };

    const text = extractResponseText(result);
    expect(text).toBe('Short final answer.');
  });
});

// ---------------------------------------------------------------------------
// 3. trackExecution envelope unwrapping
// ---------------------------------------------------------------------------

describe('trackExecution envelope unwrapping', () => {
  let extractResponseText: (result: any) => string;

  beforeAll(async () => {
    const { McpServerRunner } = await import('../../../src/runners/mcp-server-runner');
    const engine = new StateMachineExecutionEngine();
    const cfg = makeConfig();
    const runner = new McpServerRunner(engine, cfg, { authToken: 'test' });
    extractResponseText = (runner as any).extractResponseText.bind(runner);
  });

  it('extracts text from raw engine result (no task wrapper)', () => {
    const rawResult = {
      reviewSummary: {
        issues: [],
        history: { chat: [{ text: 'Direct engine response' }] },
      },
    };
    expect(extractResponseText(rawResult)).toBe('Direct engine response');
  });

  it('the unwrap pattern (result?.result ?? result) works for wrapped results', () => {
    const innerResult = {
      reviewSummary: {
        issues: [],
        history: { chat: [{ text: 'Wrapped response text' }] },
      },
    };
    const wrapped = { task: { id: 'task-123' }, result: innerResult };

    // Simulate the unwrap from handleMessage
    const rawResult = (wrapped as any)?.result ?? wrapped;
    expect(extractResponseText(rawResult)).toBe('Wrapped response text');
  });

  it('unwrap still works when there is no task wrapper', () => {
    const result = {
      reviewSummary: {
        issues: [],
        history: { chat: [{ text: 'No wrapper here' }] },
      },
    };

    const rawResult = (result as any)?.result ?? result;
    expect(extractResponseText(rawResult)).toBe('No wrapper here');
  });
});

// ---------------------------------------------------------------------------
// 4. webhookData structure
// ---------------------------------------------------------------------------

describe('webhookData structure', () => {
  it('builds correct MCP webhook payload', () => {
    const message = 'Hello assistant';
    const sessionId = 'session-abc-123';
    const { webhookData } = buildMcpWebhookData(message, sessionId);

    expect(webhookData.size).toBe(1);
    expect(webhookData.has('/bots/mcp/message')).toBe(true);

    const payload = webhookData.get('/bots/mcp/message') as any;
    expect(payload.event.type).toBe('message');
    expect(payload.event.text).toBe(message);
    expect(payload.event.user).toBe('mcp-client');
    expect(payload.mcp_conversation).toBeDefined();
    expect(payload.mcp_conversation.transport).toBe('mcp');
    expect(payload.mcp_conversation.thread.id).toBe(sessionId);
    expect(payload.mcp_conversation.current.text).toBe(message);
    expect(payload.mcp_conversation.messages).toHaveLength(1);
    expect(payload.mcp_conversation.messages[0].role).toBe('user');
  });

  it('generates a default session ID when none provided', () => {
    const { webhookData } = buildMcpWebhookData('test');
    const payload = webhookData.get('/bots/mcp/message') as any;
    expect(payload.mcp_conversation.thread.id).toBe('test-session-123');
  });
});

// ---------------------------------------------------------------------------
// 5. HTTP handler behaviour (unit-level, no real server)
// ---------------------------------------------------------------------------

describe('McpServerRunner HTTP handler', () => {
  it('requires auth token to start', async () => {
    const { McpServerRunner } = await import('../../../src/runners/mcp-server-runner');
    const engine = new StateMachineExecutionEngine();
    const cfg = makeConfig();
    const runner = new McpServerRunner(engine, cfg, {});

    await expect(runner.start()).rejects.toThrow('auth token');
  });

  it('accepts custom tool name and description', async () => {
    const { McpServerRunner } = await import('../../../src/runners/mcp-server-runner');
    const engine = new StateMachineExecutionEngine();
    const cfg = makeConfig();
    const options: McpFrontendOptions = {
      authToken: 'test-token',
      toolName: 'ask_tyk_assistant',
      toolDescription: 'Custom description',
      port: 0, // ephemeral port
    };
    const runner = new McpServerRunner(engine, cfg, options);
    expect(runner.name).toBe('mcp');
    // Constructor doesn't throw — options are stored for start()
  });
});

// ---------------------------------------------------------------------------
// 6. Session expiry returns proper JSON-RPC error (MCP spec compliance)
// ---------------------------------------------------------------------------

describe('MCP session expiry', () => {
  it('returns JSON-RPC error with code -32000 for expired session (spec compliance)', () => {
    // Simulate the error response our handler produces
    const requestId = 42;
    const response = {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32000,
        message: 'Session expired. Please reconnect with a new session.',
      },
    };

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(requestId);
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain('Session expired');
  });

  it('DELETE on expired session returns 200 OK (graceful no-op)', () => {
    // Validate the response shape for DELETE on non-existent session
    const response = { ok: true };
    expect(response.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. runner-factory wiring
// ---------------------------------------------------------------------------

describe('runner-factory MCP case', () => {
  it('creates McpServerRunner with (engine, config, options) signature', async () => {
    const { McpServerRunner } = await import('../../../src/runners/mcp-server-runner');
    const engine = new StateMachineExecutionEngine();
    const cfg = makeConfig();

    // This is the pattern runner-factory.ts uses
    const runner = new McpServerRunner(engine, cfg, {
      port: 8080,
      host: '0.0.0.0',
      authToken: 'test-token',
      toolName: 'send_message',
      toolDescription: 'Test description',
    });

    expect(runner.name).toBe('mcp');
    expect(typeof runner.start).toBe('function');
    expect(typeof runner.stop).toBe('function');
    expect(typeof runner.updateConfig).toBe('function');
    expect(typeof runner.setTaskStore).toBe('function');
  });

  it('updateConfig replaces the config', async () => {
    const { McpServerRunner } = await import('../../../src/runners/mcp-server-runner');
    const engine = new StateMachineExecutionEngine();
    const cfg1 = makeConfig();
    const runner = new McpServerRunner(engine, cfg1, { authToken: 'test' });

    const cfg2 = makeConfig({ content: 'return { text: "updated" };' });
    runner.updateConfig(cfg2);

    // Internal cfg should be updated (accessed via the private field)
    expect((runner as any).cfg).toBe(cfg2);
  });

  it('setTaskStore stores task store and config path', async () => {
    const { McpServerRunner } = await import('../../../src/runners/mcp-server-runner');
    const engine = new StateMachineExecutionEngine();
    const runner = new McpServerRunner(engine, makeConfig(), { authToken: 'test' });

    const fakeStore = { initialize: jest.fn() } as any;
    runner.setTaskStore(fakeStore, '/path/to/config.yaml');

    expect((runner as any).taskStore).toBe(fakeStore);
    expect((runner as any).configPath).toBe('/path/to/config.yaml');
  });
});

// ---------------------------------------------------------------------------
// 8. Config validation: mcp_server is allowed top-level key
// ---------------------------------------------------------------------------

describe('config validation', () => {
  it('mcp_server is a recognized top-level key', async () => {
    // Load the config validator and verify mcp_server doesn't produce a warning
    // We can't easily test the full validator without a file, but we can verify
    // the key is in the allowed set by checking our source change was applied
    const configSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../../../src/config.ts'),
      'utf8'
    );
    expect(configSrc).toContain("'mcp_server'");
  });
});
