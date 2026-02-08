/**
 * Tests for TraceViewer component
 *
 * Validates that OTEL trace data is parsed correctly and rendered
 * as a proper nested tree structure with inputs/outputs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Sample OTEL spans representing a typical Visor workflow
const sampleSpans = [
  {
    traceId: 'abc123',
    spanId: 'span-root',
    parentSpanId: undefined,
    name: 'visor.run',
    startTime: [1700000000, 0],
    endTime: [1700000005, 0],
    status: { code: 1 },
    attributes: {
      'visor.run.checks_configured': 3,
      'visor.run.source': 'cli',
    },
  },
  {
    traceId: 'abc123',
    spanId: 'span-check1',
    parentSpanId: 'span-root',
    name: 'visor.check.security-review',
    startTime: [1700000001, 0],
    endTime: [1700000002, 500000000],
    status: { code: 1 },
    attributes: {
      'visor.check.id': 'security-review',
      'visor.check.type': 'ai',
      'visor.check.input.keys': 'pr,files,diff',
      'visor.check.output': '{"issues":[],"summary":"No security issues found"}',
    },
  },
  {
    traceId: 'abc123',
    spanId: 'span-check2',
    parentSpanId: 'span-root',
    name: 'visor.check.performance-review',
    startTime: [1700000002, 600000000],
    endTime: [1700000003, 800000000],
    status: { code: 1 },
    attributes: {
      'visor.check.id': 'performance-review',
      'visor.check.type': 'ai',
      'visor.check.input.keys': 'pr,files',
      'visor.check.output.preview': '[{"type":"optimization","desc":"Consider caching"}]',
    },
  },
  {
    traceId: 'abc123',
    spanId: 'span-check3',
    parentSpanId: 'span-root',
    name: 'visor.check.summary',
    startTime: [1700000004, 0],
    endTime: [1700000004, 500000000],
    status: { code: 2 }, // Error status
    attributes: {
      'visor.check.id': 'summary',
      'visor.check.type': 'ai',
      'visor.check.error': 'AI provider timeout',
    },
  },
  // Nested child span
  {
    traceId: 'abc123',
    spanId: 'span-check1-sub',
    parentSpanId: 'span-check1',
    name: 'visor.provider.anthropic',
    startTime: [1700000001, 100000000],
    endTime: [1700000002, 400000000],
    status: { code: 1 },
    attributes: {
      'visor.provider.type': 'anthropic',
      'visor.check.output': 'Analysis complete',
    },
  },
];

describe('TraceViewer', () => {
  let tempDir: string;
  let traceFilePath: string;

  beforeEach(() => {
    // Create temp directory for trace files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-trace-test-'));
    traceFilePath = path.join(tempDir, 'test-trace.ndjson');
  });

  afterEach(() => {
    // Clean up temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function writeTraceFile(spans: any[]): void {
    const ndjson = spans.map(s => JSON.stringify(s)).join('\n');
    fs.writeFileSync(traceFilePath, ndjson, 'utf8');
  }

  describe('parseTraceFile', () => {
    it('should parse NDJSON trace file correctly', async () => {
      writeTraceFile(sampleSpans);

      // Import the parseNDJSONTrace function from trace-reader
      const { parseNDJSONTrace } = await import('../../../src/debug-visualizer/trace-reader');

      const trace = await parseNDJSONTrace(traceFilePath);

      expect(trace.spans.length).toBe(5);
      expect(trace.tree).toBeDefined();
      expect(trace.tree.checkId).toBe('span-root');
    });

    it('should build correct parent-child tree structure', async () => {
      writeTraceFile(sampleSpans);

      const { parseNDJSONTrace } = await import('../../../src/debug-visualizer/trace-reader');

      const trace = await parseNDJSONTrace(traceFilePath);
      const tree = trace.tree;

      // Root should have 3 direct children
      expect(tree.children.length).toBe(3);

      // Find security-review check by its visor.check.id (should have 1 child - the provider span)
      const securityCheck = tree.children.find(c => c.checkId === 'security-review');
      expect(securityCheck).toBeDefined();
      expect(securityCheck!.children.length).toBe(1);
      // Provider span doesn't have visor.check.id, so falls back to spanId
      expect(securityCheck!.children[0].checkId).toBe('span-check1-sub');

      // Performance check should have no children
      const perfCheck = tree.children.find(c => c.checkId === 'performance-review');
      expect(perfCheck).toBeDefined();
      expect(perfCheck!.children.length).toBe(0);
    });

    it('should extract input/output attributes', async () => {
      writeTraceFile(sampleSpans);

      const { parseNDJSONTrace } = await import('../../../src/debug-visualizer/trace-reader');

      const trace = await parseNDJSONTrace(traceFilePath);

      // Find security-review span
      const securitySpan = trace.spans.find(
        s => s.attributes['visor.check.id'] === 'security-review'
      );
      expect(securitySpan).toBeDefined();
      expect(securitySpan!.attributes['visor.check.input.keys']).toBe('pr,files,diff');
      expect(securitySpan!.attributes['visor.check.output']).toContain('No security issues');
    });

    it('should identify error spans', async () => {
      writeTraceFile(sampleSpans);

      const { parseNDJSONTrace } = await import('../../../src/debug-visualizer/trace-reader');

      const trace = await parseNDJSONTrace(traceFilePath);

      // Find summary span (which has error status)
      const summarySpan = trace.spans.find(s => s.attributes['visor.check.id'] === 'summary');
      expect(summarySpan).toBeDefined();
      expect(summarySpan!.status).toBe('error');
    });
  });

  describe('tree visualization', () => {
    it('should produce nested ASCII tree output', async () => {
      writeTraceFile(sampleSpans);

      const { parseNDJSONTrace } = await import('../../../src/debug-visualizer/trace-reader');

      const trace = await parseNDJSONTrace(traceFilePath);
      const tree = trace.tree;

      // Verify tree depth
      expect(tree.children.length).toBeGreaterThan(0);

      // Verify nested child exists (security-review should have provider child)
      const securityCheck = tree.children.find((c: any) => c.checkId === 'security-review');
      expect(securityCheck).toBeDefined();
      expect(securityCheck!.children.length).toBe(1);

      // Generate ASCII representation (simplified check)
      const lines: string[] = [];
      const renderNode = (node: any, prefix: string, isLast: boolean) => {
        const branch = isLast ? '└── ' : '├── ';
        lines.push(`${prefix}${branch}${node.checkId}`);
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        node.children.forEach((child: any, i: number) => {
          renderNode(child, childPrefix, i === node.children.length - 1);
        });
      };
      renderNode(tree, '', true);

      // Verify indentation is present (nested structure)
      const hasIndentation = lines.some(l => l.includes('│   ') || l.includes('    └'));
      expect(hasIndentation).toBe(true);

      // Verify the tree contains the expected structure
      expect(lines.join('\n')).toContain('security-review');
      expect(lines.join('\n')).toContain('span-check1-sub'); // The nested provider span

      // Log for debugging
      console.log('Tree output:');
      console.log(lines.join('\n'));
    });
  });
});
