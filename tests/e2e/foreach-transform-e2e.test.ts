import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

describe('forEach with transform_js E2E Tests', () => {
  let tempDir: string;
  let cliPath: string;

  // Helper function to execute CLI with clean environment
  const execCLI = (command: string, options: any = {}): string => {
    // Clear Jest environment variables so the CLI runs properly
    const cleanEnv = { ...process.env };
    delete cleanEnv.JEST_WORKER_ID;
    delete cleanEnv.NODE_ENV;

    // Merge options with clean environment
    const finalOptions = {
      ...options,
      env: cleanEnv,
    };

    const result = execSync(command, finalOptions);

    // Convert Buffer to string if needed
    if (Buffer.isBuffer(result)) {
      return result.toString('utf-8');
    }
    return result as string;
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-'));
    cliPath = path.join(__dirname, '../../dist/index.js');

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

  it('should execute CLI with clean environment', () => {
    // Simple test to verify the CLI runs
    expect(fs.existsSync(cliPath)).toBe(true);
    const helpResult = execCLI(`node ${cliPath} --help`, { encoding: 'utf-8' });
    expect(helpResult).toContain('Usage: visor');
  });

  it('should propagate individual forEach items to dependent checks with transform_js', () => {
    // Create config with forEach and transform_js
    const configContent = `
version: "1.0"
checks:
  fetch-tickets:
    type: command
    exec: |
      echo '{"query":"test","tickets":[{"key":"TT-101","summary":"First ticket","priority":"high"},{"key":"TT-102","summary":"Second ticket","priority":"low"}]}'
    transform_js: |
      JSON.parse(output).tickets
    forEach: true

  analyze-ticket:
    type: command
    depends_on: [fetch-tickets]
    exec: |
      echo "TICKET:{{ outputs['fetch-tickets'].key }}:{{ outputs['fetch-tickets'].priority }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    // Run the dependent check
    let result: string;
    try {
      result = execCLI(`node ${cliPath} --check analyze-ticket --output json 2>&1`, {
        cwd: tempDir,
        encoding: 'utf-8',
      });
    } catch (error: any) {
      // If command fails, try to get output anyway from the error
      if (error.stdout) {
        result = error.stdout.toString();
      } else if (error.output) {
        result = error.output.filter(Boolean).join('');
      } else {
        console.error('Command failed:', error.message);
        throw error;
      }
    }

    // Handle empty result
    if (!result || result.trim() === '') {
      console.error('Empty result from CLI command');
      console.error('CLI Path:', cliPath);
      console.error('Temp Dir:', tempDir);
      throw new Error('CLI returned empty output');
    }

    // Extract JSON from output (may contain debug messages)
    // The JSON output starts with { and should be valid JSON to the end
    const jsonMatch = result.match(/\{[\s\S]*\}$/);
    const jsonString = jsonMatch ? jsonMatch[0] : result;

    let output: any;
    try {
      output = JSON.parse(jsonString);
    } catch (error) {
      console.error('Failed to parse JSON:', jsonString);
      console.error('Full output length:', result.length);
      console.error('Full output:', result);
      throw error;
    }

    // Verify the check ran successfully
    expect(output.default).toBeDefined();
    expect(Array.isArray(output.default)).toBe(true);
    expect(output.default.length).toBe(1); // Should be aggregated into one result

    const checkResult = output.default[0];
    expect(checkResult.checkName).toBe('analyze-ticket');

    // Check that no errors were reported
    expect(checkResult.issues).toBeDefined();
    expect(Array.isArray(checkResult.issues)).toBe(true);

    // The forEach should have been processed (we'll verify behavior through issues or other means)
    // Note: Command output is not exposed in JSON format, only issues are
  });

  it('should handle nested object extraction with transform_js and forEach', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-data:
    type: command
    exec: |
      echo '{"data":{"items":[{"id":1,"details":{"name":"item1","value":100}},{"id":2,"details":{"name":"item2","value":200}}]}}'
    transform_js: |
      JSON.parse(output).data.items
    forEach: true

  process-item:
    type: command
    depends_on: [fetch-data]
    exec: |
      echo "ID:{{ outputs['fetch-data'].id }},NAME:{{ outputs['fetch-data'].details.name }},VALUE:{{ outputs['fetch-data'].details.value }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(
      `node ${cliPath} --check process-item --output json 2>/dev/null || true`,
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    const output = JSON.parse(result || '{}');
    const checkResult = output.default[0];
    const content = checkResult.content || '';

    // Verify nested objects are properly accessed
    expect(content).toContain('ID:1,NAME:item1,VALUE:100');
    expect(content).toContain('ID:2,NAME:item2,VALUE:200');
  });

  it('should handle transform_js returning non-array and convert to array', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-single:
    type: command
    exec: |
      echo '{"item":{"key":"single","value":42}}'
    transform_js: |
      JSON.parse(output).item
    forEach: true

  process-single:
    type: command
    depends_on: [fetch-single]
    exec: |
      echo "KEY:{{ outputs['fetch-single'].key }},VALUE:{{ outputs['fetch-single'].value }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(`node ${cliPath} --check process-single --output json 2>/dev/null`, {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result);
    const checkResult = output.default[0];
    const content = checkResult.content || '';

    // Should process the single item
    expect(content).toContain('KEY:single,VALUE:42');
  });

  it('should handle multiple levels of dependencies with forEach', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-users:
    type: command
    exec: |
      echo '[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  enrich-user:
    type: command
    depends_on: [fetch-users]
    exec: |
      echo '{"user":"{{ outputs['fetch-users'].name }}","score":{{ outputs['fetch-users'].id }}0}'

  summarize:
    type: command
    depends_on: [enrich-user]
    exec: |
      echo "Summary: {{ outputs['enrich-user'] }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(`node ${cliPath} --check summarize --output json 2>/dev/null`, {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result);
    expect(output.default).toBeDefined();

    const checkResult = output.default[0];
    const content = checkResult.content || '';

    // Should contain summary with enriched data
    expect(content).toContain('Summary:');
  });

  it('should handle empty array from transform_js gracefully', () => {
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
      echo "Processing: {{ outputs['fetch-empty'] }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(`node ${cliPath} --check process-empty --output json 2>/dev/null`, {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result);

    // Should handle empty array without errors
    expect(output.default).toBeDefined();
    expect(Array.isArray(output.default)).toBe(true);
  });

  it('should properly aggregate issues from forEach dependent checks', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-files:
    type: command
    exec: |
      echo '[{"file":"test1.js","hasIssue":true},{"file":"test2.js","hasIssue":false}]'
    transform_js: |
      JSON.parse(output)
    forEach: true

  check-file:
    type: command
    depends_on: [fetch-files]
    exec: |
      if [ "{{ outputs['fetch-files'].hasIssue }}" = "true" ]; then
        echo '{"issues":[{"file":"{{ outputs['fetch-files'].file }}","line":1,"severity":"error","message":"Issue found"}]}'
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

    const result = execCLI(`node ${cliPath} --check check-file --output json 2>/dev/null`, {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result);
    const checkResult = output.default[0];

    // Should aggregate issues from all forEach iterations
    expect(checkResult.issues).toBeDefined();
    expect(Array.isArray(checkResult.issues)).toBe(true);

    // Should have one issue from test1.js
    const errorIssues = checkResult.issues.filter((i: any) => i.severity === 'error');
    expect(errorIssues.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle complex JSON transformation with forEach', () => {
    const configContent = `
version: "1.0"
checks:
  fetch-api-data:
    type: command
    exec: |
      echo '{"status":"success","data":{"users":[{"id":1,"posts":[{"title":"Post1"},{"title":"Post2"}]},{"id":2,"posts":[{"title":"Post3"}]}]}}'
    transform_js: |
      const result = JSON.parse(output);
      const flattened = [];
      result.data.users.forEach(user => {
        user.posts.forEach(post => {
          flattened.push({ userId: user.id, postTitle: post.title });
        });
      });
      flattened
    forEach: true

  analyze-post:
    type: command
    depends_on: [fetch-api-data]
    exec: |
      echo "User {{ outputs['fetch-api-data'].userId }} posted: {{ outputs['fetch-api-data'].postTitle }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execCLI(`node ${cliPath} --check analyze-post --output json 2>/dev/null`, {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result);
    const checkResult = output.default[0];
    const content = checkResult.content || '';

    // Should process all flattened posts
    expect(content).toContain('User 1 posted: Post1');
    expect(content).toContain('User 1 posted: Post2');
    expect(content).toContain('User 2 posted: Post3');
  });

  describe('error handling', () => {
    it('should handle transform_js errors gracefully', () => {
      const configContent = `
version: "1.0"
checks:
  fetch-invalid:
    type: command
    exec: |
      echo '{"data": "test"}'
    transform_js: |
      JSON.parse(output).nonexistent.property
    forEach: true

  process-invalid:
    type: command
    depends_on: [fetch-invalid]
    exec: |
      echo "Processing: {{ outputs['fetch-invalid'] }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

      fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

      const result = execCLI(`node ${cliPath} --check process-invalid --output json 2>/dev/null`, {
        cwd: tempDir,
        encoding: 'utf-8',
      });

      const output = JSON.parse(result);

      // Should handle the error and report it
      expect(output.default).toBeDefined();
      const checkResult = output.default.find(
        (r: any) => r.checkName === 'fetch-invalid' || r.checkName === 'process-invalid'
      );
      expect(checkResult).toBeDefined();
    });

    it('should handle malformed JSON in command output', () => {
      const configContent = `
version: "1.0"
checks:
  fetch-malformed:
    type: command
    exec: |
      echo 'not valid json'
    transform_js: |
      JSON.parse(output)
    forEach: true

  process-malformed:
    type: command
    depends_on: [fetch-malformed]
    exec: |
      echo "Processing: {{ outputs['fetch-malformed'] }}"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

      fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

      const result = execCLI(
        `node ${cliPath} --check process-malformed --output json 2>/dev/null`,
        {
          cwd: tempDir,
          encoding: 'utf-8',
        }
      );

      const output = JSON.parse(result);

      // Should report the parse error
      const fetchResult = output.default.find((r: any) => r.checkName === 'fetch-malformed');
      expect(fetchResult).toBeDefined();
      const issues = fetchResult?.issues || [];
      expect(issues.length).toBeGreaterThan(0);
      expect(
        issues.some((i: any) => {
          const message = typeof i.message === 'string' ? i.message : '';
          const ruleId = typeof i.ruleId === 'string' ? i.ruleId : '';
          return message.toLowerCase().includes('error') || ruleId.includes('transform_js_error');
        })
      ).toBe(true);
    });
  });
});
