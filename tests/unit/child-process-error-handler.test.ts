/**
 * Tests for the global child-process I/O error handler.
 *
 * The handler suppresses transient EIO / EPIPE errors that originate from
 * broken child-process stdio pipes so the visor process doesn't crash.
 */

// Helper to emit uncaughtException without TS overload complaints
function emitUncaughtException(err: Error): void {
  (process as any).emit('uncaughtException', err, 'uncaughtException');
}

describe('child-process-error-handler', () => {
  let originalListeners: NodeJS.UncaughtExceptionListener[];

  beforeAll(() => {
    // Capture pre-existing uncaughtException listeners so we can restore later
    originalListeners = process.listeners(
      'uncaughtException'
    ) as NodeJS.UncaughtExceptionListener[];
  });

  afterAll(() => {
    // Remove any listeners our import added and restore originals
    process.removeAllListeners('uncaughtException');
    for (const fn of originalListeners) {
      process.on('uncaughtException', fn);
    }
  });

  beforeEach(() => {
    // Clear the guard so the module re-registers on each test
    delete (globalThis as any)[Symbol.for('visor.childProcessErrorHandler')];
  });

  it('should register an uncaughtException listener', () => {
    const before = process.listenerCount('uncaughtException');
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });
    const after = process.listenerCount('uncaughtException');
    expect(after).toBeGreaterThan(before);
  });

  it('should suppress EIO errors without crashing', () => {
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });

    const err = Object.assign(new Error('read EIO'), { code: 'EIO' });
    expect(() => emitUncaughtException(err)).not.toThrow();
  });

  it('should suppress EPIPE errors without crashing', () => {
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });

    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => emitUncaughtException(err)).not.toThrow();
  });

  it('should suppress ECONNRESET errors without crashing', () => {
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });

    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => emitUncaughtException(err)).not.toThrow();
  });

  it('should suppress ERR_STREAM_DESTROYED errors without crashing', () => {
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });

    const err = new Error('ERR_STREAM_DESTROYED');
    expect(() => emitUncaughtException(err)).not.toThrow();
  });

  it('should NOT suppress unrelated errors', () => {
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });

    const err = new Error('Something completely different');
    expect(() => emitUncaughtException(err)).not.toThrow();
  });

  it('should only register once even when imported twice', () => {
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });
    const afterFirst = process.listenerCount('uncaughtException');
    jest.isolateModules(() => {
      require('../../src/utils/child-process-error-handler');
    });
    const afterSecond = process.listenerCount('uncaughtException');
    expect(afterSecond).toBe(afterFirst);
  });
});
