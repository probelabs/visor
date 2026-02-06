import { SessionRegistry } from '../../src/session-registry';
import { ProbeAgent } from '@probelabs/probe';

// Mock ProbeAgent
const mockAgent1 = {
  answer: jest.fn().mockResolvedValue('Mock response 1'),
} as unknown as ProbeAgent;

const mockAgent2 = {
  answer: jest.fn().mockResolvedValue('Mock response 2'),
} as unknown as ProbeAgent;

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    // Get a fresh instance for each test
    registry = SessionRegistry.getInstance();
    // Clear all sessions before each test
    registry.clearAllSessions();
  });

  afterEach(() => {
    // Clean up after each test
    registry.clearAllSessions();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = SessionRegistry.getInstance();
      const instance2 = SessionRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('registerSession', () => {
    it('should register a new session', () => {
      const sessionId = 'test-session-1';
      registry.registerSession(sessionId, mockAgent1);

      expect(registry.hasSession(sessionId)).toBe(true);
    });

    it('should overwrite existing session with same ID', () => {
      const sessionId = 'test-session-1';
      registry.registerSession(sessionId, mockAgent1);
      registry.registerSession(sessionId, mockAgent2);

      const retrievedAgent = registry.getSession(sessionId);
      expect(retrievedAgent).toBe(mockAgent2);
    });
  });

  describe('getSession', () => {
    it('should return registered session', () => {
      const sessionId = 'test-session-1';
      registry.registerSession(sessionId, mockAgent1);

      const retrievedAgent = registry.getSession(sessionId);
      expect(retrievedAgent).toBe(mockAgent1);
    });

    it('should return undefined for non-existent session', () => {
      const retrievedAgent = registry.getSession('non-existent');
      expect(retrievedAgent).toBeUndefined();
    });
  });

  describe('hasSession', () => {
    it('should return true for existing session', () => {
      const sessionId = 'test-session-1';
      registry.registerSession(sessionId, mockAgent1);

      expect(registry.hasSession(sessionId)).toBe(true);
    });

    it('should return false for non-existent session', () => {
      expect(registry.hasSession('non-existent')).toBe(false);
    });
  });

  describe('unregisterSession', () => {
    it('should remove existing session', () => {
      const sessionId = 'test-session-1';
      registry.registerSession(sessionId, mockAgent1);

      expect(registry.hasSession(sessionId)).toBe(true);
      registry.unregisterSession(sessionId);
      expect(registry.hasSession(sessionId)).toBe(false);
    });

    it('should do nothing for non-existent session', () => {
      // Should not throw error
      expect(() => registry.unregisterSession('non-existent')).not.toThrow();
    });
  });

  describe('getActiveSessionIds', () => {
    it('should return empty array when no sessions', () => {
      const sessionIds = registry.getActiveSessionIds();
      expect(sessionIds).toEqual([]);
    });

    it('should return array of active session IDs', () => {
      registry.registerSession('session-1', mockAgent1);
      registry.registerSession('session-2', mockAgent2);

      const sessionIds = registry.getActiveSessionIds();
      expect(sessionIds).toContain('session-1');
      expect(sessionIds).toContain('session-2');
      expect(sessionIds).toHaveLength(2);
    });
  });

  describe('clearAllSessions', () => {
    it('should remove all sessions', () => {
      registry.registerSession('session-1', mockAgent1);
      registry.registerSession('session-2', mockAgent2);

      expect(registry.getActiveSessionIds()).toHaveLength(2);

      registry.clearAllSessions();

      expect(registry.getActiveSessionIds()).toHaveLength(0);
      expect(registry.hasSession('session-1')).toBe(false);
      expect(registry.hasSession('session-2')).toBe(false);
    });
  });

  describe('cloneSession', () => {
    it('should deep clone conversation history', async () => {
      // Create a mock agent with conversation history
      const originalHistory = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      const clonedHistory = JSON.parse(JSON.stringify(originalHistory));

      const sourceAgent = {
        answer: jest.fn(),
        history: originalHistory,
        options: { sessionId: 'source-session' },
        clone: jest.fn().mockReturnValue({
          answer: jest.fn(),
          history: clonedHistory,
          options: { sessionId: 'cloned-session' },
        }),
      } as any;

      registry.registerSession('source-session', sourceAgent);

      // Clone the session
      const clonedAgent = await registry.cloneSession('source-session', 'cloned-session');

      expect(clonedAgent).toBeDefined();
      expect(sourceAgent.clone).toHaveBeenCalledWith({
        sessionId: 'cloned-session',
        stripInternalMessages: true,
        keepSystemMessage: true,
        deepCopy: true,
      });

      // Verify the cloned agent has a copy of the history
      expect((clonedAgent as any).history).toEqual(originalHistory);

      // Modify the original history
      originalHistory[0].content = 'Modified';

      // Verify the cloned history is NOT affected (deep copy)
      expect((clonedAgent as any).history[0].content).toBe('Hello');

      // Verify they are different object references
      expect((clonedAgent as any).history).not.toBe(originalHistory);
      expect((clonedAgent as any).history[0]).not.toBe(originalHistory[0]);
    });

    it('should return undefined if source session does not exist', async () => {
      const clonedAgent = await registry.cloneSession('non-existent', 'cloned-session');
      expect(clonedAgent).toBeUndefined();
    });

    it('should register cloned session automatically', async () => {
      const sourceAgent = {
        answer: jest.fn(),
        history: [{ role: 'user', content: 'Test' }],
        options: { sessionId: 'source-session' },
        clone: jest.fn().mockReturnValue({
          answer: jest.fn(),
          history: [{ role: 'user', content: 'Test' }],
          options: { sessionId: 'cloned-session' },
        }),
      } as any;

      registry.registerSession('source-session', sourceAgent);

      await registry.cloneSession('source-session', 'cloned-session');

      expect(registry.hasSession('cloned-session')).toBe(true);
    });
  });
});
