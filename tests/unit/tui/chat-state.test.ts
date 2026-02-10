import {
  ChatStateManager,
  getChatStateManager,
  setChatStateManager,
  resetChatStateManager,
} from '../../../src/tui/chat-state';

describe('ChatStateManager', () => {
  let manager: ChatStateManager;

  beforeEach(() => {
    manager = new ChatStateManager({ maxMessages: 100 });
    resetChatStateManager();
  });

  describe('message management', () => {
    it('should add user messages', () => {
      const msg = manager.addMessage('user', 'Hello');
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello');
      expect(manager.history).toHaveLength(1);
    });

    it('should add assistant messages', () => {
      const msg = manager.addMessage('assistant', 'Hi there', 'check-1');
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Hi there');
      expect(msg.checkId).toBe('check-1');
    });

    it('should add system messages', () => {
      const msg = manager.addMessage('system', 'System notice');
      expect(msg.role).toBe('system');
    });

    it('should respect maxMessages limit', () => {
      const smallManager = new ChatStateManager({ maxMessages: 5 });
      for (let i = 0; i < 10; i++) {
        smallManager.addMessage('user', `Message ${i}`);
      }
      expect(smallManager.history).toHaveLength(5);
      expect(smallManager.history[0].content).toBe('Message 5');
    });

    it('should get recent messages', () => {
      for (let i = 0; i < 10; i++) {
        manager.addMessage('user', `Message ${i}`);
      }
      const recent = manager.getRecentMessages(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].content).toBe('Message 7');
    });

    it('should clear history', () => {
      manager.addMessage('user', 'Test');
      expect(manager.history).toHaveLength(1);
      manager.clearHistory();
      expect(manager.history).toHaveLength(0);
    });
  });

  describe('processing state', () => {
    it('should track processing state', () => {
      expect(manager.isProcessing).toBe(false);
      manager.setProcessing(true);
      expect(manager.isProcessing).toBe(true);
      expect(manager.statusText).toBe('Processing...');
      manager.setProcessing(false);
      expect(manager.isProcessing).toBe(false);
      expect(manager.statusText).toBe('Ready');
    });
  });

  describe('waiting state', () => {
    it('should track waiting state', () => {
      expect(manager.isWaiting).toBe(false);
      expect(manager.waitingState).toBeUndefined();

      manager.setWaiting({
        checkId: 'test-check',
        prompt: 'Enter input:',
      });

      expect(manager.isWaiting).toBe(true);
      expect(manager.waitingState?.checkId).toBe('test-check');
      expect(manager.statusText).toBe('Awaiting input...');

      manager.clearWaiting();
      expect(manager.isWaiting).toBe(false);
      expect(manager.statusText).toBe('Ready');
    });
  });

  describe('input queue', () => {
    it('should queue and dequeue input', () => {
      expect(manager.hasQueuedInput).toBe(false);
      manager.queueInput('first');
      manager.queueInput('second');
      expect(manager.hasQueuedInput).toBe(true);
      expect(manager.dequeueInput()).toBe('first');
      expect(manager.dequeueInput()).toBe('second');
      expect(manager.dequeueInput()).toBeUndefined();
      expect(manager.hasQueuedInput).toBe(false);
    });

    it('should clear queue', () => {
      manager.queueInput('test');
      expect(manager.hasQueuedInput).toBe(true);
      manager.clearQueue();
      expect(manager.hasQueuedInput).toBe(false);
    });
  });

  describe('formatting', () => {
    it('should format message for display', () => {
      const msg = manager.addMessage('user', 'Test message');
      const formatted = manager.formatMessageForDisplay(msg);
      expect(formatted).toContain('> You');
      expect(formatted).toContain('Test message');
    });

    it('should format history for display', () => {
      manager.addMessage('user', 'Hello');
      manager.addMessage('assistant', 'Hi there');
      const formatted = manager.formatHistoryForDisplay();
      expect(formatted).toContain('> You');
      expect(formatted).toContain('Assistant');
    });

    it('should show placeholder when history is empty', () => {
      const formatted = manager.formatHistoryForDisplay();
      expect(formatted).toContain('No messages yet');
    });
  });

  describe('global state manager', () => {
    it('should get and set global state manager', () => {
      const custom = new ChatStateManager();
      setChatStateManager(custom);
      expect(getChatStateManager()).toBe(custom);
    });

    it('should create default manager if not set', () => {
      resetChatStateManager();
      const defaultManager = getChatStateManager();
      expect(defaultManager).toBeInstanceOf(ChatStateManager);
    });
  });
});
