import { TuiManager } from '../../src/tui';

describe('TuiManager console capture', () => {
  it('restores console methods after capture', () => {
    const manager = new TuiManager();
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };

    const restore = manager.captureConsole();

    expect(console.log).not.toBe(original.log);
    expect(() => console.log('hello from tui test')).not.toThrow();

    restore();

    expect(console.log).toBe(original.log);
    expect(console.error).toBe(original.error);
    expect(console.warn).toBe(original.warn);
    expect(console.info).toBe(original.info);

    manager.stop();
  });
});
