import http from 'http';
import { A2ACheckProvider, AgentCardCache } from '../../../src/providers/a2a-check-provider';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { AgentTask, AgentMessage } from '../../../src/agent-protocol/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal PRInfo for template rendering */
function makePRInfo(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'Test PR',
    body: 'Test body',
    author: 'test-author',
    base: 'main',
    head: 'feature',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    ...overrides,
  };
}

/** Create a completed AgentTask */
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    context_id: 'ctx-1',
    status: { state: 'completed', timestamp: new Date().toISOString() },
    artifacts: [
      {
        artifact_id: 'art-1',
        parts: [{ text: 'Agent response text' }],
      },
    ],
    history: [],
    ...overrides,
  };
}

/** Create an AgentMessage */
function makeMessage(text: string): AgentMessage {
  return {
    message_id: `msg-${Date.now()}`,
    role: 'agent',
    parts: [{ text }],
  };
}

/** Starts an HTTP server on port 0 and returns { server, port, close } */
function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        close: () => new Promise<void>(res => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

/** Read full request body as parsed JSON */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

describe('A2ACheckProvider', () => {
  let provider: A2ACheckProvider;

  beforeEach(() => {
    provider = new A2ACheckProvider();
  });

  describe('getName', () => {
    it('should return "a2a"', () => {
      expect(provider.getName()).toBe('a2a');
    });
  });

  describe('validateConfig', () => {
    it('should accept valid config with agent_card', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_card: 'https://agent.example.com/.well-known/agent-card.json',
        message: 'Hello agent',
      });
      expect(result).toBe(true);
    });

    it('should accept valid config with agent_url', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_url: 'http://localhost:9001',
        message: 'Hello agent',
      });
      expect(result).toBe(true);
    });

    it('should reject config with both agent_card and agent_url', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_card: 'https://agent.example.com/.well-known/agent-card.json',
        agent_url: 'http://localhost:9001',
        message: 'Hello agent',
      });
      expect(result).toBe(false);
    });

    it('should reject config with neither agent_card nor agent_url', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        message: 'Hello agent',
      });
      expect(result).toBe(false);
    });

    it('should reject config without message', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_url: 'http://localhost:9001',
      });
      expect(result).toBe(false);
    });

    it('should reject non-a2a type', async () => {
      const result = await provider.validateConfig({
        type: 'ai',
        agent_url: 'http://localhost:9001',
        message: 'Hello',
      });
      expect(result).toBe(false);
    });

    it('should reject null/undefined config', async () => {
      expect(await provider.validateConfig(null)).toBe(false);
      expect(await provider.validateConfig(undefined)).toBe(false);
    });
  });

  describe('isAvailable', () => {
    it('should always return true', async () => {
      expect(await provider.isAvailable()).toBe(true);
    });
  });

  describe('getSupportedConfigKeys', () => {
    it('should return expected keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('agent_card');
      expect(keys).toContain('agent_url');
      expect(keys).toContain('message');
      expect(keys).toContain('auth');
      expect(keys).toContain('blocking');
      expect(keys).toContain('timeout');
      expect(keys).toContain('max_turns');
      expect(keys).toContain('on_input_required');
      expect(keys).toContain('transform_js');
    });
  });

  describe('getRequirements', () => {
    it('should return empty array', () => {
      expect(provider.getRequirements()).toEqual([]);
    });
  });

  // =========================================================================
  // execute() tests
  // =========================================================================
  describe('execute', () => {
    let mockClose: (() => Promise<void>) | undefined;

    afterEach(async () => {
      if (mockClose) {
        await mockClose();
        mockClose = undefined;
      }
    });

    // -----------------------------------------------------------------------
    // Blocking mode: agent returns completed task immediately
    // -----------------------------------------------------------------------
    it('should handle blocking mode — completed task returned directly', async () => {
      const task = makeTask();
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send' && req.method === 'POST') {
          await readBody(req); // consume body
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review this PR',
        blocking: true,
      } as any);

      // taskToReviewSummary returns { issues: [] } for completed tasks
      expect(result).toBeDefined();
      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Direct message response (no task, just a message)
    // -----------------------------------------------------------------------
    it('should handle direct message response (no task wrapper)', async () => {
      const msg = makeMessage('Direct agent reply');
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: msg }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello agent',
      } as any);

      expect(result).toBeDefined();
      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Polling mode: submitted → working → completed
    // -----------------------------------------------------------------------
    it('should poll until task reaches completed state', async () => {
      let pollCount = 0;
      const taskId = 'poll-task-1';
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send' && req.method === 'POST') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: taskId,
                status: { state: 'submitted', timestamp: new Date().toISOString() },
                artifacts: [],
              }),
            })
          );
        } else if (req.url === `/tasks/${taskId}` && req.method === 'GET') {
          pollCount++;
          const state = pollCount >= 2 ? 'completed' : 'working';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              makeTask({
                id: taskId,
                status: { state, timestamp: new Date().toISOString() },
                artifacts:
                  state === 'completed' ? [{ artifact_id: 'a1', parts: [{ text: 'Done' }] }] : [],
              })
            )
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review PR',
        blocking: false,
        poll_interval: 50, // fast polling for test
        timeout: 10_000,
      } as any);

      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Multi-turn: input_required → auto-reply via on_input_required
    // -----------------------------------------------------------------------
    it('should auto-reply when agent returns input_required and on_input_required is set', async () => {
      const taskId = 'multi-turn-1';
      let sendCount = 0;
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send' && req.method === 'POST') {
          const body = await readBody(req);
          sendCount++;
          if (sendCount === 1) {
            // First send → input_required
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                task: makeTask({
                  id: taskId,
                  status: {
                    state: 'input_required',
                    timestamp: new Date().toISOString(),
                    message: {
                      message_id: 'agent-q1',
                      role: 'agent',
                      parts: [{ text: 'What is the compliance standard?' }],
                    },
                  },
                  artifacts: [],
                }),
              })
            );
          } else {
            // Follow-up reply → completed
            // Verify the follow-up message references the task
            const msg = body.message as Record<string, unknown>;
            expect(msg.task_id).toBe(taskId);
            expect(msg.context_id).toBe('ctx-1');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                task: makeTask({
                  id: taskId,
                  status: { state: 'completed', timestamp: new Date().toISOString() },
                }),
              })
            );
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Check compliance',
        on_input_required: 'The standard is SOC2. PR title: {{ pr.title }}',
        max_turns: 3,
        timeout: 10_000,
      } as any);

      expect(sendCount).toBe(2);
      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // input_required without on_input_required template throws error
    // -----------------------------------------------------------------------
    it('should return error when input_required but no on_input_required template', async () => {
      const taskId = 'no-template-1';
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: taskId,
                status: {
                  state: 'input_required',
                  timestamp: new Date().toISOString(),
                  message: {
                    message_id: 'agent-q',
                    role: 'agent',
                    parts: [{ text: 'Need more info' }],
                  },
                },
                artifacts: [],
              }),
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        // no on_input_required
        timeout: 10_000,
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('requires input');
    });

    // -----------------------------------------------------------------------
    // Max turns exceeded
    // -----------------------------------------------------------------------
    it('should return error when max_turns is exceeded', async () => {
      const taskId = 'max-turns-1';
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          // Always return input_required — agent keeps asking
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: taskId,
                status: {
                  state: 'input_required',
                  timestamp: new Date().toISOString(),
                  message: {
                    message_id: 'agent-q',
                    role: 'agent',
                    parts: [{ text: 'Need more' }],
                  },
                },
                artifacts: [],
              }),
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        on_input_required: 'Here is more context',
        max_turns: 2,
        timeout: 10_000,
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('exceeded max turns');
    });

    // -----------------------------------------------------------------------
    // Timeout during polling
    // -----------------------------------------------------------------------
    it('should return error when polling times out', async () => {
      const taskId = 'timeout-1';
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: taskId,
                status: { state: 'working', timestamp: new Date().toISOString() },
                artifacts: [],
              }),
            })
          );
        } else if (req.url === `/tasks/${taskId}`) {
          // Always return 'working' — never completes
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              makeTask({
                id: taskId,
                status: { state: 'working', timestamp: new Date().toISOString() },
                artifacts: [],
              })
            )
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        timeout: 200, // very short timeout
        poll_interval: 50,
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('timed out');
    });

    // -----------------------------------------------------------------------
    // Failed task
    // -----------------------------------------------------------------------
    it('should return error when agent task fails', async () => {
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: 'fail-1',
                status: {
                  state: 'failed',
                  timestamp: new Date().toISOString(),
                  message: {
                    message_id: 'err-msg',
                    role: 'agent',
                    parts: [{ text: 'Internal agent error' }],
                  },
                },
                artifacts: [],
              }),
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('failed');
      expect(result.issues![0].message).toContain('Internal agent error');
    });

    // -----------------------------------------------------------------------
    // Rejected task
    // -----------------------------------------------------------------------
    it('should return error when agent task is rejected', async () => {
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: 'reject-1',
                status: { state: 'rejected', timestamp: new Date().toISOString() },
                artifacts: [],
              }),
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('rejected');
    });

    // -----------------------------------------------------------------------
    // Canceled task
    // -----------------------------------------------------------------------
    it('should return error when agent task is canceled', async () => {
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: 'cancel-1',
                status: { state: 'canceled', timestamp: new Date().toISOString() },
                artifacts: [],
              }),
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('canceled');
    });

    // -----------------------------------------------------------------------
    // auth_required state
    // -----------------------------------------------------------------------
    it('should return error when agent returns auth_required', async () => {
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: 'auth-req-1',
                status: { state: 'auth_required', timestamp: new Date().toISOString() },
                artifacts: [],
              }),
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        timeout: 5_000,
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('requires authentication');
    });

    // -----------------------------------------------------------------------
    // HTTP error from agent (non-2xx)
    // -----------------------------------------------------------------------
    it('should return error when agent returns HTTP error', async () => {
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('500');
    });

    // -----------------------------------------------------------------------
    // Bearer auth header transmission
    // -----------------------------------------------------------------------
    it('should send Bearer token in Authorization header', async () => {
      let capturedHeaders: http.IncomingHttpHeaders = {};
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          capturedHeaders = req.headers;
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const envKey = 'TEST_A2A_BEARER_TOKEN_FOR_TEST';
      process.env[envKey] = 'my-secret-token';
      try {
        await provider.execute(makePRInfo(), {
          type: 'a2a',
          agent_url: `http://127.0.0.1:${port}`,
          message: 'Hello',
          auth: { scheme: 'bearer', token_env: envKey },
        } as any);

        expect(capturedHeaders['authorization']).toBe('Bearer my-secret-token');
      } finally {
        delete process.env[envKey];
      }
    });

    // -----------------------------------------------------------------------
    // API key auth header transmission
    // -----------------------------------------------------------------------
    it('should send API key in custom header', async () => {
      let capturedHeaders: http.IncomingHttpHeaders = {};
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          capturedHeaders = req.headers;
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const envKey = 'TEST_A2A_API_KEY_FOR_TEST';
      process.env[envKey] = 'api-key-123';
      try {
        await provider.execute(makePRInfo(), {
          type: 'a2a',
          agent_url: `http://127.0.0.1:${port}`,
          message: 'Hello',
          auth: { scheme: 'api_key', token_env: envKey, header_name: 'X-Custom-Key' },
        } as any);

        expect(capturedHeaders['x-custom-key']).toBe('api-key-123');
      } finally {
        delete process.env[envKey];
      }
    });

    // -----------------------------------------------------------------------
    // API key auth uses default X-API-Key header when header_name omitted
    // -----------------------------------------------------------------------
    it('should use default X-API-Key header when header_name is not set', async () => {
      let capturedHeaders: http.IncomingHttpHeaders = {};
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          capturedHeaders = req.headers;
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const envKey = 'TEST_A2A_DEFAULT_API_KEY';
      process.env[envKey] = 'default-key';
      try {
        await provider.execute(makePRInfo(), {
          type: 'a2a',
          agent_url: `http://127.0.0.1:${port}`,
          message: 'Hello',
          auth: { scheme: 'api_key', token_env: envKey },
        } as any);

        expect(capturedHeaders['x-api-key']).toBe('default-key');
      } finally {
        delete process.env[envKey];
      }
    });

    // -----------------------------------------------------------------------
    // Agent card fetch and endpoint resolution
    // -----------------------------------------------------------------------
    it('should fetch agent card and use its endpoint URL', async () => {
      let messageReceived = false;
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/agent-card.json' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              name: 'Test Review Agent',
              supported_interfaces: [{ url: `http://127.0.0.1:${port}` }],
            })
          );
        } else if (req.url === '/message:send' && req.method === 'POST') {
          messageReceived = true;
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_card: `http://127.0.0.1:${port}/agent-card.json`,
        message: 'Review this',
      } as any);

      expect(messageReceived).toBe(true);
      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Agent card fetch failure returns error
    // -----------------------------------------------------------------------
    it('should return error when agent card fetch fails', async () => {
      const { port, close } = await startMockServer(async (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_card: `http://127.0.0.1:${port}/nonexistent-card.json`,
        message: 'Hello',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('Failed to fetch Agent Card');
    });

    // -----------------------------------------------------------------------
    // Liquid template rendering in message
    // -----------------------------------------------------------------------
    it('should render Liquid templates in the message body', async () => {
      let capturedBody: Record<string, unknown> = {};
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          capturedBody = await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      await provider.execute(makePRInfo({ title: 'Fix memory leak', number: 99 }), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review PR #{{ pr.number }}: {{ pr.title }}',
      } as any);

      const msg = capturedBody.message as Record<string, unknown>;
      const parts = msg.parts as Array<{ text: string }>;
      expect(parts[0].text).toBe('Review PR #99: Fix memory leak');
    });

    // -----------------------------------------------------------------------
    // Sends blocking configuration to agent
    // -----------------------------------------------------------------------
    it('should send blocking flag in configuration', async () => {
      let capturedBody: Record<string, unknown> = {};
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          capturedBody = await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        blocking: false,
      } as any);

      const configuration = capturedBody.configuration as Record<string, unknown>;
      expect(configuration.blocking).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Task returned at top-level (no .task wrapper)
    // -----------------------------------------------------------------------
    it('should handle task returned at top level (no task wrapper)', async () => {
      const task = makeTask();
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // Return task fields at top level — some agents do this
          res.end(JSON.stringify(task));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
      } as any);

      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Trailing slash stripped from agent_url
    // -----------------------------------------------------------------------
    it('should strip trailing slashes from agent_url', async () => {
      let requestUrl = '';
      const { port, close } = await startMockServer(async (req, res) => {
        requestUrl = req.url ?? '';
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}///`,
        message: 'Hello',
      } as any);

      expect(requestUrl).toBe('/message:send');
    });

    // -----------------------------------------------------------------------
    // Data parts are sent with rendered Liquid templates
    // -----------------------------------------------------------------------
    it('should render and send data parts from config.data', async () => {
      let capturedBody: Record<string, unknown> = {};
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          capturedBody = await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      await provider.execute(makePRInfo({ title: 'Add feature' }), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        data: {
          context: '{"pr_title": "{{ pr.title }}"}',
        },
      } as any);

      const msg = capturedBody.message as Record<string, unknown>;
      const parts = msg.parts as Array<Record<string, unknown>>;
      // First part is text, second is data
      expect(parts.length).toBe(2);
      expect(parts[1].media_type).toBe('application/json');
      // Data should be parsed JSON (since the rendered string is valid JSON)
      expect((parts[1].data as Record<string, string>).pr_title).toBe('Add feature');
    });

    // -----------------------------------------------------------------------
    // File parts are attached
    // -----------------------------------------------------------------------
    it('should include file parts from config.files', async () => {
      let capturedBody: Record<string, unknown> = {};
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          capturedBody = await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Analyze',
        files: [
          { url: 'https://example.com/patch.diff', media_type: 'text/x-diff', filename: 'pr.diff' },
        ],
      } as any);

      const msg = capturedBody.message as Record<string, unknown>;
      const parts = msg.parts as Array<Record<string, unknown>>;
      // First part is text, second is file
      expect(parts.length).toBe(2);
      expect(parts[1].url).toBe('https://example.com/patch.diff');
      expect(parts[1].media_type).toBe('text/x-diff');
      expect(parts[1].filename).toBe('pr.diff');
    });

    // -----------------------------------------------------------------------
    // Polling: getTask HTTP error returns error summary
    // -----------------------------------------------------------------------
    it('should return error when getTask poll returns HTTP error', async () => {
      const taskId = 'poll-err-1';
      let pollCount = 0;
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              task: makeTask({
                id: taskId,
                status: { state: 'working', timestamp: new Date().toISOString() },
                artifacts: [],
              }),
            })
          );
        } else if (req.url === `/tasks/${taskId}`) {
          pollCount++;
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Server Error');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        poll_interval: 50,
        timeout: 5_000,
      } as any);

      expect(pollCount).toBeGreaterThanOrEqual(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('500');
    });

    // -----------------------------------------------------------------------
    // Response that is neither task nor message returns error
    // -----------------------------------------------------------------------
    it('should return error for unrecognized response shape', async () => {
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ something_else: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/error');
      expect(result.issues![0].message).toContain('neither Task nor Message');
    });

    // -----------------------------------------------------------------------
    // Multi-turn: follow-up gets direct message response
    // -----------------------------------------------------------------------
    it('should handle follow-up returning a direct message instead of task', async () => {
      const taskId = 'multi-msg-1';
      let sendCount = 0;
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          sendCount++;
          if (sendCount === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                task: makeTask({
                  id: taskId,
                  status: {
                    state: 'input_required',
                    timestamp: new Date().toISOString(),
                    message: {
                      message_id: 'q1',
                      role: 'agent',
                      parts: [{ text: 'Clarify?' }],
                    },
                  },
                  artifacts: [],
                }),
              })
            );
          } else {
            // Return a direct message on follow-up
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                message: makeMessage('Here is the direct answer'),
              })
            );
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        on_input_required: 'More context here',
        max_turns: 3,
        timeout: 10_000,
      } as any);

      expect(sendCount).toBe(2);
      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Default timeout and poll_interval are used when not specified
    // -----------------------------------------------------------------------
    it('should use default config values when not explicitly set', async () => {
      // This test just verifies execute doesn't throw when optional config is missing.
      // The agent returns a completed task immediately so defaults are not exercised deeply.
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task: makeTask() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello',
        // No timeout, poll_interval, max_turns, blocking — all use defaults
      } as any);

      expect(result.issues).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // transform_js: returns a ReviewSummary-shaped object
    // -----------------------------------------------------------------------
    it('should apply transform_js that returns ReviewSummary', async () => {
      const task = makeTask();
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review this PR',
        transform_js:
          '({ issues: [{ file: "test.ts", line: 1, ruleId: "a2a/custom", message: "transformed", severity: "warning", category: "style" }] })',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/custom');
      expect(result.issues![0].message).toBe('transformed');
    });

    // -----------------------------------------------------------------------
    // transform_js: returns non-ReviewSummary value (wrapped as output)
    // -----------------------------------------------------------------------
    it('should wrap non-ReviewSummary transform_js result as output', async () => {
      const task = makeTask();
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review this PR',
        transform_js: '"hello world"',
      } as any);

      expect(result.issues).toEqual([]);
      expect((result as any).output).toBe('hello world');
    });

    // -----------------------------------------------------------------------
    // transform_js: has access to pr context
    // -----------------------------------------------------------------------
    it('should provide pr context to transform_js', async () => {
      const task = makeTask();
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo({ title: 'Fix bug #123', number: 55 }), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review',
        transform_js: '({ issues: [], title: pr.title, num: pr.number })',
      } as any);

      expect(result.issues).toEqual([]);
      expect((result as any).title).toBe('Fix bug #123');
      expect((result as any).num).toBe(55);
    });

    // -----------------------------------------------------------------------
    // transform_js: error in expression returns error issue
    // -----------------------------------------------------------------------
    it('should return error issue when transform_js throws', async () => {
      const task = makeTask();
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review',
        transform_js: 'throw new Error("boom")',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/transform_js_error');
      expect(result.issues![0].message).toContain('Failed to apply JavaScript transform');
    });

    // -----------------------------------------------------------------------
    // transform_js: applied to direct message response
    // -----------------------------------------------------------------------
    it('should apply transform_js to direct message response', async () => {
      const msg = makeMessage('Direct agent reply');
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: msg }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Hello agent',
        transform_js:
          '({ issues: [{ file: "msg.ts", line: 1, ruleId: "a2a/msg", message: "from message", severity: "info", category: "style" }] })',
      } as any);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('a2a/msg');
      expect(result.issues![0].message).toBe('from message');
    });

    // -----------------------------------------------------------------------
    // transform_js: receives output (the ReviewSummary) in scope
    // -----------------------------------------------------------------------
    it('should provide original ReviewSummary as output in transform_js scope', async () => {
      const task = makeTask();
      const { port, close } = await startMockServer(async (req, res) => {
        if (req.url === '/message:send') {
          await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ task }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockClose = close;

      const result = await provider.execute(makePRInfo(), {
        type: 'a2a',
        agent_url: `http://127.0.0.1:${port}`,
        message: 'Review',
        transform_js: '({ issues: output.issues, wasEmpty: output.issues.length === 0 })',
      } as any);

      expect(result.issues).toEqual([]);
      expect((result as any).wasEmpty).toBe(true);
    });
  });
});

