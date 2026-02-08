import { ChatTUI } from '../../src/tui/chat-tui';

describe('ChatTUI console capture', () => {
  it('restores console methods after capture', () => {
    const chatTui = new ChatTUI();
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };

    // Need to start TUI before capturing console
    chatTui.start();
    const restore = chatTui.captureConsole();

    expect(console.log).not.toBe(original.log);
    expect(() => console.log('hello from tui test')).not.toThrow();

    restore();

    expect(console.log).toBe(original.log);
    expect(console.error).toBe(original.error);
    expect(console.warn).toBe(original.warn);
    expect(console.info).toBe(original.info);

    chatTui.stop();
  });
});
