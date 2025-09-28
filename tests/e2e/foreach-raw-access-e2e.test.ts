import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync, execSync } from 'child_process';

describe('forEach raw array access E2E Tests', () => {
  let tempDir: string;
  let cliCommand: string;
  let cliArgsPrefix: string[];

  // Helper function to execute CLI with clean environment
  const execCLI = (args: string[], options: any = {}): string => {
    // Clear Jest environment variables so the CLI runs properly
    const cleanEnv = { ...process.env };
    delete cleanEnv.JEST_WORKER_ID;
    delete cleanEnv.NODE_ENV;
    delete cleanEnv.GITHUB_ACTIONS;

    // Merge options with clean environment
    const finalOptions = {
      ...options,
      env: cleanEnv,
    };

    const cliArgs = ['--cli', ...args];
    try {
      const result = execFileSync(cliCommand, [...cliArgsPrefix, ...cliArgs], {
        ...finalOptions,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'stdout' in error) {
        const stdout = (error as { stdout?: Buffer | string }).stdout;
        if (stdout) {
          return Buffer.isBuffer(stdout) ? stdout.toString('utf-8') : stdout;
        }
      }
      throw error;
    }
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-'));
    const distCli = path.join(__dirname, '../../dist/index.js');
    if (fs.existsSync(distCli)) {
      cliCommand = 'node';
      cliArgsPrefix = [distCli];
    } else {
      // Resolve ts-node/register from repo root so child cwd doesn't break resolution
      const tsNodeRegister = require.resolve('ts-node/register', {
        paths: [path.resolve(__dirname, '../../')],
      });
      cliCommand = 'node';
      cliArgsPrefix = ['-r', tsNodeRegister, path.join(__dirname, '../../src/index.ts')];
    }

    // Initialize git repository
    execSync('git init -q', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'test');
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -q -m "initial"', { cwd: tempDir });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should provide access to full array via <checkName>-raw key', () => {
    // Create config that uses both individual item and raw array access
    const configContent = `
version: "1.0"
checks:
  fetch-items:
    type: command
    exec: |
      echo '[{"id":1,"name":"Alpha"},{"id":2,"name":"Beta"},{"id":3,"name":"Gamma"}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  analyze-item:
    type: command
    depends_on: [fetch-items]
    exec: |
      # Access current item
      current_id="{{ outputs['fetch-items'].id }}"
      current_name="{{ outputs['fetch-items'].name }}"

      # Access full array via -raw key
      total_count="{{ outputs['fetch-items-raw'] | size }}"

      # Generate issue that includes both individual and aggregate information
      printf '{"issues":[{"file":"item-%s.txt","line":1,"severity":"info","message":"Processing %s (item %s of %s)","ruleId":"raw-access-test"}]}' \
        "$current_id" \
        "$current_name" \
        "$current_id" \
        "$total_count"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    // Run the dependent check
    const result = execCLI(['--check', 'analyze-item', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const checkResult = output.default?.[0];
    const issues = checkResult?.issues || [];

    if (issues.length !== 3) {
      process.stderr.write(`DEBUG analyze-item raw result: ${result}\n`);
    }

    // Should have 3 issues, one for each item
    expect(issues.length).toBe(3);

    // Each issue should show the correct total count from raw array access
    const alphaIssue = issues.find((i: { file: string }) => i.file === 'item-1.txt');
    expect(alphaIssue).toBeDefined();
    expect(alphaIssue.message).toContain('Alpha');
    expect(alphaIssue.message).toContain('item 1 of 3');

    const betaIssue = issues.find((i: { file: string }) => i.file === 'item-2.txt');
    expect(betaIssue).toBeDefined();
    expect(betaIssue.message).toContain('Beta');
    expect(betaIssue.message).toContain('item 2 of 3');

    const gammaIssue = issues.find((i: { file: string }) => i.file === 'item-3.txt');
    expect(gammaIssue).toBeDefined();
    expect(gammaIssue.message).toContain('Gamma');
    expect(gammaIssue.message).toContain('item 3 of 3');
  });

  it('should allow accessing specific items from raw array', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-data:
    type: command
    exec: |
      echo '[{"id":"a","value":10},{"id":"b","value":20},{"id":"c","value":30}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  compare-item:
    type: command
    depends_on: [fetch-data]
    exec: |
      # Access current item
      current_value="{{ outputs['fetch-data'].value }}"

      # Access first item from raw array
      first_value="{{ outputs['fetch-data-raw'][0].value }}"

      # Calculate difference
      if [ "$current_value" -gt "$first_value" ]; then
        severity="warning"
        message="Value $current_value is higher than baseline $first_value"
      else
        severity="info"
        message="Value $current_value is at or below baseline $first_value"
      fi

      printf '{"issues":[{"file":"%s.txt","line":%s,"severity":"%s","message":"%s","ruleId":"compare-test"}]}' \
        "{{ outputs['fetch-data'].id }}" \
        "{{ outputs['fetch-data'].value }}" \
        "$severity" \
        "$message"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(['--check', 'compare-item', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const issues = output.default?.[0]?.issues || [];

    // Should have 3 issues
    if (issues.length !== 3) {
      process.stderr.write(`DEBUG compare-item result: ${result}\n`);
    }
    expect(issues.length).toBe(3);

    // First item should be at baseline (info)
    const issueA = issues.find((i: { file: string }) => i.file === 'a.txt');
    expect(issueA).toBeDefined();
    expect(issueA.severity).toBe('info');
    expect(issueA.message).toContain('at or below baseline');

    // Second and third items should be above baseline (warning)
    const issueB = issues.find((i: { file: string }) => i.file === 'b.txt');
    expect(issueB).toBeDefined();
    expect(issueB.severity).toBe('warning');
    expect(issueB.message).toContain('higher than baseline');

    const issueC = issues.find((i: { file: string }) => i.file === 'c.txt');
    expect(issueC).toBeDefined();
    expect(issueC.severity).toBe('warning');
    expect(issueC.message).toContain('higher than baseline');
  });

  it('should auto-parse JSON when transform_js returns output.tickets (no explicit parse)', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-data:
    type: command
    exec: |
      echo '{"tickets":[{"id":"a","value":10},{"id":"b","value":20},{"id":"c","value":30}]}'
    transform_js: |
      output.tickets
    forEach: true

  compare-item:
    type: command
    depends_on: [fetch-data]
    exec: |
      # Access current item and baseline through -raw
      current_value="{{ outputs['fetch-data'].value }}"
      first_value="{{ outputs['fetch-data-raw'][0].value }}"
      if [ "$current_value" -gt "$first_value" ]; then
        echo "DIFF:up"
      else
        echo "DIFF:base"
      fi

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(['--check', 'compare-item', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const checkResult = output.default?.[0] || {};
    const content = checkResult.content || '';
    expect(typeof content).toBe('string');
    expect(content).toContain('DIFF:base');
    expect(content).toContain('DIFF:up');
  });

  it('should handle raw array access with nested forEach dependencies', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-categories:
    type: command
    exec: |
      echo '[{"category":"A","items":2},{"category":"B","items":1}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  process-category:
    type: command
    depends_on: [fetch-categories]
    exec: |
      # Can access both current category and all categories
      printf '{"issues":[{"file":"%s.txt","line":1,"severity":"info","message":"Category %s has %s items. Total categories: %s","ruleId":"category-info"}]}' \
        "{{ outputs['fetch-categories'].category }}" \
        "{{ outputs['fetch-categories'].category }}" \
        "{{ outputs['fetch-categories'].items }}" \
        "{{ outputs['fetch-categories-raw'] | size }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(['--check', 'process-category', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const issues = output.default?.[0]?.issues || [];

    // Should have 2 issues
    if (issues.length !== 2) {
      process.stderr.write(`DEBUG process-category result: ${result}\n`);
    }
    expect(issues.length).toBe(2);

    // Both should mention total categories
    issues.forEach((issue: { message: string }) => {
      expect(issue.message).toContain('Total categories: 2');
    });
  });
});
