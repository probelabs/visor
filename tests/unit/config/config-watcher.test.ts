import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigWatcher, collectLocalConfigDeps } from '../../../src/config/config-watcher';
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

  test('handles reload rejection without crashing', async () => {
    mockReloader.reload.mockRejectedValue(new Error('boom'));
    const watcher = new ConfigWatcher(configPath, mockReloader, 50);
    watcher.start();

    // Trigger file change
    fs.writeFileSync(configPath, 'version: "2.0"\n', 'utf8');

    // Wait for debounce — should not throw unhandled rejection
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(mockReloader.reload).toHaveBeenCalled();
    watcher.stop();
  });

  test('start after stop cleans up previous listeners', () => {
    const watcher = new ConfigWatcher(configPath, mockReloader);
    watcher.start();
    watcher.start(); // Should stop previous watcher first, then start fresh
    watcher.stop();
  });

  test('watches dependency files (extends/include)', async () => {
    // Create a parent config that the main config extends
    const parentPath = path.join(tmpDir, 'parent.yaml');
    fs.writeFileSync(parentPath, 'version: "1.0"\nsteps:\n  base-check:\n    type: log\n', 'utf8');

    // Main config extends the parent
    fs.writeFileSync(configPath, `version: "1.0"\nextends: ./parent.yaml\n`, 'utf8');

    const watcher = new ConfigWatcher(configPath, mockReloader, 50);
    watcher.start();

    // Modify the PARENT file (not the main config)
    fs.writeFileSync(parentPath, 'version: "2.0"\nsteps:\n  base-check:\n    type: log\n', 'utf8');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(mockReloader.reload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  test('watches imported workflow/skill files', async () => {
    // Create a workflow (skill) file
    const skillPath = path.join(tmpDir, 'my-skill.yaml');
    fs.writeFileSync(skillPath, 'id: my-skill\nsteps:\n  run:\n    type: log\n', 'utf8');

    // Main config imports the skill
    fs.writeFileSync(configPath, `version: "1.0"\nimports:\n  - ./my-skill.yaml\n`, 'utf8');

    const watcher = new ConfigWatcher(configPath, mockReloader, 50);
    watcher.start();

    // Modify the SKILL file
    fs.writeFileSync(
      skillPath,
      'id: my-skill\nsteps:\n  run:\n    type: log\n    message: updated\n',
      'utf8'
    );

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(mockReloader.reload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  test('refreshes watches after successful reload', async () => {
    // Start with no dependencies
    fs.writeFileSync(configPath, 'version: "1.0"\n', 'utf8');

    const watcher = new ConfigWatcher(configPath, mockReloader, 50);
    watcher.start();

    // Now update config to add a dependency
    const depPath = path.join(tmpDir, 'dep.yaml');
    fs.writeFileSync(depPath, 'version: "1.0"\n', 'utf8');
    fs.writeFileSync(configPath, `version: "1.0"\nimports:\n  - ./dep.yaml\n`, 'utf8');

    // Wait for debounce + reload + refresh
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(mockReloader.reload).toHaveBeenCalledTimes(1);

    // Reset call count
    mockReloader.reload.mockClear();

    // Now modify the NEW dependency — should trigger reload
    fs.writeFileSync(depPath, 'version: "2.0"\n', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(mockReloader.reload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

describe('collectLocalConfigDeps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-deps-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty for simple config with no deps', () => {
    const configPath = path.join(tmpDir, 'simple.yaml');
    fs.writeFileSync(configPath, 'version: "1.0"\n', 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toEqual([]);
  });

  test('returns empty for non-existent file', () => {
    const deps = collectLocalConfigDeps('/nonexistent/config.yaml');
    expect(deps).toEqual([]);
  });

  test('collects extends dependencies', () => {
    const parentPath = path.join(tmpDir, 'parent.yaml');
    fs.writeFileSync(parentPath, 'version: "1.0"\n', 'utf8');

    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `extends: ./parent.yaml\n`, 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toContain(parentPath);
  });

  test('collects include dependencies (alias for extends)', () => {
    const parentPath = path.join(tmpDir, 'parent.yaml');
    fs.writeFileSync(parentPath, 'version: "1.0"\n', 'utf8');

    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `include: ./parent.yaml\n`, 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toContain(parentPath);
  });

  test('collects imports dependencies', () => {
    const skillPath = path.join(tmpDir, 'skill.yaml');
    fs.writeFileSync(skillPath, 'id: my-skill\n', 'utf8');

    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `imports:\n  - ./skill.yaml\n`, 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toContain(skillPath);
  });

  test('collects nested/transitive dependencies', () => {
    const grandparent = path.join(tmpDir, 'grandparent.yaml');
    fs.writeFileSync(grandparent, 'version: "1.0"\n', 'utf8');

    const parent = path.join(tmpDir, 'parent.yaml');
    fs.writeFileSync(parent, `extends: ./grandparent.yaml\n`, 'utf8');

    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `extends: ./parent.yaml\n`, 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toContain(parent);
    expect(deps).toContain(grandparent);
  });

  test('skips remote URLs', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      `extends:\n  - https://example.com/base.yaml\n  - ./local.yaml\n`,
      'utf8'
    );

    const localPath = path.join(tmpDir, 'local.yaml');
    fs.writeFileSync(localPath, 'version: "1.0"\n', 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toContain(localPath);
    expect(deps).not.toContainEqual(expect.stringContaining('https://'));
  });

  test('skips "default" extends source', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `extends: default\n`, 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toEqual([]);
  });

  test('handles circular references without infinite loop', () => {
    const a = path.join(tmpDir, 'a.yaml');
    const b = path.join(tmpDir, 'b.yaml');
    fs.writeFileSync(a, `imports:\n  - ./b.yaml\n`, 'utf8');
    fs.writeFileSync(b, `imports:\n  - ./a.yaml\n`, 'utf8');

    // Should not hang or throw
    const deps = collectLocalConfigDeps(a);
    expect(deps).toContain(b);
  });

  test('collects workflow config: references from checks', () => {
    const workflowPath = path.join(tmpDir, 'workflow.yaml');
    fs.writeFileSync(workflowPath, 'id: my-workflow\nsteps:\n  run:\n    type: log\n', 'utf8');

    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      `checks:\n  my-check:\n    type: workflow\n    config: ./workflow.yaml\n`,
      'utf8'
    );

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toContain(workflowPath);
  });

  test('collects imports from within workflow files', () => {
    const depSkill = path.join(tmpDir, 'dep-skill.yaml');
    fs.writeFileSync(depSkill, 'id: dep-skill\n', 'utf8');

    const skill = path.join(tmpDir, 'skill.yaml');
    fs.writeFileSync(skill, `id: main-skill\nimports:\n  - ./dep-skill.yaml\n`, 'utf8');

    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `imports:\n  - ./skill.yaml\n`, 'utf8');

    const deps = collectLocalConfigDeps(configPath);
    expect(deps).toContain(skill);
    expect(deps).toContain(depSkill);
  });
});
