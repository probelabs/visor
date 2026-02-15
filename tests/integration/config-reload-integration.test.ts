/**
 * Integration test for the full config reload pipeline:
 *   file change → watcher detects → reloader loads (real ConfigManager) → onSwap fires
 *
 * Uses real filesystem, real YAML parsing, real config validation.
 * Only the snapshot store is stubbed (avoids SQLite native dep in CI).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigWatcher } from '../../src/config/config-watcher';
import { ConfigReloader } from '../../src/config/config-reloader';
import { ConfigManager } from '../../src/config';
import type { VisorConfig } from '../../src/types/config';

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

// Use the real execSync for git init (global setup mocks spawn but not execSync)
const realExecSync = (jest.requireActual('child_process') as typeof import('child_process'))
  .execSync;

describe('Config Reload Integration', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let mockStore: any;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-reload-integ-'));

    // Init a git repo in tmpDir so ConfigLoader's path traversal check
    // uses tmpDir as the project root (it calls `git rev-parse --show-toplevel`).
    realExecSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    configManager = new ConfigManager();

    // Stub the snapshot store (avoids needing better-sqlite3 native addon)
    mockStore = {
      save: jest.fn().mockResolvedValue({ id: 1 }),
      initialize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('full pipeline: file edit → watcher → reloader → onSwap with new config', async () => {
    const configPath = path.join(tmpDir, '.visor.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: "1.0"',
        'checks:',
        '  hello:',
        '    type: log',
        '    message: "original"',
        '',
      ].join('\n'),
      'utf8'
    );

    let swappedConfig: VisorConfig | null = null;

    const reloader = new ConfigReloader({
      configPath,
      configManager,
      snapshotStore: mockStore,
      onSwap: cfg => {
        swappedConfig = cfg;
      },
    });

    const watcher = new ConfigWatcher(configPath, reloader, 50);
    watcher.start();

    try {
      // Edit the config file
      fs.writeFileSync(
        configPath,
        [
          'version: "1.0"',
          'checks:',
          '  hello:',
          '    type: log',
          '    message: "updated"',
          '  new-check:',
          '    type: log',
          '    message: "added"',
          '',
        ].join('\n'),
        'utf8'
      );

      // Wait for debounce + async reload
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(swappedConfig).not.toBeNull();
      // The new check should be present
      expect(swappedConfig!.checks).toHaveProperty('new-check');
      expect((swappedConfig!.checks as any)['hello'].message).toBe('updated');
    } finally {
      watcher.stop();
    }
  });

  test('nested dependency change: editing an extended file triggers reload', async () => {
    // Create parent config
    const parentPath = path.join(tmpDir, 'base.yaml');
    fs.writeFileSync(
      parentPath,
      [
        'version: "1.0"',
        'checks:',
        '  base-check:',
        '    type: log',
        '    message: "from base"',
        '',
      ].join('\n'),
      'utf8'
    );

    // Main config extends the parent
    const configPath = path.join(tmpDir, '.visor.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: "1.0"',
        'extends: ./base.yaml',
        'checks:',
        '  own-check:',
        '    type: log',
        '',
      ].join('\n'),
      'utf8'
    );

    let swappedConfig: VisorConfig | null = null;

    const reloader = new ConfigReloader({
      configPath,
      configManager,
      snapshotStore: mockStore,
      onSwap: cfg => {
        swappedConfig = cfg;
      },
    });

    const watcher = new ConfigWatcher(configPath, reloader, 50);
    watcher.start();

    try {
      // Modify the PARENT — not the main config
      fs.writeFileSync(
        parentPath,
        [
          'version: "1.0"',
          'checks:',
          '  base-check:',
          '    type: log',
          '    message: "updated base"',
          '  extra-base:',
          '    type: log',
          '',
        ].join('\n'),
        'utf8'
      );

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(swappedConfig).not.toBeNull();
      // Should have both the base checks and the child check
      expect(swappedConfig!.checks).toHaveProperty('base-check');
      expect(swappedConfig!.checks).toHaveProperty('extra-base');
      expect(swappedConfig!.checks).toHaveProperty('own-check');
    } finally {
      watcher.stop();
    }
  });

  test('imported workflow/skill change triggers reload', async () => {
    // Create a skill file
    const skillPath = path.join(tmpDir, 'my-skill.yaml');
    fs.writeFileSync(
      skillPath,
      [
        'id: my-skill',
        'name: My Skill',
        'steps:',
        '  greet:',
        '    type: log',
        '    message: "hello from skill"',
        '',
      ].join('\n'),
      'utf8'
    );

    // Main config imports the skill
    const configPath = path.join(tmpDir, '.visor.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: "1.0"',
        'imports:',
        '  - ./my-skill.yaml',
        'checks:',
        '  main-check:',
        '    type: log',
        '',
      ].join('\n'),
      'utf8'
    );

    let swapCount = 0;

    const reloader = new ConfigReloader({
      configPath,
      configManager,
      snapshotStore: mockStore,
      onSwap: () => {
        swapCount++;
      },
    });

    const watcher = new ConfigWatcher(configPath, reloader, 50);
    watcher.start();

    try {
      // Modify the SKILL file — not the main config
      fs.writeFileSync(
        skillPath,
        [
          'id: my-skill',
          'name: My Skill',
          'steps:',
          '  greet:',
          '    type: log',
          '    message: "updated skill"',
          '  farewell:',
          '    type: log',
          '    message: "bye"',
          '',
        ].join('\n'),
        'utf8'
      );

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(swapCount).toBe(1);
    } finally {
      watcher.stop();
    }
  });

  test('invalid config change: reload fails, onSwap not called', async () => {
    const configPath = path.join(tmpDir, '.visor.yaml');
    fs.writeFileSync(configPath, 'version: "1.0"\nchecks:\n  ok:\n    type: log\n', 'utf8');

    let swapCalled = false;
    let errorCalled = false;

    const reloader = new ConfigReloader({
      configPath,
      configManager,
      snapshotStore: mockStore,
      onSwap: () => {
        swapCalled = true;
      },
      onError: () => {
        errorCalled = true;
      },
    });

    const watcher = new ConfigWatcher(configPath, reloader, 50);
    watcher.start();

    try {
      // Write invalid YAML
      fs.writeFileSync(configPath, '{{{{invalid yaml!!!!', 'utf8');

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(swapCalled).toBe(false);
      expect(errorCalled).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  test('dynamically added dependency is watched after reload', async () => {
    const configPath = path.join(tmpDir, '.visor.yaml');
    // Start with no dependencies
    fs.writeFileSync(configPath, 'version: "1.0"\nchecks:\n  a:\n    type: log\n', 'utf8');

    let swapCount = 0;
    let latestConfig: VisorConfig | null = null;

    const reloader = new ConfigReloader({
      configPath,
      configManager,
      snapshotStore: mockStore,
      onSwap: cfg => {
        swapCount++;
        latestConfig = cfg;
      },
    });

    const watcher = new ConfigWatcher(configPath, reloader, 50);
    watcher.start();

    try {
      // Phase 1: Add a parent config file and update main to extend it
      const parentPath = path.join(tmpDir, 'parent.yaml');
      fs.writeFileSync(
        parentPath,
        'version: "1.0"\nchecks:\n  from-parent:\n    type: log\n',
        'utf8'
      );
      fs.writeFileSync(
        configPath,
        'version: "1.0"\nextends: ./parent.yaml\nchecks:\n  a:\n    type: log\n',
        'utf8'
      );

      // Wait for first reload to complete (this triggers refreshWatches)
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(swapCount).toBe(1);
      expect(latestConfig!.checks).toHaveProperty('from-parent');

      // Phase 2: Now modify the parent (which was NOT watched before Phase 1)
      fs.writeFileSync(
        parentPath,
        'version: "1.0"\nchecks:\n  from-parent:\n    type: log\n  bonus:\n    type: log\n',
        'utf8'
      );

      await new Promise(resolve => setTimeout(resolve, 500));
      expect(swapCount).toBe(2);
      expect(latestConfig!.checks).toHaveProperty('bonus');
    } finally {
      watcher.stop();
    }
  });

  test('runner.updateConfig propagates new config to future requests', async () => {
    // This tests that the onSwap callback pattern correctly updates the runner.
    // We simulate the pattern from cli-main.ts without starting a real WebSocket.
    const configPath = path.join(tmpDir, '.visor.yaml');
    fs.writeFileSync(configPath, 'version: "1.0"\nchecks:\n  original:\n    type: log\n', 'utf8');

    // Simulate the runner object (lightweight stand-in — no real WS needed)
    let runnerCfg: VisorConfig = {
      version: '1.0',
      checks: { original: { type: 'log' } },
    } as VisorConfig;

    const fakeRunner = {
      updateConfig(cfg: VisorConfig) {
        runnerCfg = cfg;
      },
    };

    const reloader = new ConfigReloader({
      configPath,
      configManager,
      snapshotStore: mockStore,
      onSwap: newConfig => {
        fakeRunner.updateConfig(newConfig);
      },
    });

    const watcher = new ConfigWatcher(configPath, reloader, 50);
    watcher.start();

    try {
      // Edit config
      fs.writeFileSync(configPath, 'version: "1.0"\nchecks:\n  replaced:\n    type: log\n', 'utf8');

      await new Promise(resolve => setTimeout(resolve, 500));

      // The "runner" should now have the new config
      expect(runnerCfg.checks).toHaveProperty('replaced');
      expect(runnerCfg.checks).not.toHaveProperty('original');
    } finally {
      watcher.stop();
    }
  });

  test('transitive dependency chain: grandparent change triggers reload', async () => {
    // grandparent.yaml ← parent.yaml ← config.yaml
    const grandparentPath = path.join(tmpDir, 'grandparent.yaml');
    fs.writeFileSync(
      grandparentPath,
      'version: "1.0"\nchecks:\n  gp-check:\n    type: log\n',
      'utf8'
    );

    const parentPath = path.join(tmpDir, 'parent.yaml');
    fs.writeFileSync(parentPath, 'extends: ./grandparent.yaml\n', 'utf8');

    const configPath = path.join(tmpDir, '.visor.yaml');
    fs.writeFileSync(
      configPath,
      'version: "1.0"\nextends: ./parent.yaml\nchecks:\n  leaf:\n    type: log\n',
      'utf8'
    );

    let swappedConfig: VisorConfig | null = null;

    const reloader = new ConfigReloader({
      configPath,
      configManager,
      snapshotStore: mockStore,
      onSwap: cfg => {
        swappedConfig = cfg;
      },
    });

    const watcher = new ConfigWatcher(configPath, reloader, 50);
    watcher.start();

    try {
      // Modify the GRANDPARENT — two levels up
      fs.writeFileSync(
        grandparentPath,
        'version: "1.0"\nchecks:\n  gp-check:\n    type: log\n  gp-new:\n    type: log\n',
        'utf8'
      );

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(swappedConfig).not.toBeNull();
      expect(swappedConfig!.checks).toHaveProperty('gp-new');
      expect(swappedConfig!.checks).toHaveProperty('leaf');
    } finally {
      watcher.stop();
    }
  });
});
