import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

describe('fail_if with command provider (integration)', () => {
  let engine: CheckExecutionEngine;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-failif-cmd-'));
    execSync('git init -q', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'x');
    execSync('git add .', { cwd: tempDir });
    execSync('git -c core.hooksPath=/dev/null commit -q -m "init"', { cwd: tempDir });

    engine = new CheckExecutionEngine(tempDir);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('adds fail_if issue and skips dependent', async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'analyze-bug': {
          type: 'command',
          exec: `echo '{"ticket": {}, "error": "Missing data"}'`,
          fail_if: 'output.error',
        },
        'log-results': {
          type: 'command',
          depends_on: ['analyze-bug'],
          exec: 'echo OK',
        },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check', collapse: false },
      },
    };

    const result = await engine.executeChecks({
      checks: ['analyze-bug', 'log-results'],
      config,
      debug: true,
      workingDirectory: tempDir,
    });

    const issues = result.reviewSummary.issues || [];
    const hasFailIf = issues.some(i => (i.ruleId || '').endsWith('analyze-bug_fail_if'));
    expect(hasFailIf).toBe(true);

    const stats = result.executionStatistics!;
    const logStats = stats.checks!.find(c => c.checkName === 'log-results');
    expect(logStats).toBeDefined();
    expect(logStats!.skipped).toBe(true);
  });
});
