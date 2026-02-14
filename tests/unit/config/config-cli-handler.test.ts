import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleConfigCommand } from '../../../src/config/cli-handler';
import { ConfigSnapshotStore } from '../../../src/config/config-snapshot-store';

jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
  configureLoggerFromCli: jest.fn(),
}));

describe('Config CLI Handler', () => {
  let tmpDir: string;
  let store: ConfigSnapshotStore;
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-cli-test-'));

    // Set up the DB so the handler finds it in the expected location
    // We need to override the default .visor/config.db path by changing cwd
    const visorDir = path.join(tmpDir, '.visor');
    fs.mkdirSync(visorDir, { recursive: true });

    store = new ConfigSnapshotStore(path.join(visorDir, 'config.db'));
    await store.initialize();

    // Seed some snapshots
    await store.save({
      created_at: '2026-01-01T00:00:00Z',
      trigger: 'startup',
      config_hash: 'aabbccdd11223344',
      config_yaml: 'version: "1.0"\nchecks: {}\n',
      source_path: '/test/config.yaml',
    });
    await store.save({
      created_at: '2026-01-02T00:00:00Z',
      trigger: 'reload',
      config_hash: 'eeff00112233aabb',
      config_yaml: 'version: "2.0"\nchecks:\n  test:\n    type: log\n',
      source_path: '/test/config.yaml',
    });
    await store.shutdown();

    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: temporarily change cwd to tmpDir so ConfigSnapshotStore finds .visor/config.db
  async function runInTmpDir(argv: string[]): Promise<void> {
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await handleConfigCommand(argv);
    } finally {
      process.chdir(origCwd);
    }
  }

  test('snapshots lists all snapshots', async () => {
    await runInTmpDir(['snapshots']);
    const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(output).toContain('aabbccdd11223344');
    expect(output).toContain('eeff00112233aabb');
    expect(output).toContain('startup');
    expect(output).toContain('reload');
  });

  test('show prints YAML for a specific snapshot', async () => {
    await runInTmpDir(['show', '1']);
    const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(output).toContain('version: "1.0"');
  });

  test('show with invalid id prints error', async () => {
    await runInTmpDir(['show', 'abc']);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid snapshot ID'));
  });

  test('show with non-existent id prints error', async () => {
    await runInTmpDir(['show', '999']);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  test('diff shows differences between two snapshots', async () => {
    await runInTmpDir(['diff', '1', '2']);
    const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    // Should show some diff output (either unified diff or fallback)
    expect(output.length).toBeGreaterThan(0);
  });

  test('diff with missing arguments prints error', async () => {
    await runInTmpDir(['diff', '1']);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  test('restore writes YAML to output file', async () => {
    const outputPath = path.join(tmpDir, 'restored.yaml');
    await runInTmpDir(['restore', '1', '--output', outputPath]);

    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('version: "1.0"');
  });

  test('restore without --output prints error', async () => {
    await runInTmpDir(['restore', '1']);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--output'));
  });

  test('help is the default subcommand', async () => {
    await runInTmpDir([]);
    const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(output).toContain('Visor Config');
    expect(output).toContain('COMMANDS');
  });
});
