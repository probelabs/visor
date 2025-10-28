import { CheckExecutionEngine } from '../../src/check-execution-engine';

describe('Overview check with mock provider (e2e)', () => {
  it('renders overview text (not just []) using default overview schema', async () => {
    const engine = new CheckExecutionEngine(process.cwd());

    const config = {
      version: '2.0',
      ai_provider: 'mock',
      ai_model: 'mock',
      checks: {
        overview: {
          type: 'ai',
          group: 'overview',
          schema: 'overview',
          prompt: 'Generate PR overview',
          on: ['pr_opened'],
        },
      },
    } as any;

    const prInfo = {
      number: 1,
      title: 'Test PR',
      body: 'Adds tests',
      author: 'dev',
      base: 'main',
      head: 'feat/test',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      fullDiff: '',
      eventType: 'pr_opened',
      isIssue: false,
    } as any;

    const { results } = await engine.executeGroupedChecks(
      prInfo,
      ['overview'],
      undefined,
      config,
      undefined,
      false,
      1,
      false
    );

    expect(results.overview).toBeDefined();
    expect(Array.isArray(results.overview)).toBe(true);
    expect(results.overview.length).toBeGreaterThan(0);
    const content = results.overview[0].content || '';
    expect(typeof content).toBe('string');
    expect(content.trim()).not.toBe('[]');
    // The mock now returns a helpful default body
    expect(content).toContain('PR Overview');
  });
});
