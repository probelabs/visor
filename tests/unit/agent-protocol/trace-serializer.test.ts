import {
  renderSpanYaml,
  findTraceFile,
  serializeTraceForPrompt,
} from '../../../src/agent-protocol/trace-serializer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Helper: create normalized spans (OTLP/Jaeger format used by YAML renderer)
// ---------------------------------------------------------------------------

function makeSpan(overrides: Record<string, any> = {}) {
  return {
    traceId: overrides.traceId || 't1',
    spanId: overrides.spanId || 'span-001',
    parentSpanId: overrides.parentSpanId,
    name: overrides.name || 'test-span',
    startTimeMs: overrides.startTimeMs || 1000000,
    endTimeMs: overrides.endTimeMs || 1001000,
    durationMs: overrides.durationMs || 1000,
    attributes: overrides.attributes || {},
    events: overrides.events || [],
    status: (overrides.status || 'ok') as 'ok' | 'error',
  };
}

function makeTree(spanOverrides: Record<string, any> = {}, children: any[] = []) {
  return {
    span: makeSpan(spanOverrides),
    children,
  };
}

// ---------------------------------------------------------------------------
// renderSpanYaml
// ---------------------------------------------------------------------------

describe('renderSpanYaml', () => {
  it('renders visor.run with trace_id and duration', () => {
    const tree = makeTree({ name: 'visor.run', traceId: 'abc123', durationMs: 5000 });
    const result = renderSpanYaml(tree, [tree.span]);
    expect(result).toContain('visor.run:');
    expect(result).toContain('trace_id: abc123');
    expect(result).toContain('duration: 5.0s');
  });

  it('renders visor.run with version and source attributes', () => {
    const tree = makeTree({
      name: 'visor.run',
      durationMs: 5000,
      attributes: {
        'visor.version': '1.2.3',
        'visor.run.source': 'slack',
        'slack.user_id': 'U12345',
      },
    });
    const result = renderSpanYaml(tree, [tree.span]);
    expect(result).toContain('visor: 1.2.3');
    expect(result).toContain('source: slack');
    expect(result).toContain('slack_user: U12345');
  });

  it('renders checks with type and duration as nested attributes', () => {
    const check = makeTree({
      name: 'visor.check.my-check',
      spanId: 's2',
      parentSpanId: 's1',
      durationMs: 2000,
      attributes: { 'visor.check.id': 'my-check', 'visor.check.type': 'ai' },
    });
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 5000 }, [check]);
    const allSpans = [root.span, check.span];
    const result = renderSpanYaml(root, allSpans);

    expect(result).toContain('my-check:');
    expect(result).toContain('type: ai');
    expect(result).toContain('duration: 2.0s');
    // Should NOT have old format like "my-check [ai] — 2.0s"
    expect(result).not.toContain('[ai]');
    expect(result).not.toContain('my-check [');
  });

  it('renders tool calls with input and result size', () => {
    const tool = makeTree({
      name: 'probe.event.tool.result',
      spanId: 's3',
      parentSpanId: 's1',
      durationMs: 300,
      attributes: {
        'tool.name': 'search_code',
        'tool.input': 'auth middleware',
        'tool.result.length': 1500,
      },
    });
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 1000 }, [tool]);
    const result = renderSpanYaml(root, [root.span, tool.span]);

    expect(result).toContain('search_code(auth middleware)');
    expect(result).toContain('1.5k chars');
  });

  it('renders AI request with model and token info', () => {
    const ai = makeTree({
      name: 'ai.request',
      spanId: 's2',
      parentSpanId: 's1',
      durationMs: 2000,
      attributes: {
        'gen_ai.request.model': 'gemini-2.5-pro',
        'gen_ai.usage.input_tokens': 1200,
        'gen_ai.usage.output_tokens': 45,
      },
    });
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 3000 }, [ai]);
    const result = renderSpanYaml(root, [root.span, ai.span]);

    expect(result).toContain('gemini-2.5-pro');
    expect(result).toContain('1200 in');
    expect(result).toContain('45 out');
  });

  it('marks error spans', () => {
    const check = makeTree({
      name: 'visor.check.broken',
      spanId: 's2',
      parentSpanId: 's1',
      durationMs: 100,
      status: 'error',
      attributes: { 'visor.check.id': 'broken', 'visor.check.type': 'ai' },
    });
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 500 }, [check]);
    const result = renderSpanYaml(root, [root.span, check.span]);
    expect(result).toContain('✗');
  });

  it('renders check output after children', () => {
    const check = makeTree({
      name: 'visor.check.my-check',
      spanId: 's2',
      parentSpanId: 's1',
      durationMs: 1000,
      attributes: {
        'visor.check.id': 'my-check',
        'visor.check.type': 'script',
        'visor.check.output': '{"result":"done","count":5}',
      },
    });
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 2000 }, [check]);
    const result = renderSpanYaml(root, [root.span, check.span]);

    expect(result).toContain('output:');
    expect(result).toContain('result: done');
    expect(result).toContain('count: 5');
  });

  it('renders AI output from parent check span', () => {
    const ai = makeTree({
      name: 'ai.request',
      spanId: 's3',
      parentSpanId: 's2',
      durationMs: 800,
      attributes: { 'ai.model': 'gemini-pro' },
    });
    const check = makeTree(
      {
        name: 'visor.check.classify',
        spanId: 's2',
        parentSpanId: 's1',
        durationMs: 1000,
        attributes: {
          'visor.check.id': 'classify',
          'visor.check.type': 'ai',
          'visor.check.output': '{"intent":"chat","topic":"How does auth work?"}',
        },
      },
      [ai]
    );
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 2000 }, [check]);
    const result = renderSpanYaml(root, [root.span, check.span, ai.span]);

    // AI block should show the parent check's output
    expect(result).toContain('intent: chat');
    expect(result).toContain('topic: How does auth work?');
  });

  it('handles truncated JSON output via tolerant parser', () => {
    const check = makeTree({
      name: 'visor.check.explore',
      spanId: 's2',
      parentSpanId: 's1',
      durationMs: 5000,
      attributes: {
        'visor.check.id': 'explore',
        'visor.check.type': 'ai',
        // Truncated JSON — missing closing braces/quotes
        'visor.check.output':
          '{"answer":{"text":"This config option sets the timeout for HTTP connections to the Dashboard. It defaults to 30 sec',
      },
    });
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 6000 }, [check]);
    const result = renderSpanYaml(root, [root.span, check.span]);

    // Should still extract and display the truncated content (unwraps {answer:{text:...}})
    expect(result).toContain('timeout');
  });

  it('renders search.delegate with query and children', () => {
    const tool = makeTree({
      name: 'probe.event.tool.result',
      spanId: 's4',
      parentSpanId: 's3',
      durationMs: 100,
      attributes: { 'tool.name': 'search', 'tool.result.length': 5000 },
    });
    const delegateAi = makeTree(
      {
        name: 'ai.request',
        spanId: 's3',
        parentSpanId: 's2',
        durationMs: 10000,
        attributes: { 'ai.model': 'gemini-flash' },
      },
      [tool]
    );
    const delegate = makeTree(
      {
        name: 'search.delegate',
        spanId: 's2',
        parentSpanId: 's1',
        durationMs: 12000,
        attributes: { 'search.query': 'auth middleware' },
      },
      [delegateAi]
    );
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 15000 }, [delegate]);
    const result = renderSpanYaml(root, [root.span, delegate.span, delegateAi.span, tool.span]);

    expect(result).toContain('search.delegate("auth middleware")');
    expect(result).toContain('gemini-flash');
    expect(result).toContain('search()');
    expect(result).toContain('5.0k chars');
  });

  it('does not truncate the YAML output', () => {
    // Create a tree that produces long output
    const children = [];
    for (let i = 0; i < 20; i++) {
      children.push(
        makeTree({
          name: `visor.check.check-${i}`,
          spanId: `c${i}`,
          parentSpanId: 's1',
          durationMs: 100 + i * 10,
          attributes: {
            'visor.check.id': `check-${i}`,
            'visor.check.type': 'script',
            'visor.check.output': `{"result":"value-${i}","data":"some longer text to pad the output"}`,
          },
        })
      );
    }
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 10000 }, children);
    const allSpans = [root.span, ...children.map(c => c.span)];
    const result = renderSpanYaml(root, allSpans);

    // Should NOT be truncated
    expect(result).not.toContain('truncated');
    // Should contain the last check
    expect(result).toContain('check-19');
  });

  it('deduplicates identical outputs across checks', () => {
    const check1 = makeTree({
      name: 'visor.check.first',
      spanId: 's2',
      parentSpanId: 's1',
      durationMs: 1000,
      attributes: {
        'visor.check.id': 'first',
        'visor.check.type': 'script',
        'visor.check.output': '{"result":"shared value","count":42}',
      },
    });
    const check2 = makeTree({
      name: 'visor.check.second',
      spanId: 's3',
      parentSpanId: 's1',
      durationMs: 500,
      attributes: {
        'visor.check.id': 'second',
        'visor.check.type': 'script',
        'visor.check.output': '{"result":"shared value","count":42}',
      },
    });
    const root = makeTree({ name: 'visor.run', spanId: 's1', durationMs: 2000 }, [check1, check2]);
    const result = renderSpanYaml(root, [root.span, check1.span, check2.span]);

    // Second occurrence should reference the first
    expect(result).toContain('= first');
  });
});

