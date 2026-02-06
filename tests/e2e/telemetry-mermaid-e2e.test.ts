/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

describe('Telemetry E2E — Mermaid diagram telemetry (full code)', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  let mockConsoleLog: jest.Mock;
  let mockConsoleError: jest.Mock;
  let mockProcessExit: jest.Mock;

  const tempDir = path.join(__dirname, '..', 'fixtures', 'temp');
  const tracesDir = path.join(tempDir, 'traces-mermaid');
  const outFile = path.join(tempDir, 'result-mermaid.json');
  const configPath = path.join(tempDir, 'telemetry-mermaid-e2e.yaml');

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(tracesDir, { recursive: true });
  });

  beforeEach(() => {
    // Build a check that renders a template containing a mermaid block
    const cfg = {
      version: '1.0',
      checks: {
        'emit-mermaid': {
          type: 'noop',
          template: {
            content: `# Diagram\n\nHere is the architecture:\n\n\`\`\`mermaid\ngraph TD\n  A[Client] --> B[API]\n  B --> C[DB]\n\n\`\`\`\n`,
          },
          group: 'diagrams',
        },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    } as const;

    fs.writeFileSync(configPath, yaml.dump(cfg), 'utf8');

    mockConsoleLog = jest.fn();
    mockConsoleError = jest.fn();
    mockProcessExit = jest.fn();
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    process.exit = mockProcessExit as any;
    process.env.VISOR_TELEMETRY_ENABLED = 'true';
    process.env.VISOR_TELEMETRY_SINK = 'file';
    process.env.VISOR_TRACE_DIR = tracesDir;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    jest.clearAllMocks();
  });

  it('emits diagram.block events with full mermaid code', async () => {
    process.env.VISOR_TRACE_REPORT = 'true';
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

    // Verify trace JSON contains diagram.block event with code that includes graph TD
    const jsonFiles = fs.readdirSync(tracesDir).filter(f => f.endsWith('.trace.json'));
    expect(jsonFiles.length).toBeGreaterThan(0);
    const newest = jsonFiles
      .map(f => ({ f, t: fs.statSync(path.join(tracesDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0].f;
    const trace = JSON.parse(fs.readFileSync(path.join(tracesDir, newest), 'utf8'));
    const eventHasDiagram = (trace.spans || []).some((span: any) =>
      (span.events || []).some(
        (e: any) => e.name === 'diagram.block' && /graph TD/.test(String(e.attrs?.code || ''))
      )
    );
    expect(eventHasDiagram).toBe(true);
  });
});
