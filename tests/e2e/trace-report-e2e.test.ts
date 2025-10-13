/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

describe('Trace Report Exporter E2E', () => {
  const tempDir = path.join(__dirname, '..', 'fixtures', 'temp');
  const tracesDir = path.join(tempDir, 'traces-report');
  const configPath = path.join(tempDir, 'trace-report.yaml');
  const originalExit = process.exit;
  let mockProcessExit: jest.Mock;

  beforeAll(() => {
    fs.mkdirSync(tracesDir, { recursive: true });
    const cfg = {
      version: '1.0',
      checks: {
        demo: { type: 'noop', group: 'default' },
      },
      telemetry: { enabled: true },
    } as const;
    fs.writeFileSync(configPath, yaml.dump(cfg), 'utf8');
  });

  beforeEach(() => {
    mockProcessExit = jest.fn();
    process.exit = mockProcessExit as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    jest.clearAllMocks();
  });

  it('writes an HTML trace report when enabled', async () => {
    process.env.VISOR_TELEMETRY_ENABLED = 'true';
    process.env.VISOR_TELEMETRY_SINK = 'file';
    process.env.VISOR_TRACE_DIR = tracesDir;
    process.env.VISOR_TRACE_REPORT = 'true';

    const { main } = await import('../../src/cli-main');
    process.argv = ['node', 'visor', '--config', configPath, '--output', 'json'];
    await main();

    const files = fs.readdirSync(tracesDir);
    const report = files.find(f => f.endsWith('.report.html'));
    expect(report).toBeTruthy();
    const html = fs.readFileSync(path.join(tracesDir, report as string), 'utf8');
    expect(html).toContain('Visor Trace Report');
  });
});
