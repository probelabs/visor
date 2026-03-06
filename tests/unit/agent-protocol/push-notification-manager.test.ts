import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { PushNotificationManager } from '../../../src/agent-protocol/push-notification-manager';

// ---------------------------------------------------------------------------
// Inline SQLite setup (same pattern as task-store tests)
// ---------------------------------------------------------------------------

let db: any;
let dbPath: string;

function openDb(): any {
  const { createRequire } = require('module') as typeof import('module');
  const runtimeRequire = createRequire(__filename);
  const Database = runtimeRequire('better-sqlite3');
  return new Database(dbPath);
}

describe('PushNotificationManager', () => {
  let manager: PushNotificationManager;

  beforeEach(() => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-push');
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, `test-${crypto.randomUUID()}.db`);
    db = openDb();
    manager = new PushNotificationManager();
    manager.initialize(db);
  });

  afterEach(() => {
    db.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  describe('CRUD operations', () => {
    it('should create a push notification config', () => {
      const config = manager.create({
        task_id: 'task-1',
        url: 'http://example.com/hook',
        auth_scheme: 'Bearer',
        auth_credentials: 'secret-token',
      });

      expect(config.id).toBeDefined();
      expect(config.task_id).toBe('task-1');
      expect(config.url).toBe('http://example.com/hook');
      expect(config.auth_scheme).toBe('Bearer');
    });

    it('should get a push notification config', () => {
      const created = manager.create({
        task_id: 'task-1',
        url: 'http://example.com/hook',
      });

      const retrieved = manager.get('task-1', created.id!);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.url).toBe('http://example.com/hook');
    });

    it('should return null for unknown config', () => {
      const result = manager.get('task-1', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should list push configs for a task', () => {
      manager.create({ task_id: 'task-1', url: 'http://example.com/hook1' });
      manager.create({ task_id: 'task-1', url: 'http://example.com/hook2' });
      manager.create({ task_id: 'task-2', url: 'http://example.com/hook3' });

      const configs = manager.list('task-1');
      expect(configs.length).toBe(2);

      const configs2 = manager.list('task-2');
      expect(configs2.length).toBe(1);
    });

    it('should delete a push notification config', () => {
      const created = manager.create({
        task_id: 'task-1',
        url: 'http://example.com/hook',
      });

      const deleted = manager.delete('task-1', created.id!);
      expect(deleted).toBe(true);

      const retrieved = manager.get('task-1', created.id!);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting unknown config', () => {
      const deleted = manager.delete('task-1', 'nonexistent');
      expect(deleted).toBe(false);
    });

    it('should delete all configs for a task', () => {
      manager.create({ task_id: 'task-1', url: 'http://example.com/hook1' });
      manager.create({ task_id: 'task-1', url: 'http://example.com/hook2' });

      const count = manager.deleteForTask('task-1');
      expect(count).toBe(2);

      const configs = manager.list('task-1');
      expect(configs.length).toBe(0);
    });

    it('should preserve optional fields', () => {
      const created = manager.create({
        task_id: 'task-1',
        url: 'http://example.com/hook',
        token: 'verify-me',
        auth_scheme: 'Bearer',
        auth_credentials: 'secret',
      });

      const retrieved = manager.get('task-1', created.id!)!;
      expect(retrieved.token).toBe('verify-me');
      expect(retrieved.auth_scheme).toBe('Bearer');
      expect(retrieved.auth_credentials).toBe('secret');
    });
  });

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  describe('delivery', () => {
    let fetchMock: jest.SpyInstance;

    beforeEach(() => {
      fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }));
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it('should deliver event to all configs', async () => {
      manager.create({ task_id: 'task-1', url: 'http://hook1.example.com' });
      manager.create({ task_id: 'task-1', url: 'http://hook2.example.com' });

      await manager.notifyAll('task-1', {
        type: 'TaskStatusUpdateEvent',
        task_id: 'task-1',
        context_id: 'ctx-1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should include auth header when configured', async () => {
      manager.create({
        task_id: 'task-1',
        url: 'http://hook.example.com',
        auth_scheme: 'Bearer',
        auth_credentials: 'my-token',
      });

      await manager.notifyAll('task-1', {
        type: 'TaskStatusUpdateEvent',
        task_id: 'task-1',
        context_id: 'ctx-1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[1].headers['Authorization']).toBe('Bearer my-token');
    });

    it('should not retry on 4xx errors', async () => {
      fetchMock.mockResolvedValue(new Response('Bad Request', { status: 400 }));

      manager.create({ task_id: 'task-1', url: 'http://hook.example.com' });

      const fastManager = new PushNotificationManager({
        maxRetries: 3,
        baseDelayMs: 10,
      });
      fastManager.initialize(db);

      await fastManager.notifyAll('task-1', {
        type: 'TaskStatusUpdateEvent',
        task_id: 'task-1',
        context_id: 'ctx-1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });

      // Only 1 call, no retries
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should retry on 5xx errors', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      manager.create({ task_id: 'task-1', url: 'http://hook.example.com' });

      const fastManager = new PushNotificationManager({
        maxRetries: 3,
        baseDelayMs: 10,
      });
      fastManager.initialize(db);

      await fastManager.notifyAll('task-1', {
        type: 'TaskStatusUpdateEvent',
        task_id: 'task-1',
        context_id: 'ctx-1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should retry on network errors', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      manager.create({ task_id: 'task-1', url: 'http://hook.example.com' });

      const fastManager = new PushNotificationManager({
        maxRetries: 3,
        baseDelayMs: 10,
      });
      fastManager.initialize(db);

      await fastManager.notifyAll('task-1', {
        type: 'TaskStatusUpdateEvent',
        task_id: 'task-1',
        context_id: 'ctx-1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should exhaust retries and not throw', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      manager.create({ task_id: 'task-1', url: 'http://hook.example.com' });

      const fastManager = new PushNotificationManager({
        maxRetries: 2,
        baseDelayMs: 10,
      });
      fastManager.initialize(db);

      // Should not throw
      await fastManager.notifyAll('task-1', {
        type: 'TaskStatusUpdateEvent',
        task_id: 'task-1',
        context_id: 'ctx-1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should skip delivery when no configs exist', async () => {
      await manager.notifyAll('task-1', {
        type: 'TaskStatusUpdateEvent',
        task_id: 'task-1',
        context_id: 'ctx-1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should send correct event payload', async () => {
      manager.create({ task_id: 'task-1', url: 'http://hook.example.com' });

      const event = {
        type: 'TaskArtifactUpdateEvent' as const,
        task_id: 'task-1',
        context_id: 'ctx-1',
        artifact: {
          artifact_id: 'art-1',
          name: 'test-check',
          parts: [{ text: 'Result' }],
        },
        append: false,
        last_chunk: true,
      };
      await manager.notifyAll('task-1', event);

      const callArgs = fetchMock.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.type).toBe('TaskArtifactUpdateEvent');
      expect(body.artifact.name).toBe('test-check');
    });
  });
});
