/**
 * Unit tests for trace-reader.ts
 *
 * Tests NDJSON parsing, tree building, snapshot extraction, and timeline generation
 */

import * as path from 'path';
import {
  parseNDJSONTrace,
  buildExecutionTree,
  extractStateSnapshots,
  ProcessedSpan,
  ExecutionNode,
} from '../../../src/debug-visualizer/trace-reader';

describe('trace-reader', () => {
  const fixturesDir = path.join(__dirname, '../../fixtures/traces');

  // =========================================================================
  // parseNDJSONTrace Tests
  // =========================================================================

  describe('parseNDJSONTrace', () => {
    it('should parse valid NDJSON trace file', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      expect(trace).toBeDefined();
      expect(trace.spans).toHaveLength(4); // 1 root + 3 checks
      expect(trace.tree).toBeDefined();
      expect(trace.timeline).toBeDefined();
      expect(trace.snapshots).toBeDefined();
      expect(trace.metadata).toBeDefined();
    });

    it('should extract correct metadata', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      expect(trace.metadata.totalSpans).toBe(4);
      expect(trace.metadata.totalSnapshots).toBe(3);
      expect(trace.metadata.duration).toBeGreaterThan(0);
      expect(trace.metadata.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(trace.metadata.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should parse spans with all attributes', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const checkSpan = trace.spans.find(s => s.attributes['visor.check.id'] === 'fetch-data');
      expect(checkSpan).toBeDefined();
      expect(checkSpan!.name).toBe('visor.check');
      expect(checkSpan!.attributes['visor.check.type']).toBe('command');
      expect(checkSpan!.attributes['visor.check.input.context']).toBeDefined();
      expect(checkSpan!.attributes['visor.check.output']).toBeDefined();
    });

    it('should handle error spans', async () => {
      const tracePath = path.join(fixturesDir, 'error-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      // Find the check span with error status (not the root span)
      const errorSpan = trace.spans.find(s => s.status === 'error' && s.name === 'visor.check');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.attributes['visor.check.error']).toBe('Command failed with exit code 1');
    });

    it('should throw error on empty trace file', async () => {
      const tracePath = path.join(fixturesDir, 'empty-trace.ndjson');
      await expect(parseNDJSONTrace(tracePath)).rejects.toThrow('No valid spans found');
    });

    it('should handle malformed JSON lines gracefully', async () => {
      const tracePath = path.join(fixturesDir, 'malformed-trace.ndjson');

      // Create malformed trace for this test
      const fs = require('fs');
      fs.writeFileSync(
        tracePath,
        '{"traceId":"test","spanId":"span1","name":"visor.run","startTime":[1697547296,0],"endTime":[1697547297,0],"attributes":{},"events":[],"status":{"code":1}}\n' +
          'INVALID JSON LINE\n' +
          '{"traceId":"test","spanId":"span2","parentSpanId":"span1","name":"visor.check","startTime":[1697547296,500000000],"endTime":[1697547297,0],"attributes":{"visor.check.id":"check1"},"events":[],"status":{"code":1}}\n'
      );

      const trace = await parseNDJSONTrace(tracePath);
      expect(trace.spans).toHaveLength(2); // Should skip malformed line

      // Cleanup
      fs.unlinkSync(tracePath);
    });
  });

  // =========================================================================
  // buildExecutionTree Tests
  // =========================================================================

  describe('buildExecutionTree', () => {
    it('should build correct parent-child hierarchy', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const tree = trace.tree;
      expect(tree.type).toBe('run');
      expect(tree.children).toHaveLength(3); // 3 checks under root
    });

    it('should correctly identify node types', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const tree = trace.tree;
      expect(tree.type).toBe('run');

      const checkNode = tree.children.find(n => n.checkId === 'fetch-data');
      expect(checkNode).toBeDefined();
      expect(checkNode!.type).toBe('check');
    });

    it('should extract state from span attributes', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const securityCheck = trace.tree.children.find(n => n.checkId === 'security-scan');
      expect(securityCheck).toBeDefined();
      expect(securityCheck!.state.inputContext).toBeDefined();
      expect(securityCheck!.state.output).toBeDefined();
      expect(securityCheck!.state.metadata).toBeDefined();
    });

    it('should handle error status correctly', async () => {
      const tracePath = path.join(fixturesDir, 'error-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const errorCheck = trace.tree.children.find(n => n.checkId === 'failing-check');
      expect(errorCheck).toBeDefined();
      expect(errorCheck!.status).toBe('error');
      expect(errorCheck!.state.errors).toBeDefined();
      expect(errorCheck!.state.errors).toContain('Command failed with exit code 1');
    });

    it('should parse JSON attributes correctly', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const fetchCheck = trace.tree.children.find(n => n.checkId === 'fetch-data');
      expect(fetchCheck).toBeDefined();

      // Should parse JSON output
      expect(fetchCheck!.state.output).toEqual({
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      });

      // Should parse JSON input context
      expect(fetchCheck!.state.inputContext).toHaveProperty('pr');
      expect(fetchCheck!.state.inputContext.pr.number).toBe(123);
    });

    it('should handle orphaned spans', () => {
      const orphanedSpans: ProcessedSpan[] = [
        {
          traceId: 'test',
          spanId: 'child1',
          parentSpanId: 'non-existent-parent',
          name: 'visor.check',
          startTime: [1000, 0],
          endTime: [1001, 0],
          duration: 1000,
          attributes: { 'visor.check.id': 'orphan' },
          events: [],
          status: 'ok',
        },
      ];

      const tree = buildExecutionTree(orphanedSpans);

      // Should create synthetic root
      expect(tree.checkId).toBe('synthetic-root');
      expect(tree.type).toBe('run');
    });
  });

  // =========================================================================
  // extractStateSnapshots Tests
  // =========================================================================

  describe('extractStateSnapshots', () => {
    it('should extract all state snapshots', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const snapshots = trace.snapshots;
      expect(snapshots).toHaveLength(3); // One per check
    });

    it('should sort snapshots chronologically', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const snapshots = trace.snapshots;
      for (let i = 1; i < snapshots.length; i++) {
        const prevTime = new Date(snapshots[i - 1].timestamp).getTime();
        const currTime = new Date(snapshots[i].timestamp).getTime();
        expect(currTime).toBeGreaterThanOrEqual(prevTime);
      }
    });

    it('should parse snapshot attributes correctly', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const firstSnapshot = trace.snapshots[0];
      expect(firstSnapshot.checkId).toBe('fetch-data');
      expect(firstSnapshot.outputs).toBeDefined();
      expect(firstSnapshot.memory).toBeDefined();
      expect(firstSnapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle missing snapshot data gracefully', () => {
      const spansWithoutSnapshots: ProcessedSpan[] = [
        {
          traceId: 'test',
          spanId: 'span1',
          name: 'visor.check',
          startTime: [1000, 0],
          endTime: [1001, 0],
          duration: 1000,
          attributes: { 'visor.check.id': 'check1' },
          events: [], // No snapshot events
          status: 'ok',
        },
      ];

      const snapshots = extractStateSnapshots(spansWithoutSnapshots);
      expect(snapshots).toHaveLength(0);
    });

    it('should extract outputs and memory from snapshots', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const snapshot = trace.snapshots.find(s => s.checkId === 'security-scan');
      expect(snapshot).toBeDefined();
      expect(snapshot!.outputs).toHaveProperty('fetch-data');
      expect(snapshot!.outputs).toHaveProperty('security-scan');
    });
  });

  // =========================================================================
  // computeTimeline Tests
  // =========================================================================

  describe('computeTimeline', () => {
    it('should generate timeline events for all spans', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const timeline = trace.timeline;

      // Should have: started + completed events for each span + snapshot events
      // 4 spans × 2 events + 3 snapshots = at least 11 events
      expect(timeline.length).toBeGreaterThanOrEqual(11);
    });

    it('should sort events chronologically', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const timeline = trace.timeline;
      for (let i = 1; i < timeline.length; i++) {
        const prevTime = new Date(timeline[i - 1].timestamp).getTime();
        const currTime = new Date(timeline[i].timestamp).getTime();
        expect(currTime).toBeGreaterThanOrEqual(prevTime);
      }
    });

    it('should include check.started and check.completed events', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const timeline = trace.timeline;
      const startedEvents = timeline.filter(e => e.type === 'check.started');
      const completedEvents = timeline.filter(e => e.type === 'check.completed');

      expect(startedEvents.length).toBeGreaterThan(0);
      expect(completedEvents.length).toBeGreaterThan(0);
    });

    it('should include state.snapshot events', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const timeline = trace.timeline;
      const snapshotEvents = timeline.filter(e => e.type === 'state.snapshot');

      expect(snapshotEvents).toHaveLength(3);
    });

    it('should include check.failed events for errors', async () => {
      const tracePath = path.join(fixturesDir, 'error-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const timeline = trace.timeline;
      const failedEvents = timeline.filter(e => e.type === 'check.failed');

      expect(failedEvents.length).toBeGreaterThan(0);
    });

    it('should include duration in completion events', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const completedEvent = trace.timeline.find(
        e => e.type === 'check.completed' && e.checkId === 'fetch-data'
      );

      expect(completedEvent).toBeDefined();
      expect(completedEvent!.duration).toBeGreaterThan(0);
    });

    it('should include metadata in events', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      const startedEvent = trace.timeline.find(
        e => e.type === 'check.started' && e.checkId === 'security-scan'
      );

      expect(startedEvent).toBeDefined();
      expect(startedEvent!.metadata).toBeDefined();
      expect(startedEvent!.metadata?.type).toBe('ai');
    });
  });

  // =========================================================================
  // Integration Tests
  // =========================================================================

  describe('Integration', () => {
    it('should handle complete trace end-to-end', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      // Verify all components work together
      expect(trace.spans.length).toBe(4);
      expect(trace.tree.children.length).toBe(3);
      expect(trace.snapshots.length).toBe(3);
      expect(trace.timeline.length).toBeGreaterThan(0);

      // Verify tree contains all checks
      const checkIds = trace.tree.children.map(n => n.checkId);
      expect(checkIds).toContain('fetch-data');
      expect(checkIds).toContain('security-scan');
      expect(checkIds).toContain('performance-check');

      // Verify snapshots reference correct checks
      const snapshotCheckIds = trace.snapshots.map(s => s.checkId);
      expect(snapshotCheckIds).toContain('fetch-data');
      expect(snapshotCheckIds).toContain('security-scan');
      expect(snapshotCheckIds).toContain('performance-check');

      // Verify timeline completeness
      const timelineCheckIds = new Set(trace.timeline.filter(e => e.checkId).map(e => e.checkId));
      expect(timelineCheckIds.size).toBeGreaterThan(0);
    });

    it('should maintain referential integrity', async () => {
      const tracePath = path.join(fixturesDir, 'sample-trace.ndjson');
      const trace = await parseNDJSONTrace(tracePath);

      // Every child node's span should exist in the spans array
      function verifyNode(node: ExecutionNode) {
        const spanExists = trace.spans.some(s => s.spanId === node.span.spanId);
        expect(spanExists).toBe(true);

        for (const child of node.children) {
          verifyNode(child);
        }
      }

      verifyNode(trace.tree);
    });
  });
});
