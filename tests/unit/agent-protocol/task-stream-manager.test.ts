import http from 'http';
import { TaskStreamManager } from '../../../src/agent-protocol/task-stream-manager';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../../../src/agent-protocol/types';

// ---------------------------------------------------------------------------
// Mock ServerResponse
// ---------------------------------------------------------------------------

class MockResponse {
  writable = true;
  chunks: string[] = [];
  headers: Record<string, string | number> = {};
  statusCode = 0;
  ended = false;
  private closeHandlers: Array<() => void> = [];

  writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status;
    Object.assign(this.headers, headers);
  }

  write(data: string): boolean {
    this.chunks.push(data);
    return true;
  }

  end(): void {
    this.ended = true;
    this.writable = false;
  }

  on(event: string, handler: () => void): void {
    if (event === 'close') {
      this.closeHandlers.push(handler);
    }
  }

  simulateClose(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('TaskStreamManager', () => {
  let manager: TaskStreamManager;

  beforeEach(() => {
    // Use a very short keepalive for tests
    manager = new TaskStreamManager(60_000);
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('should subscribe and set SSE headers', () => {
    const res = new MockResponse();
    manager.subscribe('task-1', res as unknown as http.ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['Cache-Control']).toBe('no-cache');
    expect(res.headers['Connection']).toBe('keep-alive');
    expect(manager.hasSubscribers('task-1')).toBe(true);
    expect(manager.getSubscriberCount('task-1')).toBe(1);
  });

  it('should emit events to subscribers', () => {
    const res = new MockResponse();
    manager.subscribe('task-1', res as unknown as http.ServerResponse);

    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'working', timestamp: new Date().toISOString() },
    };
    manager.emit('task-1', event);

    expect(res.chunks.length).toBe(1);
    const parsed = JSON.parse(res.chunks[0].replace('data: ', '').trim());
    expect(parsed.type).toBe('TaskStatusUpdateEvent');
    expect(parsed.status.state).toBe('working');
  });

  it('should emit to multiple subscribers', () => {
    const res1 = new MockResponse();
    const res2 = new MockResponse();
    manager.subscribe('task-1', res1 as unknown as http.ServerResponse);
    manager.subscribe('task-1', res2 as unknown as http.ServerResponse);

    expect(manager.getSubscriberCount('task-1')).toBe(2);

    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'working', timestamp: new Date().toISOString() },
    };
    manager.emit('task-1', event);

    expect(res1.chunks.length).toBe(1);
    expect(res2.chunks.length).toBe(1);
  });

  it('should close connections on terminal state', () => {
    const res = new MockResponse();
    manager.subscribe('task-1', res as unknown as http.ServerResponse);

    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    };
    manager.emit('task-1', event);

    // Event should have been sent before closing
    expect(res.chunks.length).toBe(1);
    expect(res.ended).toBe(true);
    expect(manager.hasSubscribers('task-1')).toBe(false);
  });

  it('should close connections on failed state', () => {
    const res = new MockResponse();
    manager.subscribe('task-1', res as unknown as http.ServerResponse);

    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'failed', timestamp: new Date().toISOString() },
    };
    manager.emit('task-1', event);

    expect(res.ended).toBe(true);
    expect(manager.hasSubscribers('task-1')).toBe(false);
  });

  it('should not close connections on non-terminal state', () => {
    const res = new MockResponse();
    manager.subscribe('task-1', res as unknown as http.ServerResponse);

    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'working', timestamp: new Date().toISOString() },
    };
    manager.emit('task-1', event);

    expect(res.ended).toBe(false);
    expect(manager.hasSubscribers('task-1')).toBe(true);
  });

  it('should emit artifact events', () => {
    const res = new MockResponse();
    manager.subscribe('task-1', res as unknown as http.ServerResponse);

    const event: TaskArtifactUpdateEvent = {
      type: 'TaskArtifactUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      artifact: {
        artifact_id: 'art-1',
        name: 'test-check',
        parts: [{ text: 'Result data' }],
      },
      append: false,
      last_chunk: true,
    };
    manager.emit('task-1', event);

    expect(res.chunks.length).toBe(1);
    const parsed = JSON.parse(res.chunks[0].replace('data: ', '').trim());
    expect(parsed.type).toBe('TaskArtifactUpdateEvent');
    expect(parsed.artifact.name).toBe('test-check');
    expect(parsed.last_chunk).toBe(true);
  });

  it('should clean up on client disconnect', () => {
    const res = new MockResponse();
    manager.subscribe('task-1', res as unknown as http.ServerResponse);

    expect(manager.hasSubscribers('task-1')).toBe(true);

    // Simulate client disconnect
    res.simulateClose();

    expect(manager.hasSubscribers('task-1')).toBe(false);
  });

  it('should not emit to disconnected subscribers', () => {
    const res1 = new MockResponse();
    const res2 = new MockResponse();
    manager.subscribe('task-1', res1 as unknown as http.ServerResponse);
    manager.subscribe('task-1', res2 as unknown as http.ServerResponse);

    // Disconnect res1
    res1.simulateClose();

    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'working', timestamp: new Date().toISOString() },
    };
    manager.emit('task-1', event);

    expect(res1.chunks.length).toBe(0);
    expect(res2.chunks.length).toBe(1);
  });

  it('should handle emit with no subscribers gracefully', () => {
    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'working', timestamp: new Date().toISOString() },
    };
    // Should not throw
    manager.emit('task-1', event);
    expect(manager.hasSubscribers('task-1')).toBe(false);
  });

  it('should send keepalive comments', async () => {
    // Use a very short keepalive interval for testing
    const fastManager = new TaskStreamManager(50);
    const res = new MockResponse();
    fastManager.subscribe('task-1', res as unknown as http.ServerResponse);

    // Wait for keepalive
    await sleep(120);

    fastManager.shutdown();

    // Should have at least one keepalive
    const keepalives = res.chunks.filter(c => c.startsWith(': keepalive'));
    expect(keepalives.length).toBeGreaterThan(0);
  });

  it('should shutdown all connections', () => {
    const res1 = new MockResponse();
    const res2 = new MockResponse();
    manager.subscribe('task-1', res1 as unknown as http.ServerResponse);
    manager.subscribe('task-2', res2 as unknown as http.ServerResponse);

    manager.shutdown();

    expect(res1.ended).toBe(true);
    expect(res2.ended).toBe(true);
    expect(manager.hasSubscribers('task-1')).toBe(false);
    expect(manager.hasSubscribers('task-2')).toBe(false);
  });

  it('should isolate events between different tasks', () => {
    const res1 = new MockResponse();
    const res2 = new MockResponse();
    manager.subscribe('task-1', res1 as unknown as http.ServerResponse);
    manager.subscribe('task-2', res2 as unknown as http.ServerResponse);

    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: 'task-1',
      context_id: 'ctx-1',
      status: { state: 'working', timestamp: new Date().toISOString() },
    };
    manager.emit('task-1', event);

    expect(res1.chunks.length).toBe(1);
    expect(res2.chunks.length).toBe(0);
  });
});
