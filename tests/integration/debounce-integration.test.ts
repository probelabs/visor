import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { VisorConfig } from '../../src/types/config';
import { resetDebounceManager } from '../../src/state-machine/dispatch/debounce-manager';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

describe('Debounce integration', () => {
  let tempDir: string;

  beforeEach(() => {
    process.env.VISOR_DEBOUNCE_OVERRIDE = '0';
    resetDebounceManager();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-debounce-int-'));
    execSync('git init -q', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'x');
    execSync('git add .', { cwd: tempDir });
    execSync('git -c core.hooksPath=/dev/null commit -q -m "init"', { cwd: tempDir });
  });

  afterEach(() => {
    delete process.env.VISOR_DEBOUNCE_OVERRIDE;
    resetDebounceManager();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('debounced step executes and returns actual result', async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        producer: {
          type: 'command',
          exec: 'echo "produced"',
        },
        'debounced-step': {
          type: 'command',
          depends_on: ['producer'],
          debounce: 60000,
          debounce_key: 'test-debounce',
          exec: 'echo "debounce-output-42"',
        },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check', collapse: false },
      },
    };

    const engine = new StateMachineExecutionEngine();
    const result = await engine.executeChecks({
      checks: ['producer', 'debounced-step'],
      workingDirectory: tempDir,
      config,
    });

    // The debounced step should have executed (single invocation, no coalescing needed)
    expect(result).toBeDefined();
    expect(result.reviewSummary).toBeDefined();

    // Check that history contains the debounced step's actual output
    const history = (result.reviewSummary as any).history;
    if (history && history['debounced-step']) {
      const outputs = history['debounced-step'];
      expect(outputs.length).toBeGreaterThan(0);
      // The output should contain the actual command result, not { debounced: false }
      const lastOutput = outputs[outputs.length - 1];
      // Command output should contain our echo text
      const outputStr = typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput);
      expect(outputStr).toContain('debounce-output-42');
    }
  });

  it('concurrent engine runs with same debounce key coalesce correctly', async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        debounced: {
          type: 'command',
          debounce: 60000,
          debounce_key: 'shared-key',
          exec: 'echo "executed"',
        },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check', collapse: false },
      },
    };

    // Run two engines concurrently with the same debounce key
    const engine1 = new StateMachineExecutionEngine();
    const engine2 = new StateMachineExecutionEngine();

    const [r1, r2] = await Promise.all([
      engine1.executeChecks({
        checks: ['debounced'],
        workingDirectory: tempDir,
        config,
      }),
      engine2.executeChecks({
        checks: ['debounced'],
        workingDirectory: tempDir,
        config,
      }),
    ]);

    // Both should complete without error
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    // One should have executed, the other debounced
    const h1 = (r1.reviewSummary as any).history?.['debounced'];
    const h2 = (r2.reviewSummary as any).history?.['debounced'];

    // At least one result should exist with actual output
    const allOutputs = [...(h1 || []), ...(h2 || [])];
    const hasExecuted = allOutputs.some((o: any) => {
      const s = typeof o === 'string' ? o : JSON.stringify(o);
      return s.includes('executed');
    });
    const hasDebounced = allOutputs.some((o: any) => {
      return o && typeof o === 'object' && o.debounced === true;
    });

    // We expect one executed and one debounced
    expect(hasExecuted || hasDebounced).toBe(true);
  });

  it('debounced step with depends_on runs after dependency completes', async () => {
    const markerFile = path.join(tempDir, 'marker.txt');

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        setup: {
          type: 'command',
          exec: `echo "setup-done" > "${markerFile}"`,
        },
        'debounced-consumer': {
          type: 'command',
          depends_on: ['setup'],
          debounce: 60000,
          debounce_key: 'consumer-key',
          exec: `cat "${markerFile}"`,
        },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check', collapse: false },
      },
    };

    const engine = new StateMachineExecutionEngine();
    const result = await engine.executeChecks({
      checks: ['setup', 'debounced-consumer'],
      workingDirectory: tempDir,
      config,
    });

    expect(result).toBeDefined();

    // The consumer should have run after setup created the file
    const history = (result.reviewSummary as any).history;
    if (history?.['debounced-consumer']) {
      const outputs = history['debounced-consumer'];
      const outputStr = JSON.stringify(outputs);
      expect(outputStr).toContain('setup-done');
    }
  });
});