// ---------------------------------------------------------------------------
// findTraceFile
// ---------------------------------------------------------------------------

describe('findTraceFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-trace-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds a trace file by matching traceId', async () => {
    const traceId = 'abc123def456';
    const content = JSON.stringify({ traceId, spanId: 's1', name: 'visor.run' }) + '\n';
    fs.writeFileSync(path.join(tmpDir, 'run1.ndjson'), content);

    const result = await findTraceFile(traceId, tmpDir);
    expect(result).toBe(path.join(tmpDir, 'run1.ndjson'));
  });

  it('returns null when no matching trace found', async () => {
    const content = JSON.stringify({ traceId: 'other', spanId: 's1' }) + '\n';
    fs.writeFileSync(path.join(tmpDir, 'run1.ndjson'), content);

    const result = await findTraceFile('nonexistent', tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when directory does not exist', async () => {
    const result = await findTraceFile('abc', '/tmp/nonexistent-trace-dir-xyz');
    expect(result).toBeNull();
  });

  it('skips malformed NDJSON files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.ndjson'), 'not-json\n');
    const content = JSON.stringify({ traceId: 'target', spanId: 's1' }) + '\n';
    fs.writeFileSync(path.join(tmpDir, 'good.ndjson'), content);

    const result = await findTraceFile('target', tmpDir);
    expect(result).toBe(path.join(tmpDir, 'good.ndjson'));
  });
});

// ---------------------------------------------------------------------------
// serializeTraceForPrompt (integration with trace-reader)
// ---------------------------------------------------------------------------

describe('serializeTraceForPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-trace-ser-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces YAML output from a valid NDJSON trace file', async () => {
    const spans = [
      {
        traceId: 't1',
        spanId: 's1',
        name: 'visor.run',
        startTime: [1000, 0],
        endTime: [1005, 0],
        attributes: {},
        events: [],
        status: { code: 0 },
      },
      {
        traceId: 't1',
        spanId: 's2',
        parentSpanId: 's1',
        name: 'visor.check',
        startTime: [1001, 0],
        endTime: [1003, 0],
        attributes: { 'visor.check.id': 'my-check', 'visor.check.type': 'ai' },
        events: [],
        status: { code: 0 },
      },
    ];
    const filePath = path.join(tmpDir, 'test.ndjson');
    fs.writeFileSync(filePath, spans.map(s => JSON.stringify(s)).join('\n') + '\n');

    const result = await serializeTraceForPrompt(filePath);
    expect(result).toContain('visor.run:');
    expect(result).toContain('my-check:');
    expect(result).toContain('type: ai');
    expect(typeof result).toBe('string');
  });
});
