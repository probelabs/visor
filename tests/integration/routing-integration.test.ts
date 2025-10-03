import { CheckExecutionEngine } from '../../src/check-execution-engine';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Failure/Success Routing Integration', () => {
  let tmpDir: string;
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-routing-'));
    engine = new CheckExecutionEngine(process.cwd());
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('retries a failing command and succeeds (fixed backoff)', async () => {
    const marker = path.join(tmpDir, 'flaky-once');
    const cfg = {
      version: '2.0',
      checks: {
        flaky: {
          type: 'command',
          exec: `test -f ${marker} || (touch ${marker} && echo fail >&2 && exit 1); echo ok`,
          on_fail: {
            retry: { max: 1, backoff: { mode: 'fixed', delay_ms: 10 } },
          },
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const res = await engine.executeChecks({
      checks: ['flaky'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });

    expect(
      (res.reviewSummary.issues || []).filter((i: any) => i.severity === 'error')
    ).toHaveLength(0);
  });

  it('runs remediation and goto ancestor, then retries and succeeds', async () => {
    const ready = path.join(tmpDir, 'ready');
    const cfg = {
      version: '2.0',
      routing: { max_loops: 5 },
      checks: {
        'setup-env': { type: 'command', exec: `echo setup >/dev/null` },
        prepare: { type: 'command', exec: `touch ${ready}` },
        'unit-tests': {
          type: 'command',
          depends_on: ['setup-env'],
          exec: `test -f ${ready} && exit 0; exit 1`,
          on_fail: {
            run: ['prepare'],
            goto: 'setup-env',
            retry: { max: 1, backoff: { mode: 'fixed', delay_ms: 10 } },
          },
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const res = await engine.executeChecks({
      checks: ['unit-tests', 'setup-env'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });
    expect(fs.existsSync(ready)).toBe(true); // remediation touched file
    const errors = (res.reviewSummary.issues || []).filter((i: any) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('on_success goto ancestor re-runs current check', async () => {
    const unitCount = path.join(tmpDir, 'unit.count');
    const buildCount = path.join(tmpDir, 'build.count');
    const cfg = {
      version: '2.0',
      routing: { max_loops: 5 },
      checks: {
        'unit-tests': { type: 'command', exec: `echo 1 >> ${unitCount}` },
        build: {
          type: 'command',
          depends_on: ['unit-tests'],
          exec: `echo 1 >> ${buildCount}`,
          on_success: {
            goto_js: `
              // Only jump once on initial success
              return attempt === 1 ? 'unit-tests' : null;
            `,
          },
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const res = await engine.executeChecks({
      checks: ['build', 'unit-tests'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });
    const errors = (res.reviewSummary.issues || []).filter((i: any) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('forEach item has its own retry loop and remediation uses item context', async () => {
    const cfg = {
      version: '2.0',
      routing: { max_loops: 5 },
      checks: {
        list: {
          type: 'command',
          exec: `echo '["alpha","beta"]'`,
          forEach: true,
        },
        mark: {
          type: 'command',
          depends_on: ['list'],
          exec: `touch ${tmpDir}/marker-{{ outputs.list }}`,
        },
        process: {
          type: 'command',
          depends_on: ['list'],
          exec: `test -f ${tmpDir}/marker-{{ outputs.list }} && echo done && exit 0; exit 1`,
          on_fail: {
            run: ['mark'],
            retry: { max: 1, backoff: { mode: 'fixed', delay_ms: 10 } },
          },
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check' } },
    } as any;

    const res = await engine.executeChecks({
      checks: ['process', 'list'],
      config: cfg,
      outputFormat: 'json',
      debug: true,
    });
    const errors = (res.reviewSummary.issues || []).filter((i: any) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});
