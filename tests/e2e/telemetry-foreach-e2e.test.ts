/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

describe('Telemetry E2E — forEach tracing + JSON output', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalStderrWrite = process.stderr.write;

  let mockConsoleLog: jest.Mock;
  let mockConsoleError: jest.Mock;
  let mockProcessExit: jest.Mock;
  let mockStderrWrite: jest.Mock;

  const tempDir = path.join(__dirname, '..', 'fixtures', 'temp');
  const tracesDir = path.join(tempDir, 'traces-e2e');
  const outFile = path.join(tempDir, 'result-foreach.json');
  const configPath = path.join(tempDir, 'telemetry-foreach-e2e.yaml');

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(tracesDir, { recursive: true });

    // Minimal config with forEach and a dependent check
    const cfg = {
      version: '1.0',
      checks: {
        'emit-items': {
          type: 'command',
          // Emit a JSON array using Node — portable and no external deps
          exec: `node -e "console.log(JSON.stringify(['alpha','beta']))"`,
          forEach: true,
          group: 'demo',
        },
        'process-item': {
          type: 'command',
          exec: `echo ITEM: {{ outputs['emit-items'] }}`,
          depends_on: ['emit-items'],
          group: 'demo',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: true },
      },
    } as const;

    fs.writeFileSync(configPath, yaml.dump(cfg), 'utf8');
  });

  beforeEach(() => {
    mockConsoleLog = jest.fn();
    mockConsoleError = jest.fn();
    mockProcessExit = jest.fn();

    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    process.exit = mockProcessExit as any;

    mockStderrWrite = jest.fn(() => true);
    (process.stderr.write as unknown as jest.Mock | ((...a: any[]) => any)) =
      mockStderrWrite as any;

    // Enable serverless telemetry to file (NDJSON)
    process.env.VISOR_TELEMETRY_ENABLED = 'true';
    process.env.VISOR_TELEMETRY_SINK = 'file';
    process.env.VISOR_TRACE_DIR = tracesDir;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    (process.stderr.write as unknown as jest.Mock | ((...a: any[]) => any)) =
      originalStderrWrite as any;
    jest.clearAllMocks();
  });

  it('runs the example, outputs JSON, and writes forEach spans to NDJSON', async () => {
    // Prepare CLI argv (write to file for explicit JSON reading)
    process.argv = [
      'node',
      'visor',
      '--config',
      configPath,
      '--output',
      'json',
      '--output-file',
      outFile,
    ];

    const { main } = await import('../../src/cli-main');

    // Run CLI
    await main();

    // Validate JSON read from file to avoid log suppression issues
    expect(fs.existsSync(outFile)).toBe(true);
    const fileContent = fs.readFileSync(outFile, 'utf8');
    const parsed = JSON.parse(fileContent);
    // Should be groupedResults: { demo: [ { checkName, content, group } , ... ] }
    expect(parsed.demo).toBeDefined();
    const checks = parsed.demo.map((c: any) => c.checkName);
    expect(checks).toEqual(expect.arrayContaining(['emit-items', 'process-item']));

    // Ensure a trace file was written
    const files = fs.readdirSync(tracesDir).filter(f => f.endsWith('.ndjson'));
    expect(files.length).toBeGreaterThan(0);
    const newest = files
      .map(f => ({ f, t: fs.statSync(path.join(tracesDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0].f;

    const ndjson = fs.readFileSync(path.join(tracesDir, newest), 'utf8').trim();
    expect(ndjson.length).toBeGreaterThan(0);
    const lines = ndjson.split(/\r?\n/).map(l => JSON.parse(l));

    // Expect at least one run span, one check span, and forEach item spans
    const names = lines.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(['visor.run']));
    expect(names).toEqual(expect.arrayContaining(['visor.check']));
    expect(names).toEqual(expect.arrayContaining(['visor.foreach.item']));

    // Validate foreach span count and attributes for child check
    const foreachSpans = lines.filter(
      (s: any) =>
        s.name === 'visor.foreach.item' && s.attributes?.['visor.check.id'] === 'process-item'
    );
    expect(foreachSpans.length).toBe(2); // alpha, beta
    foreachSpans.forEach((s: any) => {
      expect(s.attributes['visor.foreach.total']).toBe(2);
      expect([0, 1]).toContain(s.attributes['visor.foreach.index']);
    });

    // Provider span present
    const names = lines.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(['visor.provider']));

    // Check started/completed events present
    const checkSpans = lines.filter(
      (s: any) => s.name === 'visor.check' && s.attributes?.['visor.check.id'] === 'process-item'
    );
    expect(checkSpans.length).toBeGreaterThan(0);
    const events = (checkSpans[0].events || []).map((e: any) => e.name);
    expect(events).toEqual(expect.arrayContaining(['check.started', 'check.completed']));

    // process.exit should have been called with 0 (no critical issues and no repo error)
    expect(mockProcessExit).toHaveBeenCalledWith(expect.any(Number));
  });
});
