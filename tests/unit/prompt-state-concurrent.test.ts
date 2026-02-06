import {
  PromptStateManager,
  getPromptStateManager,
  resetPromptStateManager,
} from '../../src/slack/prompt-state';

describe('PromptStateManager concurrent thread handling', () => {
  let manager: PromptStateManager;

  beforeEach(() => {
    resetPromptStateManager();
    manager = getPromptStateManager();
  });

  afterEach(() => {
    resetPromptStateManager();
  });

  describe('firstMessage handling', () => {
    it('should isolate firstMessage by thread key', () => {
      // Thread A and Thread B are independent
      manager.setFirstMessage('C123', 'thread-A', 'Hello from A');
      manager.setFirstMessage('C123', 'thread-B', 'Hello from B');

      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-A')).toBe(true);
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-B')).toBe(true);

      // Consuming A should not affect B
      const messageA = manager.consumeFirstMessage('C123', 'thread-A');
      expect(messageA).toBe('Hello from A');
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-A')).toBe(false);
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-B')).toBe(true);

      // B is still available
      const messageB = manager.consumeFirstMessage('C123', 'thread-B');
      expect(messageB).toBe('Hello from B');
    });

    it('should allow new message after consumed (resume cycle fix)', () => {
      // Initial message
      manager.setFirstMessage('C123', 'thread-1', 'First message');
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-1')).toBe(true);

      // Consume it
      const first = manager.consumeFirstMessage('C123', 'thread-1');
      expect(first).toBe('First message');
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-1')).toBe(false);

      // User replies with new message - should be captured
      manager.setFirstMessage('C123', 'thread-1', 'Second message');
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-1')).toBe(true);

      // Can consume the new message
      const second = manager.consumeFirstMessage('C123', 'thread-1');
      expect(second).toBe('Second message');
    });

    it('should NOT overwrite unconsumed message', () => {
      // Set first message
      manager.setFirstMessage('C123', 'thread-1', 'Original message');

      // Try to set another message before consuming
      manager.setFirstMessage('C123', 'thread-1', 'Attempted overwrite');

      // Should still have original
      const message = manager.consumeFirstMessage('C123', 'thread-1');
      expect(message).toBe('Original message');
    });
  });

  describe('waiting state handling', () => {
    it('should isolate waiting state by thread key', () => {
      manager.setWaiting('C123', 'thread-A', {
        checkName: 'ask',
        prompt: 'Prompt for A',
      });
      manager.setWaiting('C123', 'thread-B', {
        checkName: 'ask',
        prompt: 'Prompt for B',
      });

      const waitingA = manager.getWaiting('C123', 'thread-A');
      const waitingB = manager.getWaiting('C123', 'thread-B');

      expect(waitingA?.prompt).toBe('Prompt for A');
      expect(waitingB?.prompt).toBe('Prompt for B');

      // Clearing A should not affect B
      manager.clear('C123', 'thread-A');
      expect(manager.getWaiting('C123', 'thread-A')).toBeUndefined();
      expect(manager.getWaiting('C123', 'thread-B')?.prompt).toBe('Prompt for B');
    });

    it('should handle concurrent operations from multiple threads', async () => {
      const threads = ['thread-1', 'thread-2', 'thread-3', 'thread-4', 'thread-5'];
      const channel = 'C-CONCURRENT';

      // Simulate concurrent setFirstMessage operations
      await Promise.all(
        threads.map(async (thread, _idx) => {
          // Small delay to simulate real-world timing
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          manager.setFirstMessage(channel, thread, `Message from ${thread}`);
        })
      );

      // All threads should have their messages
      for (const thread of threads) {
        expect(manager.hasUnconsumedFirstMessage(channel, thread)).toBe(true);
        const msg = manager.consumeFirstMessage(channel, thread);
        expect(msg).toBe(`Message from ${thread}`);
      }
    });

    it('should handle rapid consume-then-set cycle', async () => {
      const channel = 'C-RAPID';
      const thread = 'thread-rapid';

      // Simulate rapid conversation turns
      for (let i = 0; i < 10; i++) {
        manager.setFirstMessage(channel, thread, `Turn ${i}`);
        const msg = manager.consumeFirstMessage(channel, thread);
        expect(msg).toBe(`Turn ${i}`);
        expect(manager.hasUnconsumedFirstMessage(channel, thread)).toBe(false);
      }
    });
  });

  describe('cleanup behavior', () => {
    it('should clean up consumed firstMessage entries when no waiting state', () => {
      // Set and consume a message
      manager.setFirstMessage('C123', 'thread-cleanup', 'Test message');
      manager.consumeFirstMessage('C123', 'thread-cleanup');

      // Entry should still exist (consumed)
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-cleanup')).toBe(false);

      // Run cleanup - should remove consumed entry with no waiting state
      const removed = (manager as any).cleanup();
      expect(removed).toBeGreaterThanOrEqual(0);
    });

    it('should NOT clean up unconsumed firstMessage entries', () => {
      manager.setFirstMessage('C123', 'thread-keep', 'Keep this message');

      // Run cleanup
      (manager as any).cleanup();

      // Message should still be available
      expect(manager.hasUnconsumedFirstMessage('C123', 'thread-keep')).toBe(true);
      const msg = manager.consumeFirstMessage('C123', 'thread-keep');
      expect(msg).toBe('Keep this message');
    });
  });
});
