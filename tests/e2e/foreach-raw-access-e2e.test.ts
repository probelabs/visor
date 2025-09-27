import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

describe('forEach raw array access E2E Tests', () => {
  let tempDir: string;
  let cliPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-'));
    cliPath = path.join(__dirname, '../../dist/cli-main.js');

    // Initialize git repository
    execSync('git init -q', { cwd: tempDir });
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
      echo "{
        \\"issues\\": [{
          \\"file\\": \\"item-$current_id.txt\\",
          \\"line\\": 1,
          \\"severity\\": \\"info\\",
          \\"message\\": \\"Processing $current_name (item $current_id of $total_count)\\",
          \\"ruleId\\": \\"raw-access-test\\"
        }]
      }"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    // Run the dependent check
    const result = execSync(`${cliPath} --check analyze-item --output json 2>/dev/null || true`, {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const checkResult = output.default?.[0];
    const issues = checkResult?.issues || [];

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

      echo "{
        \\"issues\\": [{
          \\"file\\": \\"{{ outputs['fetch-data'].id }}.txt\\",
          \\"line\\": {{ outputs['fetch-data'].value }},
          \\"severity\\": \\"$severity\\",
          \\"message\\": \\"$message\\",
          \\"ruleId\\": \\"compare-test\\"
        }]
      }"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execSync(`${cliPath} --check compare-item --output json 2>/dev/null || true`, {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const output = JSON.parse(result || '{}');
    const issues = output.default?.[0]?.issues || [];

    // Should have 3 issues
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
      echo "{
        \\"issues\\": [{
          \\"file\\": \\"{{ outputs['fetch-categories'].category }}.txt\\",
          \\"line\\": 1,
          \\"severity\\": \\"info\\",
          \\"message\\": \\"Category {{ outputs['fetch-categories'].category }} has {{ outputs['fetch-categories'].items }} items. Total categories: {{ outputs['fetch-categories-raw'] | size }}\\",
          \\"ruleId\\": \\"category-info\\"
        }]
      }"

output:
  pr_comment:
    format: markdown
    group_by: check
    collapse: false
`;

    fs.writeFileSync(path.join(tempDir, '.visor.yaml'), configContent);

    const result = execSync(
      `${cliPath} --check process-category --output json 2>/dev/null || true`,
      { cwd: tempDir, encoding: 'utf-8' }
    );

    const output = JSON.parse(result || '{}');
    const issues = output.default?.[0]?.issues || [];

    // Should have 2 issues
    expect(issues.length).toBe(2);

    // Both should mention total categories
    issues.forEach((issue: { message: string }) => {
      expect(issue.message).toContain('Total categories: 2');
    });
  });
});
