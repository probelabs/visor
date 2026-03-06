import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { PRInfo } from '../../src/pr-analyzer';
import type { VisorConfig } from '../../src/types/config';

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
): Promise<Record<string, any[]>> {
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

describe('forEach with transform_js E2E Verification Tests', () => {
  it('should propagate individual forEach items by generating unique issues', async () => {
    const results = await runChecks(
      {
        'fetch-tickets': {
          type: 'command',
          exec: `echo '[{"key":"TT-101","priority":"high"},{"key":"TT-102","priority":"low"}]'`,
          transform_js: `JSON.parse(output)`,
          forEach: true,
        },
        'analyze-ticket': {
          type: 'command',
          depends_on: ['fetch-tickets'],
          exec: `echo '{"issues":[{"file":"{{ outputs["fetch-tickets"].key }}.js","line":1,"severity":"{{ outputs["fetch-tickets"].priority == "high" ? "error" : "warning" }}","message":"Issue in {{ outputs["fetch-tickets"].key }}","ruleId":"ticket-check"}]}'`,
        },
      },
      ['analyze-ticket']
    );

    // Verify the check ran successfully
    expect(results['analyze-ticket']).toBeDefined();
    expect(Array.isArray(results['analyze-ticket'])).toBe(true);
    expect(results['analyze-ticket'].length).toBeGreaterThan(0);

    const checkResult = results['analyze-ticket'][0];
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

  it('should handle nested object access in forEach items', async () => {
    const results = await runChecks(
      {
        'fetch-data': {
          type: 'command',
          exec: `echo '[{"id":1,"data":{"name":"Alpha","score":95}},{"id":2,"data":{"name":"Beta","score":75}}]'`,
          transform_js: `JSON.parse(output)`,
          forEach: true,
        },
        'validate-data': {
          type: 'command',
          depends_on: ['fetch-data'],
          exec: `echo '{"issues":[{"file":"{{ outputs["fetch-data"].data.name }}.js","line":{{ outputs["fetch-data"].id }},"severity":"{{ outputs["fetch-data"].data.score > 80 ? "info" : "warning" }}","message":"Score: {{ outputs["fetch-data"].data.score }}","ruleId":"score-check"}]}'`,
        },
      },
      ['validate-data']
    );

    const checkResult = results['validate-data']?.[0];
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

  it('should handle transform_js that flattens nested arrays', async () => {
    const results = await runChecks(
      {
        'fetch-groups': {
          type: 'command',
          exec: `echo '{"groups":[{"name":"A","items":[{"id":"a1"},{"id":"a2"}]},{"name":"B","items":[{"id":"b1"}]}]}'`,
          transform_js: [
            'const data = JSON.parse(output);',
            'const flat = [];',
            'data.groups.forEach(g => {',
            '  g.items.forEach(i => {',
            '    flat.push({ group: g.name, itemId: i.id });',
            '  });',
            '});',
            'flat',
          ].join('\n'),
          forEach: true,
        },
        'process-item': {
          type: 'command',
          depends_on: ['fetch-groups'],
          exec: `echo '{"issues":[{"file":"{{ outputs["fetch-groups"].group }}/{{ outputs["fetch-groups"].itemId }}.txt","line":1,"severity":"info","message":"Processing {{ outputs["fetch-groups"].itemId }} from group {{ outputs["fetch-groups"].group }}","ruleId":"item-check"}]}'`,
        },
      },
      ['process-item']
    );

    const issues = results['process-item']?.[0]?.issues || [];

    // Should have 3 issues (a1, a2, b1)
    expect(issues.length).toBe(3);

    // Verify each flattened item
    expect(issues.find((i: any) => i.file === 'A/a1.txt')).toBeDefined();
    expect(issues.find((i: any) => i.file === 'A/a2.txt')).toBeDefined();
    expect(issues.find((i: any) => i.file === 'B/b1.txt')).toBeDefined();
  });

  it('should handle empty array from transform_js', async () => {
    const results = await runChecks(
      {
        'fetch-empty': {
          type: 'command',
          exec: `echo '{"items":[]}'`,
          transform_js: `JSON.parse(output).items`,
          forEach: true,
        },
        'process-empty': {
          type: 'command',
          depends_on: ['fetch-empty'],
          exec: `echo '{"issues":[{"file":"test.js","line":1,"severity":"error","message":"Should not see this","ruleId":"empty-check"}]}'`,
        },
      },
      ['process-empty']
    );

    const checkResult = results['process-empty']?.[0];

    // Should have no issues since forEach had empty array
    expect(checkResult?.issues || []).toEqual([]);
  });

  it('should handle transform_js errors gracefully', async () => {
    const results = await runChecks(
      {
        'fetch-invalid': {
          type: 'command',
          exec: `echo '{"data":"test"}'`,
          transform_js: `JSON.parse(output).nonexistent.property`,
          forEach: true,
        },
        'process-invalid': {
          type: 'command',
          depends_on: ['fetch-invalid'],
          exec: `echo '{"issues":[{"file":"test.js","line":1,"severity":"error","message":"Should not run","ruleId":"invalid-check"}]}'`,
        },
      },
      ['process-invalid']
    );

    // Should report the transform_js error
    const allChecks = Object.values(results).flat() as any[];
    const fetchResult = allChecks.find((r: any) => r.checkName === 'fetch-invalid');
    expect(fetchResult).toBeDefined();
    expect(fetchResult.issues).toBeDefined();
    expect(fetchResult.issues.length).toBeGreaterThan(0);
    expect(fetchResult.issues[0].ruleId).toContain('transform_js_error');
  });

  it('should aggregate all issues from multiple forEach iterations', async () => {
    const results = await runChecks(
      {
        'fetch-files': {
          type: 'command',
          exec: `echo '[{"name":"file1.js","issues":2},{"name":"file2.js","issues":1},{"name":"file3.js","issues":0}]'`,
          transform_js: `JSON.parse(output)`,
          forEach: true,
        },
        'scan-file': {
          type: 'command',
          depends_on: ['fetch-files'],
          exec: [
            'if [ "{{ outputs["fetch-files"].issues }}" -gt 0 ]; then',
            '  issues="["',
            '  for i in $(seq 1 {{ outputs["fetch-files"].issues }}); do',
            '    [ "$i" -gt 1 ] && issues="$issues,"',
            '    issues="$issues{\\"file\\":\\"{{ outputs["fetch-files"].name }}\\",\\"line\\":$i,\\"severity\\":\\"warning\\",\\"message\\":\\"Issue $i in {{ outputs["fetch-files"].name }}\\",\\"ruleId\\":\\"scan\\"}"',
            '  done',
            '  issues="$issues]"',
            '  printf \'{"issues":%s}\' "$issues"',
            'else',
            '  echo \'{"issues":[]}\'',
            'fi',
          ].join('\n'),
        },
      },
      ['scan-file']
    );

    const issues = results['scan-file']?.[0]?.issues || [];

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
