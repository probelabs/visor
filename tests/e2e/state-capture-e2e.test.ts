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
      env: options?.env || process.env
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      exitCode: error.status || 1
    };
  }
}

async function cleanupTestTraces(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    // Ignore errors if directory doesn't exist
  }
}

describe('State Capture E2E', () => {
  const testOutputDir = path.join(process.cwd(), 'output', 'traces-test-state-capture');
  const configFile = path.join(__dirname, '../fixtures/state-capture-test.yaml');

  beforeAll(async () => {
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

    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, testConfig);
  });

  afterAll(async () => {
    await cleanupTestTraces(testOutputDir);
    try {
      await fs.unlink(configFile);
    } catch {}
  });

  it('should capture input context in spans', async () => {
    const result = await executeVisorCLI([
      '--config',
      configFile,
      '--check',
      'simple-command',
    ], {
      env: {
        ...process.env,
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_TRACE_DIR: testOutputDir,
      },
    });

    expect(result.exitCode).toBe(0);

    // Read the NDJSON trace file
    const files = await fs.readdir(testOutputDir);
    const traceFile = files.find(f => f.endsWith('.ndjson'));
    expect(traceFile).toBeDefined();

    const traceContent = await fs.readFile(
      path.join(testOutputDir, traceFile!),
      'utf-8'
    );

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
    const result = await executeVisorCLI([
      '--config',
      configFile,
      '--check',
      'simple-command',
    ], {
      env: {
        ...process.env,
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_TRACE_DIR: testOutputDir,
      },
    });

    expect(result.exitCode).toBe(0);

    const files = await fs.readdir(testOutputDir);
    const traceFile = files.find(f => f.endsWith('.ndjson'));
    const traceContent = await fs.readFile(
      path.join(testOutputDir, traceFile!),
      'utf-8'
    );

    const spans = traceContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    const spanWithOutput = spans.find(
      s => s.attributes && s.attributes['visor.check.output']
    );

    expect(spanWithOutput).toBeDefined();

    const output = JSON.parse(spanWithOutput!.attributes['visor.check.output']);
    expect(output).toEqual({ status: 'ok', count: 42 });
  });

  it('should capture transform_js execution', async () => {
    const result = await executeVisorCLI([
      '--config',
      configFile,
      '--check',
      'with-transform',
    ], {
      env: {
        ...process.env,
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_TRACE_DIR: testOutputDir,
      },
    });

    expect(result.exitCode).toBe(0);

    const files = await fs.readdir(testOutputDir);
    const traceFile = files.find(f => f.endsWith('.ndjson'));
    const traceContent = await fs.readFile(
      path.join(testOutputDir, traceFile!),
      'utf-8'
    );

    const spans = traceContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    const spanWithTransform = spans.find(
      s => s.attributes && s.attributes['visor.transform.code']
    );

    expect(spanWithTransform).toBeDefined();
    expect(spanWithTransform!.attributes['visor.transform.code']).toContain('map');
    expect(spanWithTransform!.attributes['visor.transform.input']).toBeDefined();
    expect(spanWithTransform!.attributes['visor.transform.output']).toBeDefined();
  });

  it('should run acceptance test successfully', async () => {
    // This is the acceptance test from the RFC Milestone 1
    const result = await executeVisorCLI([
      '--config',
      configFile,
      '--check',
      'all',
    ], {
      env: {
        ...process.env,
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_TRACE_DIR: testOutputDir,
      },
    });

    expect(result.exitCode).toBe(0);

    // Verify NDJSON contains enhanced attributes
    const files = await fs.readdir(testOutputDir);
    const traceFile = files.find(f => f.endsWith('.ndjson'));
    expect(traceFile).toBeDefined();

    const traceContent = await fs.readFile(
      path.join(testOutputDir, traceFile!),
      'utf-8'
    );

    const spans = traceContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(s => s.attributes);

    // M1 Success Criteria:
    // ✅ At least one span has `visor.check.input.context` attribute
    const hasInputContext = spans.some(
      s => s.attributes['visor.check.input.context']
    );
    expect(hasInputContext).toBe(true);

    // ✅ At least one span has `visor.check.output` attribute
    const hasOutput = spans.some(
      s => s.attributes['visor.check.output']
    );
    expect(hasOutput).toBe(true);

    console.log('✅ M1 Acceptance Test Passed!');
    console.log(`   - Found ${spans.length} spans with attributes`);
    console.log(`   - Input context captured: ${hasInputContext}`);
    console.log(`   - Output captured: ${hasOutput}`);
  });
});
