/**
 * Unit tests for time-travel debugging functionality
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { parseNDJSONTrace, ExecutionTrace } from '../../../src/debug-visualizer/trace-reader';
import * as path from 'path';

describe('time-travel debugging', () => {
  let sampleTrace: ExecutionTrace;

  beforeEach(async () => {
    const traceFile = path.join(__dirname, '../../fixtures/traces/sample-trace.ndjson');
    sampleTrace = await parseNDJSONTrace(traceFile);
  });

  describe('timeline navigation', () => {
    it('should have timeline events in chronological order', () => {
      expect(sampleTrace.timeline).toBeDefined();
      expect(sampleTrace.timeline.length).toBeGreaterThan(0);

      // Verify chronological order
      for (let i = 1; i < sampleTrace.timeline.length; i++) {
        const prev = sampleTrace.timeline[i - 1];
        const curr = sampleTrace.timeline[i];

        const prevTime = prev.timestampNanos[0] * 1e9 + prev.timestampNanos[1];
        const currTime = curr.timestampNanos[0] * 1e9 + curr.timestampNanos[1];

        expect(currTime).toBeGreaterThanOrEqual(prevTime);
      }
    });

    it('should include all event types', () => {
      const eventTypes = new Set(sampleTrace.timeline.map((e: any) => e.type));

      expect(eventTypes).toContain('check.started');
      expect(eventTypes).toContain('check.completed');
    });

    it('should have checkId in all timeline events', () => {
      for (const event of sampleTrace.timeline) {
        expect(event.checkId).toBeDefined();
        expect(typeof event.checkId).toBe('string');
      }
    });

    it('should have timestamp in all timeline events', () => {
      for (const event of sampleTrace.timeline) {
        expect(event.timestamp).toBeDefined();
        expect(event.timestampNanos).toBeDefined();
        expect(Array.isArray(event.timestampNanos)).toBe(true);
        expect(event.timestampNanos.length).toBe(2);
      }
    });
  });

  describe('snapshot navigation', () => {
    it('should extract state snapshots', () => {
      expect(sampleTrace.snapshots).toBeDefined();
      expect(Array.isArray(sampleTrace.snapshots)).toBe(true);
    });

    it('should have snapshots in chronological order', () => {
      if (sampleTrace.snapshots.length > 1) {
        for (let i = 1; i < sampleTrace.snapshots.length; i++) {
          const prev = sampleTrace.snapshots[i - 1];
          const curr = sampleTrace.snapshots[i];

          const prevTime = new Date(prev.timestamp).getTime();
          const currTime = new Date(curr.timestamp).getTime();

          expect(currTime).toBeGreaterThanOrEqual(prevTime);
        }
      }
    });

    it('should have checkId and timestamp in snapshots', () => {
      for (const snapshot of sampleTrace.snapshots) {
        expect(snapshot.checkId).toBeDefined();
        expect(snapshot.timestamp).toBeDefined();
      }
    });

    it('should have outputs and memory in snapshots', () => {
      for (const snapshot of sampleTrace.snapshots) {
        expect(snapshot.outputs).toBeDefined();
        expect(snapshot.memory).toBeDefined();
        expect(typeof snapshot.outputs).toBe('object');
        expect(typeof snapshot.memory).toBe('object');
      }
    });
  });

  describe('state reconstruction', () => {
    it('should be able to reconstruct state at any point', () => {
      // Simulate rebuilding state at different timeline indices
      const checkStates = new Map<string, 'pending' | 'running' | 'completed' | 'failed'>();

      // Process events up to middle of timeline
      const midpoint = Math.floor(sampleTrace.timeline.length / 2);
      const eventsUpToMid = sampleTrace.timeline.slice(0, midpoint);

      for (const event of eventsUpToMid) {
        if (!event.checkId) continue;

        if (event.type === 'check.started') {
          checkStates.set(event.checkId, 'running');
        } else if (event.type === 'check.completed') {
          checkStates.set(event.checkId, 'completed');
        } else if (event.type === 'check.failed') {
          checkStates.set(event.checkId, 'failed');
        }
      }

      // At midpoint, we should have some running or completed checks
      expect(checkStates.size).toBeGreaterThan(0);
    });

    it('should track check lifecycle correctly', () => {
      const checkLifecycles = new Map<string, string[]>();

      for (const event of sampleTrace.timeline) {
        if (!event.checkId) continue;

        if (!checkLifecycles.has(event.checkId)) {
          checkLifecycles.set(event.checkId, []);
        }
        checkLifecycles.get(event.checkId)!.push(event.type);
      }

      // Each check should start before it completes/fails
      for (const lifecycle of checkLifecycles.values()) {
        const hasStart = lifecycle.some(t => t === 'check.started');
        const hasEnd = lifecycle.some(t => t === 'check.completed' || t === 'check.failed');

        if (hasEnd) {
          expect(hasStart).toBe(true); // Can't complete without starting
        }

        // Check order: start should come before end
        if (hasStart && hasEnd) {
          const startIndex = lifecycle.findIndex(t => t === 'check.started');
          const endIndex = lifecycle.findIndex(
            t => t === 'check.completed' || t === 'check.failed'
          );
          expect(startIndex).toBeLessThan(endIndex);
        }
      }
    });
  });

  describe('diff computation', () => {
    it('should detect added keys', () => {
      const prev = { a: 1 };
      const curr = { a: 1, b: 2 };

      const changes = computeDiffChanges(prev, curr);
      const addedChanges = changes.filter(c => c.type === 'added');

      expect(addedChanges.length).toBe(1);
      expect(addedChanges[0].key).toBe('b');
    });

    it('should detect removed keys', () => {
      const prev = { a: 1, b: 2 };
      const curr = { a: 1 };

      const changes = computeDiffChanges(prev, curr);
      const removedChanges = changes.filter(c => c.type === 'removed');

      expect(removedChanges.length).toBe(1);
      expect(removedChanges[0].key).toBe('b');
    });

    it('should detect modified values', () => {
      const prev = { a: 1 };
      const curr = { a: 2 };

      const changes = computeDiffChanges(prev, curr);
      const modifiedChanges = changes.filter(c => c.type === 'modified');

      expect(modifiedChanges.length).toBe(1);
      expect(modifiedChanges[0].key).toBe('a');
    });

    it('should handle no changes', () => {
      const prev = { a: 1, b: 'test' };
      const curr = { a: 1, b: 'test' };

      const changes = computeDiffChanges(prev, curr);
      expect(changes.length).toBe(0);
    });

    it('should handle empty objects', () => {
      const prev = {};
      const curr = {};

      const changes = computeDiffChanges(prev, curr);
      expect(changes.length).toBe(0);
    });
  });

  describe('playback simulation', () => {
    it('should be able to step through timeline', () => {
      let currentIndex = 0;

      // Step forward
      currentIndex = Math.min(currentIndex + 1, sampleTrace.timeline.length - 1);
      expect(currentIndex).toBe(1);

      // Step forward again
      currentIndex = Math.min(currentIndex + 1, sampleTrace.timeline.length - 1);
      expect(currentIndex).toBe(2);

      // Step backward
      currentIndex = Math.max(currentIndex - 1, 0);
      expect(currentIndex).toBe(1);
    });

    it('should not go below 0 or above max', () => {
      let currentIndex = 0;

      // Try to step backward from 0
      currentIndex = Math.max(currentIndex - 1, 0);
      expect(currentIndex).toBe(0);

      // Jump to end
      currentIndex = sampleTrace.timeline.length - 1;

      // Try to step forward from end
      currentIndex = Math.min(currentIndex + 1, sampleTrace.timeline.length - 1);
      expect(currentIndex).toBe(sampleTrace.timeline.length - 1);
    });
  });
});

/**
 * Helper function to compute diff between two objects
 * (Mirrors the logic in the UI)
 */
function computeDiffChanges(
  prevOutputs: Record<string, any>,
  currentOutputs: Record<string, any>
): Array<{ type: string; key: string; value?: any; prevValue?: any; currentValue?: any }> {
  const allKeys = new Set([
    ...Object.keys(prevOutputs || {}),
    ...Object.keys(currentOutputs || {}),
  ]);

  const changes = [];

  for (const key of allKeys) {
    const prevValue = prevOutputs?.[key];
    const currentValue = currentOutputs?.[key];

    if (prevValue === undefined && currentValue !== undefined) {
      changes.push({ type: 'added', key, value: currentValue });
    } else if (prevValue !== undefined && currentValue === undefined) {
      changes.push({ type: 'removed', key, value: prevValue });
    } else if (JSON.stringify(prevValue) !== JSON.stringify(currentValue)) {
      changes.push({ type: 'modified', key, prevValue, currentValue });
    }
  }

  return changes;
}
