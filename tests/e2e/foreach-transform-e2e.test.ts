import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { PRInfo } from '../../src/pr-analyzer';
import type { VisorConfig } from '../../src/types/config';

// Minimal PRInfo for in-process engine execution
const minimalPRInfo: PRInfo = {
  number: 1,
  title: 'Test PR',
  body: '',
  author: 'test',
  base: 'main',
  head: 'test-branch',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

// Helper to run checks in-process and return grouped results
async function runChecks(
  checks: Record<string, any>,
  checksToRun: string[]
): Promise<Record<string, any>> {
  const config: VisorConfig = {
    version: '1.0',
    checks,
    output: {
      pr_comment: { enabled: false, format: 'markdown', group_by: 'check', collapse: false },
    },
  } as any;

  const engine = new StateMachineExecutionEngine();
  const result = await engine.executeGroupedChecks(
    minimalPRInfo,
    checksToRun,
    30000,
    config,
    'json',
    false
  );
  return result.results;
}

describe('forEach with transform_js E2E Tests', () => {
  it('should propagate individual forEach items to dependent checks with transform_js', async () => {
    const results = await runChecks(
      {
        'fetch-tickets': {
          type: 'command',
          exec: `echo '{"query":"test","tickets":[{"key":"TT-101","summary":"First ticket","priority":"high"},{"key":"TT-102","summary":"Second ticket","priority":"low"}]}'`,
          transform_js: 'JSON.parse(output).tickets',
          forEach: true,
        },
        'analyze-ticket': {
          type: 'command',
          depends_on: ['fetch-tickets'],
          exec: `echo "TICKET:{{ outputs['fetch-tickets'].key }}:{{ outputs['fetch-tickets'].priority }}"`,
        },
      },
      ['analyze-ticket']
    );

    expect(results['analyze-ticket']).toBeDefined();
    expect(Array.isArray(results['analyze-ticket'])).toBe(true);
    expect(results['analyze-ticket'].length).toBe(1);

    const checkResult = results['analyze-ticket'][0];
    expect(checkResult.checkName).toBe('analyze-ticket');
    expect(checkResult.issues).toBeDefined();
    expect(Array.isArray(checkResult.issues)).toBe(true);
  });

  it('should support transform_js using output.tickets without explicit JSON.parse', async () => {
    const results = await runChecks(
      {
        'fetch-tickets': {
          type: 'command',
          exec: `echo '{"query":"test","tickets":[{"key":"TT-101","priority":"high"},{"key":"TT-102","priority":"low"}]}'`,
          transform_js: 'output.tickets',
          forEach: true,
        },
        'analyze-ticket': {
          type: 'command',
          depends_on: ['fetch-tickets'],
          exec: `echo "TICKET:{{ outputs['fetch-tickets'].key }}:{{ outputs['fetch-tickets'].priority }}"`,
        },
      },
      ['analyze-ticket']
    );

    const checkResult = results['analyze-ticket'][0];
    const content = checkResult.content || '';

    expect(content).toContain('TICKET:TT-101:high');
    expect(content).toContain('TICKET:TT-102:low');
  });

  it('should handle nested object extraction with transform_js and forEach', async () => {
    const results = await runChecks(
      {
        'fetch-data': {
          type: 'command',
          exec: `echo '{"data":{"items":[{"id":1,"details":{"name":"item1","value":100}},{"id":2,"details":{"name":"item2","value":200}}]}}'`,
          transform_js: 'JSON.parse(output).data.items',
          forEach: true,
        },
        'process-item': {
          type: 'command',
          depends_on: ['fetch-data'],
          exec: `echo "ID:{{ outputs['fetch-data'].id }},NAME:{{ outputs['fetch-data'].details.name }},VALUE:{{ outputs['fetch-data'].details.value }}"`,
        },
      },
      ['process-item']
    );

    const checkResult = results['process-item'][0];
    const content = checkResult.content || '';

    expect(content).toContain('ID:1,NAME:item1,VALUE:100');
    expect(content).toContain('ID:2,NAME:item2,VALUE:200');
  });

  it('should handle transform_js returning non-array and convert to array', async () => {
    const results = await runChecks(
      {
        'fetch-single': {
          type: 'command',
          exec: `echo '{"item":{"key":"single","value":42}}'`,
          transform_js: 'JSON.parse(output).item',
          forEach: true,
        },
        'process-single': {
          type: 'command',
          depends_on: ['fetch-single'],
          exec: `echo "KEY:{{ outputs['fetch-single'].key }},VALUE:{{ outputs['fetch-single'].value }}"`,
        },
      },
      ['process-single']
    );

    const checkResult = results['process-single'][0];
    const content = checkResult.content || '';

    expect(content).toContain('KEY:single,VALUE:42');
  });

  it('should handle multiple levels of dependencies with forEach', async () => {
    const results = await runChecks(
      {
        'fetch-users': {
          type: 'command',
          exec: `echo '[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]'`,
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'enrich-user': {
          type: 'command',
          depends_on: ['fetch-users'],
          exec: `echo '{"user":"{{ outputs['fetch-users'].name }}","score":{{ outputs['fetch-users'].id }}0}'`,
        },
        summarize: {
          type: 'command',
          depends_on: ['enrich-user'],
          exec: `echo "Summary: {{ outputs['enrich-user'] }}"`,
        },
      },
      ['summarize']
    );

    expect(results['summarize']).toBeDefined();
    const checkResult = results['summarize'][0];
    const content = checkResult.content || '';
    expect(content).toContain('Summary:');
  });

  it('should handle empty array from transform_js gracefully', async () => {
    const results = await runChecks(
      {
        'fetch-empty': {
          type: 'command',
          exec: `echo '{"items":[]}'`,
          transform_js: 'JSON.parse(output).items',
          forEach: true,
        },
        'process-empty': {
          type: 'command',
          depends_on: ['fetch-empty'],
          exec: `echo "Processing: {{ outputs['fetch-empty'] }}"`,
        },
      },
      ['process-empty']
    );

    expect(results['process-empty']).toBeDefined();
    expect(Array.isArray(results['process-empty'])).toBe(true);
  });

  it('should raise error on undefined forEach output and skip dependents', async () => {
    const results = await runChecks(
      {
        'fetch-undefined': {
          type: 'command',
          exec: `echo '{"tickets":[{"key":"A-1"}]}'`,
          transform_js: [
            '// Simulate a bug where transform returns nothing',
            'const data = JSON.parse(output);',
            '// forgot to return data.tickets;',
            '// explicitly return undefined',
            'return undefined;',
          ].join('\n'),
          forEach: true,
        },
        'analyze-bug': {
          type: 'command',
          depends_on: ['fetch-undefined'],
          exec: `echo "BUG: {{ outputs['fetch-undefined'].key }}"`,
        },
      },
      ['analyze-bug']
    );

    const allChecks = Object.values(results).flat() as any[];
    const check = allChecks.find((r: any) => r.checkName === 'analyze-bug');
    expect(check).toBeDefined();
    // Skipped dependent should not have produced command output
    expect(check.content || '').toBe('');
    expect(Array.isArray(check.issues)).toBe(true);
  });

  it('should properly aggregate issues from forEach dependent checks', async () => {
    const results = await runChecks(
      {
        'fetch-files': {
          type: 'command',
          exec: `echo '[{"file":"test1.js","hasIssue":true},{"file":"test2.js","hasIssue":false}]'`,
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'check-file': {
          type: 'command',
          depends_on: ['fetch-files'],
          exec: [
            `if [ "{{ outputs['fetch-files'].hasIssue }}" = "true" ]; then`,
            `  echo '{"issues":[{"file":"{{ outputs['fetch-files'].file }}","line":1,"severity":"error","message":"Issue found"}]}'`,
            `else`,
            `  echo '{"issues":[]}'`,
            `fi`,
          ].join('\n'),
        },
      },
      ['check-file']
    );

    const checkResult = results['check-file'][0];
    expect(checkResult.issues).toBeDefined();
    expect(Array.isArray(checkResult.issues)).toBe(true);

    const errorIssues = checkResult.issues.filter((i: any) => i.severity === 'error');
    expect(errorIssues.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle complex JSON transformation with forEach', async () => {
    const results = await runChecks(
      {
        'fetch-api-data': {
          type: 'command',
          exec: `echo '{"status":"success","data":{"users":[{"id":1,"posts":[{"title":"Post1"},{"title":"Post2"}]},{"id":2,"posts":[{"title":"Post3"}]}]}}'`,
          transform_js: [
            'const result = JSON.parse(output);',
            'const flattened = [];',
            'result.data.users.forEach(user => {',
            '  user.posts.forEach(post => {',
            '    flattened.push({ userId: user.id, postTitle: post.title });',
            '  });',
            '});',
            'flattened',
          ].join('\n'),
          forEach: true,
        },
        'analyze-post': {
          type: 'command',
          depends_on: ['fetch-api-data'],
          exec: `echo "User {{ outputs['fetch-api-data'].userId }} posted: {{ outputs['fetch-api-data'].postTitle }}"`,
        },
      },
      ['analyze-post']
    );

    const checkResult = results['analyze-post'][0];
    const content = checkResult.content || '';

    expect(content).toContain('User 1 posted: Post1');
    expect(content).toContain('User 1 posted: Post2');
    expect(content).toContain('User 2 posted: Post3');
  });

  describe('error handling', () => {
    it('should handle transform_js errors gracefully', async () => {
      const results = await runChecks(
        {
          'fetch-invalid': {
            type: 'command',
            exec: `echo '{"data": "test"}'`,
            transform_js: 'JSON.parse(output).nonexistent.property',
            forEach: true,
          },
          'process-invalid': {
            type: 'command',
            depends_on: ['fetch-invalid'],
            exec: `echo "Processing: {{ outputs['fetch-invalid'] }}"`,
          },
        },
        ['process-invalid']
      );

      const allChecks = Object.values(results).flat();
      const checkResult = allChecks.find(
        (r: any) => r.checkName === 'fetch-invalid' || r.checkName === 'process-invalid'
      );
      expect(checkResult).toBeDefined();
    });

    it('should handle malformed JSON in command output', async () => {
      const results = await runChecks(
        {
          'fetch-malformed': {
            type: 'command',
            exec: `echo 'not valid json'`,
            transform_js: 'JSON.parse(output)',
            forEach: true,
          },
          'process-malformed': {
            type: 'command',
            depends_on: ['fetch-malformed'],
            exec: `echo "Processing: {{ outputs['fetch-malformed'] }}"`,
          },
        },
        ['process-malformed']
      );

      const allChecks = Object.values(results).flat() as any[];
      const fetchResult = allChecks.find((r: any) => r.checkName === 'fetch-malformed');
      expect(fetchResult).toBeDefined();
      const issues = (fetchResult as any)?.issues || [];
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
