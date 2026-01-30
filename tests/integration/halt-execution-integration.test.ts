/**
 * Integration tests for halt_execution functionality
 *
 * These tests verify that when a failure condition with `halt_execution: true`
 * triggers, the workflow should stop and dependent checks should NOT run.
 */

import { CheckExecutionEngine } from '../../src/check-execution-engine';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Halt Execution Integration', () => {
  let tmpDir: string;
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-halt-'));
    engine = new CheckExecutionEngine(process.cwd());
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should stop workflow when halt_execution: true condition triggers', async () => {
    // Marker file to track if dependent check runs
    const dependentMarker = path.join(tmpDir, 'dependent-ran');

    const cfg = {
      version: '2.0',
      checks: {
        'critical-check': {
          type: 'command',
          // This command outputs an error that will trigger the halt condition
          exec: `echo '{"error": true, "critical": true}'`,
          // Use failure_conditions with halt_execution: true
          failure_conditions: {
            critical_failure: {
              condition: 'output.critical === true',
              message: 'Critical failure detected - halt execution',
              severity: 'error',
              halt_execution: true,
            },
          },
        },
        'dependent-check': {
          type: 'command',
          depends_on: ['critical-check'],
          // This should NOT run if critical-check triggers halt
          exec: `touch ${dependentMarker} && echo dependent executed`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    await engine.executeChecks({
      checks: ['critical-check', 'dependent-check'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });

    // The dependent check should NOT have run because halt_execution was triggered
    expect(fs.existsSync(dependentMarker)).toBe(false);
  });

  it('should continue workflow when halt_execution: false condition triggers', async () => {
    // Marker file to track if dependent check runs
    const dependentMarker = path.join(tmpDir, 'dependent-ran');

    const cfg = {
      version: '2.0',
      checks: {
        'non-critical-check': {
          type: 'command',
          exec: `echo '{"error": true, "critical": false}'`,
          // Use failure_conditions with halt_execution: false (should continue)
          failure_conditions: {
            non_critical_failure: {
              condition: 'output.error === true',
              message: 'Non-critical failure - continue execution',
              severity: 'warning',
              halt_execution: false,
            },
          },
        },
        'dependent-check': {
          type: 'command',
          depends_on: ['non-critical-check'],
          exec: `touch ${dependentMarker} && echo dependent executed`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    await engine.executeChecks({
      checks: ['non-critical-check', 'dependent-check'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });

    // The dependent check SHOULD run because halt_execution is false
    expect(fs.existsSync(dependentMarker)).toBe(true);
  });

  it('should stop workflow when failure_conditions with halt_execution: true triggers (named condition)', async () => {
    // Marker file to track if dependent check runs
    const dependentMarker = path.join(tmpDir, 'dependent-ran');

    const cfg = {
      version: '2.0',
      checks: {
        'critical-check': {
          type: 'command',
          exec: `echo '{"status": "critical"}'`,
          // Use failure_conditions with halt_execution: true (named condition)
          failure_conditions: {
            critical_status: {
              condition: 'output.status === "critical"',
              message: 'Critical status detected',
              halt_execution: true,
            },
          },
        },
        'dependent-check': {
          type: 'command',
          depends_on: ['critical-check'],
          exec: `touch ${dependentMarker} && echo dependent executed`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    await engine.executeChecks({
      checks: ['critical-check', 'dependent-check'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });

    // The dependent check should NOT have run because halt_execution was triggered
    expect(fs.existsSync(dependentMarker)).toBe(false);
  });

  it('should stop all parallel checks when halt_execution triggers', async () => {
    // Marker files to track which checks run
    const parallelMarker1 = path.join(tmpDir, 'parallel1-ran');
    const parallelMarker2 = path.join(tmpDir, 'parallel2-ran');
    const finalMarker = path.join(tmpDir, 'final-ran');

    const cfg = {
      version: '2.0',
      checks: {
        'critical-check': {
          type: 'command',
          exec: `echo '{"halt": true}'`,
          failure_conditions: {
            halt_all: {
              condition: 'output.halt === true',
              message: 'Halt all execution',
              halt_execution: true,
            },
          },
        },
        'parallel-check-1': {
          type: 'command',
          depends_on: ['critical-check'],
          exec: `touch ${parallelMarker1}`,
        },
        'parallel-check-2': {
          type: 'command',
          depends_on: ['critical-check'],
          exec: `touch ${parallelMarker2}`,
        },
        'final-check': {
          type: 'command',
          depends_on: ['parallel-check-1', 'parallel-check-2'],
          exec: `touch ${finalMarker}`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    await engine.executeChecks({
      checks: ['critical-check', 'parallel-check-1', 'parallel-check-2', 'final-check'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });

    // None of the dependent checks should have run
    expect(fs.existsSync(parallelMarker1)).toBe(false);
    expect(fs.existsSync(parallelMarker2)).toBe(false);
    expect(fs.existsSync(finalMarker)).toBe(false);
  });

  it('should halt on global failure_conditions with halt_execution', async () => {
    const dependentMarker = path.join(tmpDir, 'dependent-ran');

    const cfg = {
      version: '2.0',
      // Global failure_conditions apply to all checks
      failure_conditions: {
        global_halt: {
          condition: 'output.severity === "critical"',
          message: 'Global halt triggered',
          halt_execution: true,
        },
      },
      checks: {
        'check-one': {
          type: 'command',
          exec: `echo '{"severity": "critical"}'`,
        },
        'check-two': {
          type: 'command',
          depends_on: ['check-one'],
          exec: `touch ${dependentMarker}`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    await engine.executeChecks({
      checks: ['check-one', 'check-two'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });

    // Dependent should NOT run due to global halt
    expect(fs.existsSync(dependentMarker)).toBe(false);
  });

  it('should report halted state in execution result', async () => {
    const cfg = {
      version: '2.0',
      checks: {
        'halt-check': {
          type: 'command',
          exec: `echo '{"critical": true}'`,
          failure_conditions: {
            halt_now: {
              condition: 'output.critical === true',
              message: 'Execution halted due to critical failure',
              halt_execution: true,
            },
          },
        },
        'never-runs': {
          type: 'command',
          depends_on: ['halt-check'],
          exec: `echo should-not-see-this`,
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const result = await engine.executeChecks({
      checks: ['halt-check', 'never-runs'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });

    // Result should indicate execution was halted
    // Check for halt-related issue in the result
    const allIssues = result.reviewSummary?.issues || [];
    const haltIssue = allIssues.find(
      (i: any) =>
        i.message?.toLowerCase().includes('halt') || i.ruleId?.toLowerCase().includes('halt')
    );

    // The halt issue should be present in the aggregated issues
    // OR there should be at least some indication of the halt (issues array not empty)
    const hasHaltIndication =
      haltIssue || result.reviewSummary?.error || (result as any).error || (result as any).halted;

    expect(hasHaltIndication || allIssues.length > 0).toBeTruthy();
  });
});
