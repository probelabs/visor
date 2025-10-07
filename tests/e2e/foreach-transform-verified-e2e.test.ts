import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, execFileSync } from 'child_process';

describe('forEach with transform_js E2E Verification Tests', () => {
  let tempDir: string;
  let cliCommand: string;
  let cliArgsPrefix: string[];

  // Helper function to execute CLI with clean environment
  const execCLI = (args: string[], options: any = {}): string => {
    // Clear Jest and Git environment variables so the CLI runs properly and
    // cannot be affected by the parent repository's hook environment
    const cleanEnv = { ...process.env } as NodeJS.ProcessEnv;
    delete cleanEnv.JEST_WORKER_ID;
    delete cleanEnv.NODE_ENV;
    delete cleanEnv.GITHUB_ACTIONS;
    delete cleanEnv.GIT_DIR;
    delete cleanEnv.GIT_WORK_TREE;
    delete cleanEnv.GIT_INDEX_FILE;
    delete cleanEnv.GIT_PREFIX;
    delete cleanEnv.GIT_COMMON_DIR;

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
      cliCommand = 'node';
      cliArgsPrefix = ['-r', 'ts-node/register', path.join(__dirname, '../../src/index.ts')];
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

  it('should propagate individual forEach items by generating unique issues', () => {
    // Create config that generates trackable issues
    const configContent = `
version: "1.0"
checks:
  fetch-tickets:
    type: command
    exec: |
      echo '[{"key":"TT-101","priority":"high"},{"key":"TT-102","priority":"low"}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  analyze-ticket:
    type: command
    depends_on: [fetch-tickets]
    exec: |
      echo '{"issues":[{"file":"{{ outputs["fetch-tickets"].key }}.js","line":1,"severity":"{{ outputs["fetch-tickets"].priority == "high" ? "error" : "warning" }}","message":"Issue in {{ outputs["fetch-tickets"].key }}","ruleId":"ticket-check"}]}'

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    // Run the dependent check
    const result = execCLI(['--check', 'analyze-ticket', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');

    // Verify the check ran successfully
    expect(output.default).toBeDefined();
    expect(Array.isArray(output.default)).toBe(true);
    expect(output.default.length).toBeGreaterThan(0);

    const checkResult = output.default[0];
    expect(checkResult.checkName).toBe('analyze-ticket');

    // Verify we got issues from both forEach iterations
    expect(checkResult.issues).toBeDefined();
    expect(Array.isArray(checkResult.issues)).toBe(true);

    // Should have 2 issues, one for each ticket
    const issues = checkResult.issues;
    expect(issues.length).toBe(2);

    // Check for TT-101 issue (high priority -> error)
    const issue101 = issues.find((i: any) => i.file === 'TT-101.js');
    expect(issue101).toBeDefined();
    expect(issue101.severity).toBe('error');
    expect(issue101.message).toContain('TT-101');

    // Check for TT-102 issue (low priority -> warning)
    const issue102 = issues.find((i: any) => i.file === 'TT-102.js');
    expect(issue102).toBeDefined();
    expect(issue102.severity).toBe('warning');
    expect(issue102.message).toContain('TT-102');
  });

  it('should handle nested object access in forEach items', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-data:
    type: command
    exec: |
      echo '[{"id":1,"data":{"name":"Alpha","score":95}},{"id":2,"data":{"name":"Beta","score":75}}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  validate-data:
    type: command
    depends_on: [fetch-data]
    exec: |
      echo '{"issues":[{"file":"{{ outputs["fetch-data"].data.name }}.js","line":{{ outputs["fetch-data"].id }},"severity":"{{ outputs["fetch-data"].data.score > 80 ? "info" : "warning" }}","message":"Score: {{ outputs["fetch-data"].data.score }}","ruleId":"score-check"}]}'

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(['--check', 'validate-data', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const checkResult = output.default?.[0];
    const issues = checkResult?.issues || [];

    // Should have 2 issues
    expect(issues.length).toBe(2);

    // Check Alpha issue (score 95 > 80 -> info)
    const alphaIssue = issues.find((i: any) => i.file === 'Alpha.js');
    expect(alphaIssue).toBeDefined();
    expect(alphaIssue.line).toBe(1);
    expect(alphaIssue.severity).toBe('info');
    expect(alphaIssue.message).toContain('95');

    // Check Beta issue (score 75 < 80 -> warning)
    const betaIssue = issues.find((i: any) => i.file === 'Beta.js');
    expect(betaIssue).toBeDefined();
    expect(betaIssue.line).toBe(2);
    expect(betaIssue.severity).toBe('warning');
    expect(betaIssue.message).toContain('75');
  });

  it('should handle transform_js that flattens nested arrays', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-groups:
    type: command
    exec: |
      echo '{"groups":[{"name":"A","items":[{"id":"a1"},{"id":"a2"}]},{"name":"B","items":[{"id":"b1"}]}]}'
    transform_js: |
      const data = JSON.parse(output);
      const flat = [];
      data.groups.forEach(g => {
        g.items.forEach(i => {
          flat.push({ group: g.name, itemId: i.id });
        });
      });
      flat
    forEach: true

  process-item:
    type: command
    depends_on: [fetch-groups]
    exec: |
      echo '{"issues":[{"file":"{{ outputs["fetch-groups"].group }}/{{ outputs["fetch-groups"].itemId }}.txt","line":1,"severity":"info","message":"Processing {{ outputs["fetch-groups"].itemId }} from group {{ outputs["fetch-groups"].group }}","ruleId":"item-check"}]}'

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(['--check', 'process-item', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const issues = output.default?.[0]?.issues || [];

    // Should have 3 issues (a1, a2, b1)
    expect(issues.length).toBe(3);

    // Verify each flattened item
    expect(issues.find((i: any) => i.file === 'A/a1.txt')).toBeDefined();
    expect(issues.find((i: any) => i.file === 'A/a2.txt')).toBeDefined();
    expect(issues.find((i: any) => i.file === 'B/b1.txt')).toBeDefined();
  });

  it('should handle empty array from transform_js', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-empty:
    type: command
    exec: |
      echo '{"items":[]}'
    transform_js: |
      JSON.parse(output).items
    forEach: true

  process-empty:
    type: command
    depends_on: [fetch-empty]
    exec: |
      echo '{"issues":[{"file":"test.js","line":1,"severity":"error","message":"Should not see this","ruleId":"empty-check"}]}'

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(['--check', 'process-empty', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const checkResult = output.default?.[0];

    // Should have no issues since forEach had empty array
    expect(checkResult?.issues || []).toEqual([]);
  });

  it('should handle transform_js errors gracefully', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-invalid:
    type: command
    exec: |
      echo '{"data":"test"}'
    transform_js: |
      JSON.parse(output).nonexistent.property
    forEach: true

  process-invalid:
    type: command
    depends_on: [fetch-invalid]
    exec: |
      echo '{"issues":[{"file":"test.js","line":1,"severity":"error","message":"Should not run","ruleId":"invalid-check"}]}'

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(['--check', 'process-invalid', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');

    // Should report the transform_js error
    const fetchResult = output.default?.find((r: any) => r.checkName === 'fetch-invalid');
    expect(fetchResult).toBeDefined();
    expect(fetchResult.issues).toBeDefined();
    expect(fetchResult.issues.length).toBeGreaterThan(0);
    expect(fetchResult.issues[0].ruleId).toContain('transform_js_error');
  });

  it('should aggregate all issues from multiple forEach iterations', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-files:
    type: command
    exec: |
      echo '[{"name":"file1.js","issues":2},{"name":"file2.js","issues":1},{"name":"file3.js","issues":0}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  scan-file:
    type: command
    depends_on: [fetch-files]
    exec: |
      if [ "{{ outputs["fetch-files"].issues }}" -gt 0 ]; then
        issues="["
        for i in $(seq 1 {{ outputs["fetch-files"].issues }}); do
          [ "$i" -gt 1 ] && issues="$issues,"
          issues="$issues{\\"file\\":\\"{{ outputs["fetch-files"].name }}\\",\\"line\\":$i,\\"severity\\":\\"warning\\",\\"message\\":\\"Issue $i in {{ outputs["fetch-files"].name }}\\",\\"ruleId\\":\\"scan\\"}"
        done
        issues="$issues]"
        printf '{"issues":%s}' "$issues"
      else
        echo '{"issues":[]}'
      fi

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);
    const result = execCLI(['--check', 'scan-file', '--output', 'json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const issues = output.default?.[0]?.issues || [];

    // Should have 3 total issues (2 from file1.js, 1 from file2.js, 0 from file3.js)
    expect(issues.length).toBe(3);

    // Verify distribution
    const file1Issues = issues.filter((i: any) => i.file === 'file1.js');
    const file2Issues = issues.filter((i: any) => i.file === 'file2.js');
    const file3Issues = issues.filter((i: any) => i.file === 'file3.js');

    expect(file1Issues.length).toBe(2);
    expect(file2Issues.length).toBe(1);
    expect(file3Issues.length).toBe(0);
  });
});
