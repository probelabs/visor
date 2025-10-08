import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';
import { CheckProvider, CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { PRInfo } from '../../src/pr-analyzer';
import { ReviewSummary } from '../../src/reviewer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

class StubAICustomProvider extends CheckProvider {
  getName(): string {
    return 'ai';
  }
  getSupportedConfigKeys(): string[] {
    return ['type', 'prompt', 'schema', 'fail_if'];
  }
  getDescription(): string {
    return 'Stub AI provider for tests (custom schema passthrough)';
  }
  async validateConfig(_config: unknown): Promise<boolean> {
    return true;
  }
  async execute(_prInfo: PRInfo, _config: CheckProviderConfig): Promise<ReviewSummary> {
    // Simulate AI returning a custom schema JSON with an error field
    return {
      issues: [],
      output: { ticket: {}, error: 'Missing data' },
    } as ReviewSummary;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  getRequirements(): string[] {
    return [];
  }
}

describe('fail_if with AI custom schema (integration)', () => {
  let engine: CheckExecutionEngine;
  let tempDir: string;
  let originalRegistry: CheckProviderRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-failif-ai-'));
    execSync('git init -q', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'x');
    execSync('git add .', { cwd: tempDir });
    execSync('git -c core.hooksPath=/dev/null commit -q -m "init"', { cwd: tempDir });

    // Replace 'ai' provider with stub for deterministic custom schema output
    originalRegistry = CheckProviderRegistry.getInstance();
    try {
      // Unregister built-in ai and register stub
      (originalRegistry as any).unregister('ai');
    } catch {}
    (originalRegistry as any).register(new StubAICustomProvider());

    engine = new CheckExecutionEngine(tempDir);
  });

  afterEach(() => {
    // Reset registry to default providers
    CheckProviderRegistry.clearInstance();
    // Clean temp dir
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('evaluates fail_if: output.error and skips dependent', async () => {
    const schemaDir = path.join(tempDir, 'schemas');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.writeFileSync(
      path.join(schemaDir, 'ticket-analysis.json'),
      JSON.stringify({ type: 'object' })
    );

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'analyze-bug': {
          type: 'ai',
          prompt: 'Analyze JIRA ticket',
          schema: './schemas/ticket-analysis.json',
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

    // Dependent must be skipped
    const stats = result.executionStatistics!;
    const logStats = stats.checks.find(c => c.checkName === 'log-results');
    expect(logStats).toBeDefined();
    expect(logStats!.skipped).toBe(true);

    // Fail_if issue should be present on analyze-bug (ruleId ends with _fail_if)
    const failIfFound = (result.reviewSummary.issues || []).some(
      i => typeof i.ruleId === 'string' && i.ruleId.endsWith('analyze-bug_fail_if')
    );
    expect(failIfFound).toBe(true);
  });
});
