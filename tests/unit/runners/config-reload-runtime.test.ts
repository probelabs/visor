import { setupRunnerConfigReloadRuntime } from '../../../src/runners/config-reload-runtime';

const reloadMock = jest.fn().mockResolvedValue(true);
const initializeMock = jest.fn().mockResolvedValue(undefined);
const shutdownMock = jest.fn().mockResolvedValue(undefined);
const watcherStartMock = jest.fn();
const watcherStopMock = jest.fn();

jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../../src/config/config-snapshot-store', () => ({
  ConfigSnapshotStore: jest.fn().mockImplementation(() => ({
    initialize: initializeMock,
    shutdown: shutdownMock,
  })),
}));

jest.mock('../../../src/config/config-reloader', () => ({
  ConfigReloader: jest.fn().mockImplementation(() => ({
    reload: reloadMock,
  })),
}));

jest.mock('../../../src/config/config-watcher', () => ({
  ConfigWatcher: jest.fn().mockImplementation(() => ({
    start: watcherStartMock,
    stop: watcherStopMock,
  })),
}));

describe('setupRunnerConfigReloadRuntime', () => {
  const mockLogger = jest.requireMock('../../../src/logger').logger as {
    info: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
    error: jest.Mock;
  };
  let processOnSpy: jest.SpyInstance;
  let processRemoveListenerSpy: jest.SpyInstance;
  let registeredUsr2Handler: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    registeredUsr2Handler = undefined;
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: () => void
    ) => {
      if (event === 'SIGUSR2') registeredUsr2Handler = handler;
      return process;
    }) as any);
    processRemoveListenerSpy = jest.spyOn(process, 'removeListener').mockImplementation(((
      event: string,
      handler: () => void
    ) => {
      if (event === 'SIGUSR2' && registeredUsr2Handler === handler) {
        registeredUsr2Handler = undefined;
      }
      return process;
    }) as any);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processRemoveListenerSpy.mockRestore();
  });

  it('registers SIGUSR2 reload handling without file watch mode', async () => {
    const runtime = await setupRunnerConfigReloadRuntime({
      configPath: '/tmp/test.visor.yaml',
      watch: false,
      configManager: {} as any,
      onSwap: jest.fn(),
    });

    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(watcherStartMock).not.toHaveBeenCalled();
    expect(registeredUsr2Handler).toEqual(expect.any(Function));

    registeredUsr2Handler?.();
    await Promise.resolve();

    expect(reloadMock).toHaveBeenCalledTimes(1);

    await runtime.cleanup();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
    expect(registeredUsr2Handler).toBeUndefined();
  });

  it('starts file watching without registering a duplicate SIGUSR2 handler in watch mode', async () => {
    const runtime = await setupRunnerConfigReloadRuntime({
      configPath: '/tmp/test.visor.yaml',
      watch: true,
      configManager: {} as any,
      onSwap: jest.fn(),
    });

    expect(watcherStartMock).toHaveBeenCalledWith({ listenForSignals: false });
    expect(registeredUsr2Handler).toEqual(expect.any(Function));

    await runtime.cleanup();
    expect(watcherStopMock).toHaveBeenCalledTimes(1);
  });

  it('installs a non-fatal SIGUSR2 handler even without a config path', async () => {
    const runtime = await setupRunnerConfigReloadRuntime({
      configPath: undefined,
      watch: false,
      configManager: {} as any,
      onSwap: jest.fn(),
    });

    expect(initializeMock).not.toHaveBeenCalled();
    expect(registeredUsr2Handler).toEqual(expect.any(Function));

    expect(() => registeredUsr2Handler?.()).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[ConfigReload] Ignoring SIGUSR2: no --config path configured'
    );

    await runtime.cleanup();
  });
});
