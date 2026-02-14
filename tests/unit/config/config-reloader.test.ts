import { ConfigReloader } from '../../../src/config/config-reloader';
import { ConfigSnapshotStore } from '../../../src/config/config-snapshot-store';
import { ConfigManager } from '../../../src/config';
import type { VisorConfig } from '../../../src/types/config';

jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe('ConfigReloader', () => {
  let mockConfigManager: jest.Mocked<ConfigManager>;
  let mockStore: jest.Mocked<ConfigSnapshotStore>;
  let onSwap: jest.Mock;
  let onError: jest.Mock;

  const fakeConfig: VisorConfig = {
    version: '1.0',
    checks: {},
    steps: {},
  } as VisorConfig;

  beforeEach(() => {
    mockConfigManager = {
      loadConfig: jest.fn().mockResolvedValue(fakeConfig),
    } as any;

    mockStore = {
      save: jest.fn().mockResolvedValue({ id: 1 }),
      initialize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as any;

    onSwap = jest.fn();
    onError = jest.fn();
  });

  test('reload succeeds: loads config, saves snapshot, calls onSwap', async () => {
    const reloader = new ConfigReloader({
      configPath: '/test/config.yaml',
      configManager: mockConfigManager,
      snapshotStore: mockStore,
      onSwap,
      onError,
    });

    const result = await reloader.reload();

    expect(result).toBe(true);
    expect(mockConfigManager.loadConfig).toHaveBeenCalledWith('/test/config.yaml');
    expect(mockStore.save).toHaveBeenCalledTimes(1);
    const savedSnapshot = mockStore.save.mock.calls[0][0];
    expect(savedSnapshot.trigger).toBe('reload');
    expect(savedSnapshot.source_path).toBe('/test/config.yaml');
    expect(onSwap).toHaveBeenCalledWith(fakeConfig);
    expect(onError).not.toHaveBeenCalled();
  });

  test('reload fails on loadConfig error: calls onError, returns false', async () => {
    mockConfigManager.loadConfig.mockRejectedValue(new Error('Parse error'));

    const reloader = new ConfigReloader({
      configPath: '/test/config.yaml',
      configManager: mockConfigManager,
      snapshotStore: mockStore,
      onSwap,
      onError,
    });

    const result = await reloader.reload();

    expect(result).toBe(false);
    expect(onSwap).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe('Parse error');
  });

  test('snapshot save failure does not block config swap', async () => {
    mockStore.save.mockRejectedValue(new Error('DB write failed'));

    const reloader = new ConfigReloader({
      configPath: '/test/config.yaml',
      configManager: mockConfigManager,
      snapshotStore: mockStore,
      onSwap,
      onError,
    });

    const result = await reloader.reload();

    // Snapshot failure is best-effort — config should still be swapped
    expect(result).toBe(true);
    expect(onSwap).toHaveBeenCalledWith(fakeConfig);
    expect(onError).not.toHaveBeenCalled();
  });

  test('reload without onError handler does not throw', async () => {
    mockConfigManager.loadConfig.mockRejectedValue(new Error('fail'));

    const reloader = new ConfigReloader({
      configPath: '/test/config.yaml',
      configManager: mockConfigManager,
      snapshotStore: mockStore,
      onSwap,
      // No onError
    });

    // Should not throw
    const result = await reloader.reload();
    expect(result).toBe(false);
  });
});
