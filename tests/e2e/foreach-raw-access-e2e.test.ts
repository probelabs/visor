import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { PRInfo } from '../../src/pr-analyzer';
import type { VisorConfig } from '../../src/types/config';
import type { CheckResult } from '../../src/reviewer';

const prInfo: PRInfo = {
  number: 1,
  title: 'Test PR',
  author: 'test-user',
  base: 'main',
  head: 'test-branch',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as any;

async function runChecks(
  checks: Record<string, any>,
  checksToRun: string[]
): Promise<Record<string, CheckResult[]>> {
  const config: VisorConfig = {
    version: '1.0',
    checks,
    output: {
      pr_comment: {
        enabled: false,
        format: 'markdown',
        group_by: 'check',
        collapse: false,
      },
    },
  } as any;

  const engine = new StateMachineExecutionEngine();
  const result = await engine.executeGroupedChecks(
    prInfo,
    checksToRun,
    30000,
    config,
    'json',
    false
  );
  return result.results;
}

describe('forEach raw array access E2E Tests', () => {
  it('should provide access to full array via <checkName>-raw key', async () => {
    const output = await runChecks(
      {
        'fetch-items': {
          type: 'command',
          exec: `echo '[{"id":1,"name":"Alpha"},{"id":2,"name":"Beta"},{"id":3,"name":"Gamma"}]'`,
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'analyze-item': {
          type: 'command',
          depends_on: ['fetch-items'],
          exec: [
            '# Access current item',
            'current_id="{{ outputs[\'fetch-items\'].id }}"',
            'current_name="{{ outputs[\'fetch-items\'].name }}"',
            '',
            '# Access full array via -raw key',
            'total_count="{{ outputs[\'fetch-items-raw\'] | size }}"',
            '',
            '# Generate issue that includes both individual and aggregate information',
            'printf \'{"issues":[{"file":"item-%s.txt","line":1,"severity":"info","message":"Processing %s (item %s of %s)","ruleId":"raw-access-test"}]}\' \\',
            '  "$current_id" \\',
            '  "$current_name" \\',
            '  "$current_id" \\',
            '  "$total_count"',
          ].join('\n'),
        },
      },
      ['analyze-item']
    );

    const checkResult = output['analyze-item']?.[0];
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

  it('should allow accessing specific items from raw array', async () => {
    const output = await runChecks(
      {
        'fetch-data': {
          type: 'command',
          exec: `echo '[{"id":"a","value":10},{"id":"b","value":20},{"id":"c","value":30}]'`,
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'compare-item': {
          type: 'command',
          depends_on: ['fetch-data'],
          exec: [
            '# Access current item',
            'current_value="{{ outputs[\'fetch-data\'].value }}"',
            '',
            '# Access first item from raw array',
            'first_value="{{ outputs[\'fetch-data-raw\'][0].value }}"',
            '',
            '# Calculate difference',
            'if [ "$current_value" -gt "$first_value" ]; then',
            '  severity="warning"',
            '  message="Value $current_value is higher than baseline $first_value"',
            'else',
            '  severity="info"',
            '  message="Value $current_value is at or below baseline $first_value"',
            'fi',
            '',
            'printf \'{"issues":[{"file":"%s.txt","line":%s,"severity":"%s","message":"%s","ruleId":"compare-test"}]}\' \\',
            '  "{{ outputs[\'fetch-data\'].id }}" \\',
            '  "{{ outputs[\'fetch-data\'].value }}" \\',
            '  "$severity" \\',
            '  "$message"',
          ].join('\n'),
        },
      },
      ['compare-item']
    );

    const issues = output['compare-item']?.[0]?.issues || [];

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

  it('should auto-parse JSON when transform_js returns output.tickets (no explicit parse)', async () => {
    const output = await runChecks(
      {
        'fetch-data': {
          type: 'command',
          exec: `echo '{"tickets":[{"id":"a","value":10},{"id":"b","value":20},{"id":"c","value":30}]}'`,
          transform_js: 'output.tickets',
          forEach: true,
        },
        'compare-item': {
          type: 'command',
          depends_on: ['fetch-data'],
          exec: [
            '# Access current item and baseline through -raw',
            'current_value="{{ outputs[\'fetch-data\'].value }}"',
            'first_value="{{ outputs[\'fetch-data-raw\'][0].value }}"',
            'if [ "$current_value" -gt "$first_value" ]; then',
            '  echo "DIFF:up"',
            'else',
            '  echo "DIFF:base"',
            'fi',
          ].join('\n'),
        },
      },
      ['compare-item']
    );

    const checkResult = output['compare-item']?.[0] || {};
    const content = checkResult.content || '';
    expect(typeof content).toBe('string');
    expect(content).toContain('DIFF:base');
    expect(content).toContain('DIFF:up');
  });

  it('should handle raw array access with nested forEach dependencies', async () => {
    const output = await runChecks(
      {
        'fetch-categories': {
          type: 'command',
          exec: `echo '[{"category":"A","items":2},{"category":"B","items":1}]'`,
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'process-category': {
          type: 'command',
          depends_on: ['fetch-categories'],
          exec: [
            'printf \'{"issues":[{"file":"%s.txt","line":1,"severity":"info","message":"Category %s has %s items. Total categories: %s","ruleId":"category-info"}]}\' \\',
            '  "{{ outputs[\'fetch-categories\'].category }}" \\',
            '  "{{ outputs[\'fetch-categories\'].category }}" \\',
            '  "{{ outputs[\'fetch-categories\'].items }}" \\',
            '  "{{ outputs[\'fetch-categories-raw\'] | size }}"',
          ].join('\n'),
        },
      },
      ['process-category']
    );

    const issues = output['process-category']?.[0]?.issues || [];

    // Should have 2 issues
    expect(issues.length).toBe(2);

    // Both should mention total categories
    issues.forEach((issue: { message: string }) => {
      expect(issue.message).toContain('Total categories: 2');
    });
  });
});
