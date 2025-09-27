import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('forEach transform_js dependency propagation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should wrap forEach items with output field when using transform_js', async () => {
    // Create test config file
    const configContent = `
version: "1.0"
checks:
  fetch-data:
    type: command
    exec: echo '[{"id":1},{"id":2}]'
    transform_js: JSON.parse(output)
    forEach: true

  process-data:
    type: command
    depends_on: [fetch-data]
    exec: echo "Processing:{{ outputs['fetch-data'] | json }}"

output:
  pr_comment:
    comment_template: ""
`;

    const configPath = path.join(tempDir, '.visor.yaml');
    fs.writeFileSync(configPath, configContent);

    // Create dummy git repo
    require('child_process').execSync('git init', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'test');
    require('child_process').execSync('git add .', { cwd: tempDir });
    require('child_process').execSync('git commit -m "test"', { cwd: tempDir });

    // Mock execSync to capture commands
    const originalExecSync = require('child_process').execSync;
    const executedCommands: string[] = [];

    require('child_process').execSync = jest.fn((cmd: string, options: any) => {
      // Allow git commands to execute normally
      if (cmd.startsWith('git')) {
        return originalExecSync(cmd, options);
      }

      executedCommands.push(cmd);

      // Return test data for fetch-data
      if (cmd.includes('[{"id":1')) {
        return Buffer.from('[{"id":1},{"id":2}]');
      }

      // Return the command for inspection
      return Buffer.from(cmd);
    });

    try {
      // Use the CLI directly
      const { CheckExecutionEngine } = require('../../src/check-execution-engine');
      const { ConfigManager } = require('../../src/config');

      const configManager = new ConfigManager(tempDir);
      const config = await configManager.loadConfig(configPath);

      const engine = new CheckExecutionEngine(tempDir);
      const result = await engine.executeChecks({
        checks: ['process-data'],
        config,
        workingDirectory: tempDir,
      });

      // Debug: log all executed commands
      console.log('Executed commands:', executedCommands);

      // Should have executed process-data twice
      const processCommands = executedCommands.filter(cmd => cmd.includes('Processing:') || cmd.includes('echo'));
      expect(processCommands).toHaveLength(2);

      // Each command should have individual item
      expect(processCommands[0]).toContain('{"id":1}');
      expect(processCommands[1]).toContain('{"id":2}');

    } finally {
      require('child_process').execSync = originalExecSync;
    }
  });
});