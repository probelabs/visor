import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { A2AFrontend } from '../../../src/agent-protocol/a2a-frontend';
import { SqliteTaskStore } from '../../../src/agent-protocol/task-store';
import { EventBus } from '../../../src/event-bus/event-bus';
import type {
  AgentProtocolConfig,
  AgentSendMessageRequest,
} from '../../../src/agent-protocol/types';
import type { FrontendContext } from '../../../src/frontends/host';

// Helpers
const TEST_TOKEN = 'test-secret-token';

function makeConfig(overrides: Partial<AgentProtocolConfig> = {}): AgentProtocolConfig {
  return {
    enabled: true,
    protocol: 'a2a',
    port: 0, // OS-assigned port to avoid collisions
    host: '127.0.0.1',
    auth: { type: 'bearer', token_env: 'TEST_A2A_TOKEN' },
    default_workflow: 'assistant',
    ...overrides,
  };
}

function makeFrontendContext(): FrontendContext {
  return {
    eventBus: new EventBus(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {},
    run: { runId: 'test-run' },
  };
}

function makeSendRequest(
  overrides: Partial<AgentSendMessageRequest> = {}
): AgentSendMessageRequest {
  return {
    message: {
      message_id: crypto.randomUUID(),
      role: 'user',
      parts: [{ text: 'Hello agent', media_type: 'text/plain' }],
    },
    ...overrides,
  };
}

async function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode!, body: parsed });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('A2AFrontend', () => {
  let frontend: A2AFrontend;
  let taskStore: SqliteTaskStore;
  let dbPath: string;
  let port: number;

  beforeEach(async () => {
    // Set auth token env
    process.env.TEST_A2A_TOKEN = TEST_TOKEN;

    // Setup DB
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-a2a-frontend');
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, `test-${crypto.randomUUID()}.db`);
    taskStore = new SqliteTaskStore(dbPath);

    const config = makeConfig();
    frontend = new A2AFrontend(config, taskStore);
    await frontend.start(makeFrontendContext());
    port = frontend.boundPort;
  });

  afterEach(async () => {
    await frontend.stop();
    delete process.env.TEST_A2A_TOKEN;
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {
      // ignore
    }
  });

  const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}` };

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe('authentication', () => {
    it('should reject requests without auth', async () => {
      const res = await httpRequest(port, 'POST', '/message:send', makeSendRequest());
      expect(res.status).toBe(401);
    });

    it('should reject requests with wrong token', async () => {
      const res = await httpRequest(port, 'POST', '/message:send', makeSendRequest(), {
        Authorization: 'Bearer wrong-token',
      });
      expect(res.status).toBe(401);
    });

    it('should accept requests with correct token', async () => {
      const res = await httpRequest(port, 'POST', '/message:send', makeSendRequest(), authHeaders);
      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Agent Card
  // -----------------------------------------------------------------------

  describe('agent card', () => {
    it('should return 404 when no agent card configured', async () => {
      const res = await httpRequest(port, 'GET', '/.well-known/agent-card.json');
      expect(res.status).toBe(404);
    });

    it('should serve agent card when configured', async () => {
      // Stop current frontend
      await frontend.stop();

      // Create agent card file
      const cardPath = path.join(path.dirname(dbPath), 'test-agent-card.json');
      const card = {
        name: 'Test Agent',
        supported_interfaces: [{ url: '__PATCHED__' }],
        skills: [],
      };
      fs.writeFileSync(cardPath, JSON.stringify(card));

      const config = makeConfig({
        agent_card: cardPath,
        public_url: 'https://test.example.com',
      });
      frontend = new A2AFrontend(config, new SqliteTaskStore(dbPath));
      await frontend.start(makeFrontendContext());

      const res = await httpRequest(frontend.boundPort, 'GET', '/.well-known/agent-card.json');
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.name).toBe('Test Agent');
      const interfaces = body.supported_interfaces as Array<{ url: string }>;
      expect(interfaces[0].url).toBe('https://test.example.com');

      fs.unlinkSync(cardPath);
    });

    it('should not require auth for agent card', async () => {
      const res = await httpRequest(port, 'GET', '/.well-known/agent-card.json');
      // No auth header, should still get a response (404 since no card configured, not 401)
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // SendMessage
  // -----------------------------------------------------------------------

  describe('POST /message:send', () => {
    it('should create a task and return it', async () => {
      const res = await httpRequest(port, 'POST', '/message:send', makeSendRequest(), authHeaders);
      expect(res.status).toBe(200);
      const body = res.body as { task: Record<string, unknown> };
      expect(body.task).toBeDefined();
      expect(body.task.id).toBeDefined();
      expect(body.task.status).toBeDefined();
      expect((body.task.status as any).state).toBe('submitted');
    });

    it('should execute blocking request and return completed task', async () => {
      const req = makeSendRequest({
        configuration: { blocking: true },
      });
      const res = await httpRequest(port, 'POST', '/message:send', req, authHeaders);
      expect(res.status).toBe(200);
      const body = res.body as { task: Record<string, unknown> };
      expect(body.task).toBeDefined();
      expect((body.task.status as any).state).toBe('completed');
    });

    it('should reject empty message parts', async () => {
      const req = {
        message: {
          message_id: crypto.randomUUID(),
          role: 'user',
          parts: [],
        },
      };
      const res = await httpRequest(port, 'POST', '/message:send', req, authHeaders);
      expect(res.status).toBe(400);
    });

    it('should respect history_length in blocking response', async () => {
      const req = makeSendRequest({
        configuration: { blocking: true, history_length: 1 },
      });
      const res = await httpRequest(port, 'POST', '/message:send', req, authHeaders);
      expect(res.status).toBe(200);
      const body = res.body as { task: { history: unknown[] } };
      expect(body.task.history.length).toBeLessThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // GetTask
  // -----------------------------------------------------------------------

  describe('GET /tasks/{id}', () => {
    it('should return task by ID', async () => {
      // Create a task first
      const createRes = await httpRequest(
        port,
        'POST',
        '/message:send',
        makeSendRequest(),
        authHeaders
      );
      const taskId = (createRes.body as any).task.id;

      const res = await httpRequest(port, 'GET', `/tasks/${taskId}`, undefined, authHeaders);
      expect(res.status).toBe(200);
      expect((res.body as any).id).toBe(taskId);
    });

    it('should return 404 for unknown task', async () => {
      const res = await httpRequest(port, 'GET', '/tasks/nonexistent', undefined, authHeaders);
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // ListTasks
  // -----------------------------------------------------------------------

  describe('GET /tasks', () => {
    it('should list all tasks', async () => {
      // Create 2 tasks
      await httpRequest(port, 'POST', '/message:send', makeSendRequest(), authHeaders);
      await httpRequest(port, 'POST', '/message:send', makeSendRequest(), authHeaders);

      const res = await httpRequest(port, 'GET', '/tasks', undefined, authHeaders);
      expect(res.status).toBe(200);
      const body = res.body as { tasks: unknown[]; total: number };
      expect(body.tasks.length).toBe(2);
      expect(body.total).toBe(2);
    });

    it('should support pagination', async () => {
      await httpRequest(port, 'POST', '/message:send', makeSendRequest(), authHeaders);
      await httpRequest(port, 'POST', '/message:send', makeSendRequest(), authHeaders);
      await httpRequest(port, 'POST', '/message:send', makeSendRequest(), authHeaders);

      const res = await httpRequest(port, 'GET', '/tasks?limit=2&offset=0', undefined, authHeaders);
      expect(res.status).toBe(200);
      const body = res.body as { tasks: unknown[]; total: number };
      expect(body.tasks.length).toBe(2);
      expect(body.total).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // CancelTask
  // -----------------------------------------------------------------------

  describe('POST /tasks/{id}:cancel', () => {
    it('should cancel a submitted task', async () => {
      const createRes = await httpRequest(
        port,
        'POST',
        '/message:send',
        makeSendRequest(),
        authHeaders
      );
      const taskId = (createRes.body as any).task.id;

      const res = await httpRequest(port, 'POST', `/tasks/${taskId}:cancel`, {}, authHeaders);
      expect(res.status).toBe(200);
      expect((res.body as any).status.state).toBe('canceled');
    });

    it('should return 404 for unknown task', async () => {
      const res = await httpRequest(port, 'POST', '/tasks/nonexistent:cancel', {}, authHeaders);
      expect(res.status).toBe(404);
    });

    it('should return 409 for already completed task', async () => {
      // Create blocking (completes immediately)
      const createRes = await httpRequest(
        port,
        'POST',
        '/message:send',
        makeSendRequest({ configuration: { blocking: true } }),
        authHeaders
      );
      const taskId = (createRes.body as any).task.id;

      const res = await httpRequest(port, 'POST', `/tasks/${taskId}:cancel`, {}, authHeaders);
      expect(res.status).toBe(409);
    });
  });

  // -----------------------------------------------------------------------
  // Unsupported routes
  // -----------------------------------------------------------------------

  describe('streaming routes', () => {
    it('should reject streaming when capability is not enabled', async () => {
      const req = makeSendRequest();
      const res = await httpRequest(port, 'POST', '/message:stream', req, authHeaders);
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe(-32002);
      expect((res.body as any).error.message).toBe('Streaming not supported');
    });

    it('should reject subscribe when capability is not enabled', async () => {
      const res = await httpRequest(
        port,
        'GET',
        '/tasks/nonexistent:subscribe',
        undefined,
        authHeaders
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe(-32002);
      expect((res.body as any).error.message).toBe('Streaming not supported');
    });
  });

  describe('push notification routes', () => {
    it('should reject push config when capability is not enabled', async () => {
      const res = await httpRequest(
        port,
        'POST',
        '/tasks/nonexistent/pushNotificationConfigs',
        { url: 'http://example.com/hook' },
        authHeaders
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe(-32002);
      expect((res.body as any).error.message).toBe('Push notifications not supported');
    });

    it('should reject push config GET when capability is not enabled', async () => {
      const res = await httpRequest(
        port,
        'GET',
        '/tasks/nonexistent/pushNotificationConfigs',
        undefined,
        authHeaders
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe(-32002);
      expect((res.body as any).error.message).toBe('Push notifications not supported');
    });

    it('should reject push config detail GET when capability is not enabled', async () => {
      const res = await httpRequest(
        port,
        'GET',
        '/tasks/nonexistent/pushNotificationConfigs/some-config-id',
        undefined,
        authHeaders
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe(-32002);
      expect((res.body as any).error.message).toBe('Push notifications not supported');
    });

    it('should reject push config DELETE when capability is not enabled', async () => {
      const res = await httpRequest(
        port,
        'DELETE',
        '/tasks/nonexistent/pushNotificationConfigs/some-config-id',
        undefined,
        authHeaders
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe(-32002);
      expect((res.body as any).error.message).toBe('Push notifications not supported');
    });
  });

  describe('unsupported routes', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await httpRequest(port, 'GET', '/unknown', undefined, authHeaders);
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Error format
  // -----------------------------------------------------------------------

  describe('error format', () => {
    it('should return A2A-style error response', async () => {
      const res = await httpRequest(port, 'GET', '/tasks/nonexistent', undefined, authHeaders);
      expect(res.status).toBe(404);
      const body = res.body as { error: { code: number; message: string } };
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain('Task not found');
    });
  });

  // -----------------------------------------------------------------------
  // Engine wiring
  // -----------------------------------------------------------------------

  describe('engine wiring', () => {
    it('should accept engine and visorConfig setters', async () => {
      const mockEngine = {
        executeChecks: jest.fn().mockResolvedValue({
          reviewSummary: { issues: [] },
          checksExecuted: ['test-check'],
          executionTime: 100,
          timestamp: new Date().toISOString(),
          repositoryInfo: {},
        }),
      };
      const mockConfig = { checks: { 'test-check': { type: 'ai' } } };

      frontend.setEngine(mockEngine);
      frontend.setVisorConfig(mockConfig as any);

      const req = makeSendRequest({
        configuration: { blocking: true },
      });
      const res = await httpRequest(port, 'POST', '/message:send', req, authHeaders);

      expect(res.status).toBe(200);
      const body = res.body as { task: { status: { state: string }; history: any[] } };
      expect(body.task.status.state).toBe('completed');
      expect(mockEngine.executeChecks).toHaveBeenCalledTimes(1);
    });

    it('should serve inline agent card', async () => {
      // Stop current frontend to create a new one with inline card
      await frontend.stop();

      const inlineConfig = makeConfig({
        agent_card_inline: {
          name: 'Test Agent',
          description: 'A test agent',
          capabilities: { streaming: true },
          skills: [{ id: 'test', name: 'Test', description: 'Test skill' }],
        } as any,
      });

      const inlineDbPath = path.join(path.dirname(dbPath), `test-inline-${crypto.randomUUID()}.db`);
      frontend = new A2AFrontend(inlineConfig, new SqliteTaskStore(inlineDbPath));
      await frontend.start(makeFrontendContext());

      const res = await httpRequest(frontend.boundPort, 'GET', '/.well-known/agent-card.json');
      expect(res.status).toBe(200);
      const card = res.body as {
        name: string;
        capabilities: { streaming: boolean };
        supported_interfaces: Array<{ url: string }>;
      };
      expect(card.name).toBe('Test Agent');
      expect(card.capabilities.streaming).toBe(true);
      expect(card.supported_interfaces).toBeDefined();
      expect(card.supported_interfaces[0].url).toContain(String(frontend.boundPort));

      // Clean up inline db
      try {
        fs.unlinkSync(inlineDbPath);
        fs.unlinkSync(inlineDbPath + '-wal');
        fs.unlinkSync(inlineDbPath + '-shm');
      } catch {
        // ignore
      }
    });

    it('should use stub execution when no engine is set', async () => {
      // Default frontend has no engine — should use stub
      const req = makeSendRequest({
        configuration: { blocking: true },
      });
      const res = await httpRequest(port, 'POST', '/message:send', req, authHeaders);

      expect(res.status).toBe(200);
      const body = res.body as {
        task: {
          status: { state: string };
          history: Array<{ role: string; parts: Array<{ text: string }> }>;
        };
      };
      expect(body.task.status.state).toBe('completed');
      expect(
        body.task.history.some(m => m.parts?.[0]?.text?.includes('received and processed'))
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Capability enforcement with capabilities enabled
  // -----------------------------------------------------------------------

  describe('capability enforcement (enabled)', () => {
    let capFrontend: A2AFrontend;
    let capDbPath: string;
    let capPort: number;

    beforeEach(async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-a2a-frontend');
      fs.mkdirSync(tmpDir, { recursive: true });
      capDbPath = path.join(tmpDir, `test-cap-${crypto.randomUUID()}.db`);

      const config = makeConfig({
        agent_card_inline: {
          name: 'Cap Agent',
          description: 'Agent with capabilities',
          capabilities: { streaming: true, push_notifications: true },
          skills: [],
        } as any,
      });

      capFrontend = new A2AFrontend(config, new SqliteTaskStore(capDbPath));
      await capFrontend.start(makeFrontendContext());
      capPort = capFrontend.boundPort;
    });

    afterEach(async () => {
      await capFrontend.stop();
      try {
        fs.unlinkSync(capDbPath);
        fs.unlinkSync(capDbPath + '-wal');
        fs.unlinkSync(capDbPath + '-shm');
      } catch {
        // ignore
      }
    });

    it('should allow streaming when capability is enabled', async () => {
      const req = makeSendRequest();
      // Streaming returns SSE so we just verify it does not return 400/-32002
      const res = await httpRequest(capPort, 'POST', '/message:stream', req, authHeaders);
      // Should NOT be a capability error
      expect((res.body as any)?.error?.code).not.toBe(-32002);
    });

    it('should return 404 for subscribe to unknown task when streaming is enabled', async () => {
      const res = await httpRequest(
        capPort,
        'GET',
        '/tasks/nonexistent:subscribe',
        undefined,
        authHeaders
      );
      expect(res.status).toBe(404);
      expect((res.body as any).error.code).toBe(-32001);
    });

    it('should return 404 for push config on unknown task when push is enabled', async () => {
      const res = await httpRequest(
        capPort,
        'POST',
        '/tasks/nonexistent/pushNotificationConfigs',
        { url: 'http://example.com/hook' },
        authHeaders
      );
      expect(res.status).toBe(404);
      expect((res.body as any).error.code).toBe(-32001);
    });

    it('should return 404 for push config detail on unknown task when push is enabled', async () => {
      const res = await httpRequest(
        capPort,
        'GET',
        '/tasks/nonexistent/pushNotificationConfigs/some-id',
        undefined,
        authHeaders
      );
      expect(res.status).toBe(404);
      expect((res.body as any).error.code).toBe(-32001);
    });
  });

  // -----------------------------------------------------------------------
  // Follow-up messages
  // -----------------------------------------------------------------------

  describe('follow-up messages', () => {
    it('should resume a task in input_required state (blocking)', async () => {
      // Create a non-blocking task (stays in submitted)
      const createRes = await httpRequest(
        port,
        'POST',
        '/message:send',
        makeSendRequest(),
        authHeaders
      );
      const taskId = (createRes.body as any).task.id;

      // Manually transition submitted -> working -> input_required
      taskStore.updateTaskState(taskId, 'working');
      taskStore.updateTaskState(taskId, 'input_required', {
        message_id: crypto.randomUUID(),
        role: 'agent',
        parts: [{ text: 'Please provide input' }],
      });

      // Send follow-up message (blocking)
      const followUp = makeSendRequest({
        message: {
          message_id: crypto.randomUUID(),
          role: 'user',
          task_id: taskId,
          parts: [{ text: 'Here is my input', media_type: 'text/plain' }],
        },
        configuration: { blocking: true },
      });
      const res = await httpRequest(port, 'POST', '/message:send', followUp, authHeaders);
      expect(res.status).toBe(200);
      expect((res.body as any).task.status.state).toBe('completed');
    });

    it('should reject follow-up to non-existent task', async () => {
      const followUp = makeSendRequest({
        message: {
          message_id: crypto.randomUUID(),
          role: 'user',
          task_id: 'nonexistent-task',
          parts: [{ text: 'Follow up', media_type: 'text/plain' }],
        },
      });
      const res = await httpRequest(port, 'POST', '/message:send', followUp, authHeaders);
      expect(res.status).toBe(404);
    });

    it('should reject follow-up to task not in input_required state', async () => {
      // Create a task (non-blocking, stays in submitted)
      const createRes = await httpRequest(
        port,
        'POST',
        '/message:send',
        makeSendRequest(),
        authHeaders
      );
      const taskId = (createRes.body as any).task.id;

      const followUp = makeSendRequest({
        message: {
          message_id: crypto.randomUUID(),
          role: 'user',
          task_id: taskId,
          parts: [{ text: 'Follow up', media_type: 'text/plain' }],
        },
      });
      const res = await httpRequest(port, 'POST', '/message:send', followUp, authHeaders);
      expect(res.status).toBe(409);
    });
  });

  // -----------------------------------------------------------------------
  // ParseError
  // -----------------------------------------------------------------------

  describe('parse error', () => {
    it('should return -32700 for malformed JSON body', async () => {
      // Send raw malformed JSON
      const res = await new Promise<{ status: number; body: unknown }>(resolve => {
        const reqOpts = {
          hostname: '127.0.0.1',
          port,
          path: '/message:send',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_TOKEN}`,
          },
        };
        const req = http.request(reqOpts, res => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ status: res.statusCode!, body });
          });
        });
        req.write('not valid json{{{');
        req.end();
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error.code).toBe(-32700);
    });
  });

  // -----------------------------------------------------------------------
  // API key query parameter auth
  // -----------------------------------------------------------------------

  describe('api_key query parameter auth', () => {
    let apiFrontend: InstanceType<typeof A2AFrontend>;
    let apiPort: number;
    let apiDbPath: string;
    const API_KEY = 'test-api-key-12345';

    beforeEach(async () => {
      process.env.TEST_API_KEY = API_KEY;
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-a2a-frontend');
      fs.mkdirSync(tmpDir, { recursive: true });
      apiDbPath = path.join(tmpDir, `test-apikey-${crypto.randomUUID()}.db`);

      const config = makeConfig({
        auth: { type: 'api_key', key_env: 'TEST_API_KEY' } as any,
      });
      apiFrontend = new A2AFrontend(config, new SqliteTaskStore(apiDbPath));
      await apiFrontend.start(makeFrontendContext());
      apiPort = apiFrontend.boundPort;
    });

    afterEach(async () => {
      await apiFrontend.stop();
      delete process.env.TEST_API_KEY;
      try {
        fs.unlinkSync(apiDbPath);
        fs.unlinkSync(apiDbPath + '-wal');
        fs.unlinkSync(apiDbPath + '-shm');
      } catch {
        /* ignore */
      }
    });

    it('should accept api_key via header', async () => {
      const res = await httpRequest(apiPort, 'POST', '/message:send', makeSendRequest(), {
        'x-api-key': API_KEY,
      });
      expect(res.status).toBe(200);
    });

    it('should accept api_key via query parameter', async () => {
      const res = await httpRequest(
        apiPort,
        'POST',
        `/message:send?api_key=${API_KEY}`,
        makeSendRequest(),
        {}
      );
      expect(res.status).toBe(200);
    });

    it('should reject wrong api_key in query parameter', async () => {
      const res = await httpRequest(
        apiPort,
        'POST',
        '/message:send?api_key=wrong-key',
        makeSendRequest(),
        {}
      );
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // Auth type none
  // -----------------------------------------------------------------------

  describe('auth type none', () => {
    let noneFrontend: A2AFrontend;
    let noneDbPath: string;
    let nonePort: number;

    beforeEach(async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-a2a-frontend');
      fs.mkdirSync(tmpDir, { recursive: true });
      noneDbPath = path.join(tmpDir, `test-none-auth-${crypto.randomUUID()}.db`);

      const config = makeConfig({
        auth: { type: 'none' },
      });
      noneFrontend = new A2AFrontend(config, new SqliteTaskStore(noneDbPath));
      await noneFrontend.start(makeFrontendContext());
      nonePort = noneFrontend.boundPort;
    });

    afterEach(async () => {
      await noneFrontend.stop();
      try {
        fs.unlinkSync(noneDbPath);
        fs.unlinkSync(noneDbPath + '-wal');
        fs.unlinkSync(noneDbPath + '-shm');
      } catch {
        /* ignore */
      }
    });

    it('should accept requests without any auth headers', async () => {
      const res = await httpRequest(nonePort, 'POST', '/message:send', makeSendRequest());
      expect(res.status).toBe(200);
      const body = res.body as { task: Record<string, unknown> };
      expect(body.task).toBeDefined();
      expect(body.task.id).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Skill routing via metadata.skill_id
  // -----------------------------------------------------------------------

  describe('skill routing', () => {
    let skillFrontend: A2AFrontend;
    let skillDbPath: string;
    let skillPort: number;
    let mockEngine: { executeChecks: jest.Mock };

    beforeEach(async () => {
      process.env.TEST_A2A_TOKEN = TEST_TOKEN;
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-a2a-frontend');
      fs.mkdirSync(tmpDir, { recursive: true });
      skillDbPath = path.join(tmpDir, `test-skill-${crypto.randomUUID()}.db`);

      const config = makeConfig({
        skill_routing: { 'security-scan': 'security-review' },
        default_workflow: 'default-check',
      });
      skillFrontend = new A2AFrontend(config, new SqliteTaskStore(skillDbPath));

      mockEngine = {
        executeChecks: jest.fn().mockResolvedValue({
          reviewSummary: { issues: [] },
          checksExecuted: ['security-review'],
          executionTime: 50,
          timestamp: new Date().toISOString(),
          repositoryInfo: {},
        }),
      };
      skillFrontend.setEngine(mockEngine);
      skillFrontend.setVisorConfig({ checks: { 'security-review': { type: 'ai' } } } as any);

      await skillFrontend.start(makeFrontendContext());
      skillPort = skillFrontend.boundPort;
    });

    afterEach(async () => {
      await skillFrontend.stop();
      delete process.env.TEST_A2A_TOKEN;
      try {
        fs.unlinkSync(skillDbPath);
        fs.unlinkSync(skillDbPath + '-wal');
        fs.unlinkSync(skillDbPath + '-shm');
      } catch {
        /* ignore */
      }
    });

    it('should route to the mapped workflow when metadata.skill_id matches', async () => {
      const req = makeSendRequest({
        metadata: { skill_id: 'security-scan' },
        configuration: { blocking: true },
      });
      const res = await httpRequest(skillPort, 'POST', '/message:send', req, authHeaders);
      expect(res.status).toBe(200);
      expect(mockEngine.executeChecks).toHaveBeenCalledTimes(1);
      const callArg = mockEngine.executeChecks.mock.calls[0][0];
      expect(callArg.checks).toContain('security-review');
    });
  });

  // -----------------------------------------------------------------------
  // Default workflow fallback (no skill_id)
  // -----------------------------------------------------------------------

  describe('default workflow fallback', () => {
    let defaultFrontend: A2AFrontend;
    let defaultDbPath: string;
    let defaultPort: number;
    let mockEngine: { executeChecks: jest.Mock };

    beforeEach(async () => {
      process.env.TEST_A2A_TOKEN = TEST_TOKEN;
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-a2a-frontend');
      fs.mkdirSync(tmpDir, { recursive: true });
      defaultDbPath = path.join(tmpDir, `test-default-wf-${crypto.randomUUID()}.db`);

      const config = makeConfig({
        skill_routing: { 'security-scan': 'security-review' },
        default_workflow: 'default-check',
      });
      defaultFrontend = new A2AFrontend(config, new SqliteTaskStore(defaultDbPath));

      mockEngine = {
        executeChecks: jest.fn().mockResolvedValue({
          reviewSummary: { issues: [] },
          checksExecuted: ['default-check'],
          executionTime: 30,
          timestamp: new Date().toISOString(),
          repositoryInfo: {},
        }),
      };
      defaultFrontend.setEngine(mockEngine);
      defaultFrontend.setVisorConfig({ checks: { 'default-check': { type: 'ai' } } } as any);

      await defaultFrontend.start(makeFrontendContext());
      defaultPort = defaultFrontend.boundPort;
    });

    afterEach(async () => {
      await defaultFrontend.stop();
      delete process.env.TEST_A2A_TOKEN;
      try {
        fs.unlinkSync(defaultDbPath);
        fs.unlinkSync(defaultDbPath + '-wal');
        fs.unlinkSync(defaultDbPath + '-shm');
      } catch {
        /* ignore */
      }
    });

    it('should fall back to default_workflow when no skill_id is provided', async () => {
      const req = makeSendRequest({
        configuration: { blocking: true },
      });
      const res = await httpRequest(defaultPort, 'POST', '/message:send', req, authHeaders);
      expect(res.status).toBe(200);
      expect(mockEngine.executeChecks).toHaveBeenCalledTimes(1);
      const callArg = mockEngine.executeChecks.mock.calls[0][0];
      expect(callArg.checks).toContain('default-check');
    });
  });
});
