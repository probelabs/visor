/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

describe('Telemetry E2E — complex transform + forEach, JSON file output', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalStderrWrite = process.stderr.write;
  // no-op placeholder to keep earlier structure
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _capturedStderr_placeholder = '';

  let mockConsoleLog: jest.Mock;
  let mockConsoleError: jest.Mock;
  let mockProcessExit: jest.Mock;
  let mockStderrWrite: jest.Mock;

  const tempDir = path.join(__dirname, '..', 'fixtures', 'temp');
  const tracesDir = path.join(tempDir, 'traces-transform');
  const outFile = path.join(tempDir, 'result-transform.json');
  const configPath = path.join(tempDir, 'telemetry-transform-e2e.yaml');

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(tracesDir, { recursive: true });

    // Complex config with transform + forEach + dependent chain, all with portable commands
    const cfg = {
      version: '1.0',
      checks: {
        // Build a nested object via node -e and transform to an array
        'build-data': {
          type: 'command',
          exec: `node -e "console.log(JSON.stringify({group:{items:[{id:'A',n:1},{id:'B',n:2}]}}))"`,
          transform: `{{ output.group.items | json }}`,
          forEach: true,
          group: 'transform',
        },
        // Process each item from build-data
        'process-item': {
          type: 'command',
          exec: `node -e "console.log('PROC:'+JSON.stringify({id:'{{ outputs['build-data'].id }}',n:{{ outputs['build-data'].n }} }))"`,
          depends_on: ['build-data'],
          group: 'transform',
        },
        // Another forEach chain created purely by transform
        'emit-files': {
          type: 'command',
          exec: `node -e "console.log('file1.js\nfile2.js')"`,
          transform: `{{ output | split: "\n" | json }}`,
          forEach: true,
          group: 'files',
        },
        'analyze-file': {
          type: 'command',
          exec: `node -e "console.log('LEN:'+('{{ outputs['emit-files'] }}').length)"`,
          depends_on: ['emit-files'],
          group: 'files',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: true },
      },
      telemetry: {
        enabled: true,
        sink: 'file',
        file: { dir: tracesDir, ndjson: true },
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

    // Also enable env for serverless traces (config enables as well)
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
    if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
  });

  it('writes JSON file and traces with forEach spans', async () => {
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
    await main();

    // Validate file JSON
    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, 'utf8');
    const parsed = JSON.parse(content);
    // Should contain both groups and both check names
    expect(parsed.transform).toBeDefined();
    expect(parsed.files).toBeDefined();
    const tChecks = parsed.transform.map((c: any) => c.checkName);
    const fChecks = parsed.files.map((c: any) => c.checkName);
    expect(tChecks).toEqual(expect.arrayContaining(['build-data', 'process-item']));
    expect(fChecks).toEqual(expect.arrayContaining(['emit-files', 'analyze-file']));

    // Validate traces emitted
    const files = fs.readdirSync(tracesDir).filter(f => f.endsWith('.ndjson'));
    expect(files.length).toBeGreaterThan(0);
    const newest = files
      .map(f => ({ f, t: fs.statSync(path.join(tracesDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0].f;

    const lines = fs
      .readFileSync(path.join(tracesDir, newest), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(l => JSON.parse(l));
    const names = lines.map((s: any) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['visor.run', 'visor.check', 'visor.foreach.item'])
    );

    // Validate foreach span counts for both chains
    const feProcess = lines.filter(
      (s: any) =>
        s.name === 'visor.foreach.item' && s.attributes?.['visor.check.id'] === 'process-item'
    );
    expect(feProcess.length).toBe(2); // items A,B
    feProcess.forEach((s: any) => expect(s.attributes['visor.foreach.total']).toBe(2));

    const feAnalyze = lines.filter(
      (s: any) =>
        s.name === 'visor.foreach.item' && s.attributes?.['visor.check.id'] === 'analyze-file'
    );
    expect(feAnalyze.length).toBe(2); // file1.js, file2.js
    feAnalyze.forEach((s: any) => expect(s.attributes['visor.foreach.total']).toBe(2));

    // Check spans have events
    const processCheck = lines.find(
      (s: any) => s.name === 'visor.check' && s.attributes?.['visor.check.id'] === 'process-item'
    );
    expect(processCheck).toBeTruthy();
    const ev = (processCheck!.events || []).map((e: any) => e.name);
    expect(ev).toEqual(expect.arrayContaining(['check.started', 'check.completed']));
  });
});
