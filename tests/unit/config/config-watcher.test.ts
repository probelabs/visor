import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigWatcher } from '../../../src/config/config-watcher';
import { ConfigReloader } from '../../../src/config/config-reloader';

jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe('ConfigWatcher', () => {
  let tmpDir: string;
  let configPath: string;
  let mockReloader: jest.Mocked<ConfigReloader>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-watcher-test-'));
    configPath = path.join(tmpDir, 'test.visor.yaml');
    fs.writeFileSync(configPath, 'version: "1.0"\n', 'utf8');

    mockReloader = {
      reload: jest.fn().mockResolvedValue(true),
    } as any;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('start and stop without errors', () => {
    const watcher = new ConfigWatcher(configPath, mockReloader);
    watcher.start();
    watcher.stop();
  });

  test('stop is idempotent', () => {
    const watcher = new ConfigWatcher(configPath, mockReloader);
    watcher.start();
    watcher.stop();
    watcher.stop(); // Should not throw
  });

  test('debounces file changes', async () => {
    const watcher = new ConfigWatcher(configPath, mockReloader, 50);
    watcher.start();

    // Trigger file change
    fs.writeFileSync(configPath, 'version: "2.0"\n', 'utf8');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(mockReloader.reload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  test('coalesces rapid file changes via debouncing', async () => {
    const watcher = new ConfigWatcher(configPath, mockReloader, 100);
    watcher.start();

    // Rapid-fire writes (editor save behavior)
    fs.writeFileSync(configPath, 'version: "2.0"\n', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 20));
    fs.writeFileSync(configPath, 'version: "3.0"\n', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 20));
    fs.writeFileSync(configPath, 'version: "4.0"\n', 'utf8');

    // Wait for debounce to fire
    await new Promise(resolve => setTimeout(resolve, 250));

    // Should have only reloaded once due to debouncing
    expect(mockReloader.reload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  test('handles non-existent file gracefully', () => {
    const watcher = new ConfigWatcher('/nonexistent/path.yaml', mockReloader);
    // Should not throw
    watcher.start();
    watcher.stop();
  });
});
