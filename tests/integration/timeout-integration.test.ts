import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

describe('Timeout behavior integration', () => {
  let engine: CheckExecutionEngine;
  let tempDir: string;

  beforeEach(() => {
    engine = new CheckExecutionEngine();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-timeout-int-'));
    execSync('git init -q', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'x');
    execSync('git add .', { cwd: tempDir });
    execSync('git -c core.hooksPath=/dev/null commit -q -m "init"', { cwd: tempDir });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('counts command timeout as failed run and skips dependents', async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-tickets': {
          type: 'command',
          timeout: 1,
          exec: 'echo \'DEBUG: start\' && sleep 5 && echo \'{"tickets":[{"key":"TT-1"}]}\'',
          transform_js: 'JSON.parse(output).tickets',
          forEach: true,
        },
        'analyze-bug': {
          type: 'command',
          depends_on: ['fetch-tickets'],
          exec: "echo RUN {{ outputs['fetch-tickets'].key }}",
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: false,
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['fetch-tickets', 'analyze-bug'],
      workingDirectory: tempDir,
      config,
      debug: true,
    });

    expect(result.executionStatistics).toBeDefined();
    const stats = result.executionStatistics!;

    const fetchStats = stats.checks.find(c => c.checkName === 'fetch-tickets');
    expect(fetchStats).toBeDefined();
    expect(fetchStats!.failedRuns).toBe(1);
    expect(fetchStats!.successfulRuns).toBe(0);

    const analyzeStats = stats.checks.find(c => c.checkName === 'analyze-bug');
    expect(analyzeStats).toBeDefined();
    expect(analyzeStats!.skipped).toBe(true);
    expect(analyzeStats!.skipReason).toBe('dependency_failed');
  });
});
