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
    it('should reject streaming with empty parts', async () => {
      const req = {
        message: {
          message_id: crypto.randomUUID(),
          role: 'user',
          parts: [],
        },
      };
      const res = await httpRequest(port, 'POST', '/message:stream', req, authHeaders);
      expect(res.status).toBe(400);
    });

    it('should return 404 for subscribe to unknown task', async () => {
      const res = await httpRequest(
        port,
        'GET',
        '/tasks/nonexistent:subscribe',
        undefined,
        authHeaders
      );
      expect(res.status).toBe(404);
    });
  });

  describe('push notification routes', () => {
    it('should return 404 for push config on unknown task', async () => {
      const res = await httpRequest(
        port,
        'POST',
        '/tasks/nonexistent/pushNotificationConfigs',
        { url: 'http://example.com/hook' },
        authHeaders
      );
      expect(res.status).toBe(404);
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
});
