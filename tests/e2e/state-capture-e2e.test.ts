/**
 * E2E test for state capture in OTEL spans
 * Verifies that check execution captures full state in telemetry
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Helper functions
async function executeVisorCLI(
  args: string[],
  options?: { env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = path.join(process.cwd(), 'dist', 'index.js');
  try {
    const stdout = execFileSync('node', [cliPath, ...args], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: options?.env || process.env,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      exitCode: error.status || 1,
    };
  }
}

async function cleanupTestTraces(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}

describe('State Capture E2E', () => {
  const testOutputDir = path.join(process.cwd(), 'output', 'traces-test-state-capture');
  const tempFixtureDir = path.join(__dirname, '../fixtures', 'temp');
  const configFile = path.join(tempFixtureDir, 'state-capture-test.yaml');

  async function waitForNdjson(
    dir: string,
    timeoutMs = 5000
  ): Promise<{ path: string; content: string }> {
    const start = Date.now();
    // Ensure directory exists to avoid ENOENT when polling
    await fs.mkdir(dir, { recursive: true });
    while (Date.now() - start < timeoutMs) {
      try {
        const files = await fs.readdir(dir);
        const traceFile = files.find(f => f.endsWith('.ndjson'));
        if (traceFile) {
          const p = path.join(dir, traceFile);
          const content = await fs.readFile(p, 'utf-8');
          if (content.trim().length > 0) return { path: p, content };
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for NDJSON in ${dir}`);
  }

  beforeAll(async () => {
    await fs.mkdir(tempFixtureDir, { recursive: true });
    // Create test config
    const testConfig = `
checks:
  simple-command:
    type: command
    exec: |
      echo '{"status": "ok", "count": 42}'

  with-transform:
    type: command
    depends_on: [simple-command]
    exec: |
      echo '{"items": [1, 2, 3]}'
    transform_js: |
      const doubled = output.items.map(x => x * 2);
      return { doubled, prev: outputs["simple-command"] };

  forEach-test:
    type: command
    exec: |
      echo '["apple", "banana", "cherry"]'
    forEach: "{{ output }}"
    children:
      - process-item:
          type: command
          exec: |
            echo "{\"fruit\": \"{{ item }}\", \"length\": {{ item.size }}}"
`;

    await fs.writeFile(configFile, testConfig);
  });

  afterAll(async () => {
    await cleanupTestTraces(testOutputDir);
    try {
      await fs.unlink(configFile);
    } catch {}
    try {
      await fs.rm(tempFixtureDir, { recursive: true, force: true });
    } catch {}
  });

  it('should capture input context in spans', async () => {
    const result = await executeVisorCLI(['--config', configFile, '--check', 'simple-command'], {
      env: {
        ...process.env,
        VISOR_E2E_FORCE_RUN: 'true',
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_TRACE_DIR: testOutputDir,
      },
    });

    expect(result.exitCode).toBe(0);

    // Read the NDJSON trace file (wait for writer flush)
    const { content: traceContent } = await waitForNdjson(testOutputDir);

    const spans = traceContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    // Find span with input context
    const spanWithInput = spans.find(
      s => s.attributes && s.attributes['visor.check.input.context']
    );

    expect(spanWithInput).toBeDefined();

    const inputContext = JSON.parse(spanWithInput!.attributes['visor.check.input.context']);
    expect(inputContext).toHaveProperty('pr');
    expect(inputContext).toHaveProperty('outputs');
    expect(inputContext).toHaveProperty('env');
  });

  it('should capture output in spans', async () => {
    const result = await executeVisorCLI(['--config', configFile, '--check', 'simple-command'], {
      env: {
        ...process.env,
        VISOR_E2E_FORCE_RUN: 'true',
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_TRACE_DIR: testOutputDir,
      },
    });

    expect(result.exitCode).toBe(0);

    const { content: traceContent } = await waitForNdjson(testOutputDir);

    const spans = traceContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    const spanWithOutput = spans.find(s => s.attributes && s.attributes['visor.check.output']);

    expect(spanWithOutput).toBeDefined();

    const output = JSON.parse(spanWithOutput!.attributes['visor.check.output']);
    expect(output).toEqual({ status: 'ok', count: 42 });
  });

  it('should capture transform_js execution', async () => {
    const result = await executeVisorCLI(['--config', configFile, '--check', 'with-transform'], {
      env: {
        ...process.env,
        VISOR_E2E_FORCE_RUN: 'true',
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_TRACE_DIR: testOutputDir,
      },
    });

    expect(result.exitCode).toBe(0);

    const { content: traceContent } = await waitForNdjson(testOutputDir);

    const spans = traceContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    const spanWithTransform = spans.find(s => s.attributes && s.attributes['visor.transform.code']);

    expect(spanWithTransform).toBeDefined();
    expect(spanWithTransform!.attributes['visor.transform.code']).toContain('map');
    expect(spanWithTransform!.attributes['visor.transform.input']).toBeDefined();
    expect(spanWithTransform!.attributes['visor.transform.output']).toBeDefined();
  });

  it('should run acceptance test successfully', async () => {
    // This is the acceptance test from the RFC Milestone 1
    const result = await executeVisorCLI(
      [
        '--config',
        configFile,
        '--check',
        'simple-command',
        '--check',
        'with-transform',
        '--check',
        'forEach-test',
      ],
      {
        env: {
          ...process.env,
          VISOR_E2E_FORCE_RUN: 'true',
          VISOR_TELEMETRY_ENABLED: 'true',
          VISOR_TELEMETRY_SINK: 'file',
          VISOR_TRACE_DIR: testOutputDir,
        },
      }
    );

    expect(result.exitCode).toBe(0);

    // Verify NDJSON contains enhanced attributes
    const { content: traceContent } = await waitForNdjson(testOutputDir);

    const spans = traceContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(s => s.attributes);

    // M1 Success Criteria:
    // ✅ At least one span has `visor.check.input.context` attribute
    const hasInputContext = spans.some(s => s.attributes['visor.check.input.context']);
    expect(hasInputContext).toBe(true);

    // ✅ At least one span has `visor.check.output` attribute
    const hasOutput = spans.some(s => s.attributes['visor.check.output']);
    expect(hasOutput).toBe(true);

    console.log('✅ M1 Acceptance Test Passed!');
    console.log(`   - Found ${spans.length} spans with attributes`);
    console.log(`   - Input context captured: ${hasInputContext}`);
    console.log(`   - Output captured: ${hasOutput}`);
  });
});
