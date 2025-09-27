import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { PRInfo } from '../../src/pr-analyzer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('forEach with transform_js propagation fix', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should wrap forEach transformed items with output field for dependent checks', async () => {
    // Create a test config file
    const configContent = `
version: "1.0"
checks:
  fetch-data:
    type: command
    exec: echo '[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]'
    transform_js: JSON.parse(output)
    forEach: true

  process-data:
    type: command
    depends_on: [fetch-data]
    exec: echo "ITEM:{{ outputs['fetch-data'] | json }}"
output:
  pr_comment:
    comment_template: ""
`;

    const configPath = path.join(tempDir, '.visor.yaml');
    fs.writeFileSync(configPath, configContent);

    const prInfo: PRInfo = {
      number: 1,
      title: 'Test PR',
      body: 'Test',
      author: 'test',
      base: 'main',
      head: 'feature',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    // Mock execSync to capture command execution
    const originalExecSync = require('child_process').execSync;
    const executedCommands: string[] = [];

    require('child_process').execSync = jest.fn((cmd: string, options: any) => {
      executedCommands.push(cmd);

      if (cmd.includes('echo \'[{"id":1')) {
        return Buffer.from('[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]');
      }

      // For process-data commands, return the command itself to see what was rendered
      return Buffer.from(cmd);
    });

    try {
      const engine = new CheckExecutionEngine(tempDir);

      // Load config from file
      const { ConfigManager } = require('../../src/config');
      const configManager = new ConfigManager(tempDir);
      const config = await configManager.loadConfig(configPath);

      // Use executeChecks which properly sets the config
      const result = await engine.executeChecks({
        prInfo,
        config,
        checks: ['process-data'],
      });

      // Verify process-data was executed twice (once for each item)
      const processCommands = executedCommands.filter(cmd => cmd.includes('ITEM:'));
      expect(processCommands).toHaveLength(2);

      // Check that the items were properly passed to the dependent check
      // The items should be wrapped in an output field
      const firstCommand = processCommands[0];
      const secondCommand = processCommands[1];

      // The commands should contain the individual items
      expect(firstCommand).toContain('{"id":1,"name":"item1"}');
      expect(secondCommand).toContain('{"id":2,"name":"item2"}');

    } finally {
      require('child_process').execSync = originalExecSync;
    }
  });
});