describe('AgentCardCache', () => {
  it('should cache and return cards', async () => {
    const cache = new AgentCardCache(60_000);
    let fetchCount = 0;

    // Mock global fetch
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          name: 'Test Agent',
          supported_interfaces: [{ url: 'http://localhost:9001' }],
        }),
      };
    }) as any;

    try {
      const card1 = await cache.fetch('http://example.com/agent-card.json');
      expect(card1.name).toBe('Test Agent');
      expect(fetchCount).toBe(1);

      // Second fetch should use cache
      const card2 = await cache.fetch('http://example.com/agent-card.json');
      expect(card2.name).toBe('Test Agent');
      expect(fetchCount).toBe(1); // No additional fetch

      // Clear cache and fetch again
      cache.clear();
      const card3 = await cache.fetch('http://example.com/agent-card.json');
      expect(card3.name).toBe('Test Agent');
      expect(fetchCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should throw on non-ok response', async () => {
    const cache = new AgentCardCache();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })) as any;

    try {
      await expect(cache.fetch('http://example.com/agent-card.json')).rejects.toThrow(
        'Failed to fetch Agent Card'
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should throw on invalid card (missing name)', async () => {
    const cache = new AgentCardCache();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ description: 'no name field' }),
    })) as any;

    try {
      await expect(cache.fetch('http://example.com/agent-card.json')).rejects.toThrow(
        'Missing required fields'
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should invalidate specific URL', async () => {
    const cache = new AgentCardCache(60_000);
    let fetchCount = 0;
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          name: 'Test Agent',
          supported_interfaces: [{ url: 'http://localhost:9001' }],
        }),
      };
    }) as any;

    try {
      await cache.fetch('http://example.com/agent-card.json');
      expect(fetchCount).toBe(1);

      cache.invalidate('http://example.com/agent-card.json');

      await cache.fetch('http://example.com/agent-card.json');
      expect(fetchCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
