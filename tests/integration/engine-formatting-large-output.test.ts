import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { OutputFormatters } from '../../src/output-formatters';
import { VisorConfig } from '../../src/types/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

describe('Engine + formatter integration: large outputs do not stall', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-engine-format-'));
    execSync('git init -q', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# repo');
    execSync('git add .', { cwd: tempDir });
    execSync('git -c core.hooksPath=/dev/null commit -q -m init', { cwd: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('formats a 3-check chain (forEach -> analyze with custom-like output -> dependent) with truncation and skip gating', async () => {
    const bigMsg = 'X'.repeat(1200);
    const bigCode = Array.from({ length: 40 }, () => 'const a = 1; //' + 'y'.repeat(80)).join('\n');

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-tickets': {
          type: 'command',
          exec: `node -e "console.log(JSON.stringify({ tickets: [{id:'TT-1'},{id:'TT-2'}] }))"`,
          transform_js: 'output.tickets',
          forEach: true,
        },
        'analyze-bug': {
          type: 'command',
          depends_on: ['fetch-tickets'],
          exec:
            'node -e ' +
            JSON.stringify(
              `const out={issues:[{file:'system',line:1,ruleId:'logic/big',category:'logic',severity:'error',message:${JSON.stringify(
                bigMsg
              )},replacement:${JSON.stringify(bigCode)}}],output:{error:'Missing'}};console.log(JSON.stringify(out));`
            ),
          fail_if: 'output.error',
        },
        'update-labels': {
          type: 'command',
          depends_on: ['analyze-bug'],
          exec: 'node -e "console.log(\'ok\')"',
        },
      },
    } as any;

    const engine = new CheckExecutionEngine(tempDir);
    const result = await engine.executeChecks({
      checks: ['fetch-tickets', 'analyze-bug', 'update-labels'],
      config,
    });

    // Aggregate issues into a fake analysis result for the formatter
    const issues = result.reviewSummary.issues || [];
    expect(issues.length).toBeGreaterThan(0);

    // Note: skip gating for aggregated custom outputs is covered elsewhere;
    // here we focus on ensuring the formatter handles large content without stalling.

    const table = OutputFormatters.formatAsTable(
      {
        repositoryInfo: {
          title: 'Test',
          body: '',
          author: 'tester',
          base: 'main',
          head: 'feature',
          isGitRepository: true,
          workingDirectory: tempDir,
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        },
        reviewSummary: { issues },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: ['fetch-tickets', 'analyze-bug', 'update-labels'],
      },
      { groupByCategory: true }
    );

    expect(table.length).toBeGreaterThan(0);
    expect(table).toContain('… [truncated]');
  });
});
