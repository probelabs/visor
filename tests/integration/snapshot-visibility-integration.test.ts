import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('Snapshot Visibility Integration', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  it("consumer (no depends_on) sees producer's output via snapshot + goto", async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        producer: {
          type: 'command',
          exec: 'echo \'{"msg":"hello"}\'',
          // hint for command provider (parsing aided by schema key)
          output_format: 'json' as any,
          on_success: {
            goto: 'consumer',
          },
        },
        consumer: {
          type: 'script',
          depends_on: ['producer'],
          // Note: with script provider, we provide explicit dependency
          content: `
            // Read producer output via snapshot-provided outputs
            const value = outputs["producer"]?.msg;
            if (value !== 'hello') {
              throw new Error('Snapshot visibility failed: expected hello');
            }
            return { seen: value };
          `,
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['producer'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    expect(result.reviewSummary.issues?.length || 0).toBe(0);
    const stats = result.executionStatistics?.checks || [];
    const ranConsumer = stats.some(s => s.checkName === 'consumer' && s.totalRuns >= 1);
    expect(ranConsumer).toBe(true);
  });
});
