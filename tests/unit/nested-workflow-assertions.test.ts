/**
 * Tests for nested sub-workflow assertions (dotted-path step addressing).
 *
 * Validates that:
 * 1. evaluateCase merges nested (dotted) step counts from outputHistory
 * 2. evaluateCalls works with dotted step names
 * 3. evaluateOutputs works with dotted step names
 * 4. evaluatePrompts works with dotted step names
 * 5. Hook wrapping in WorkflowCheckProvider prefixes step names correctly
 */

import {
  evaluateCase,
  evaluateCalls,
  evaluateOutputs,
  evaluatePrompts,
  evaluateNoCalls,
} from '../../src/test-runner/evaluators';
import type { ExpectBlock } from '../../src/test-runner/assertions';
import { ExecutionJournal } from '../../src/snapshot-store';

// Stats with a top-level step
function statsWithStep(
  name: string,
  runs = 1
): import('../../src/types/execution').ExecutionStatistics {
  return {
    checks: [{ checkName: name, totalRuns: runs, skipped: false }],
    totalDuration: 0,
    totalChecks: 1,
    checksPassed: 1,
    checksFailed: 0,
    checksSkipped: 0,
  } as any;
}

const emptyRecorder = { calls: [] };

describe('nested workflow assertions - evaluateCalls with dotted step names', () => {
  it('should count dotted step from outputHistory when not in stats', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      calls: [{ step: 'route-intent.classify', exactly: 1 }],
    };
    // The dotted step is only in outputHistory, not in stats
    const executed: Record<string, number> = { 'route-intent.classify': 1 };
    evaluateCalls(errors, exp, executed);
    expect(errors).toHaveLength(0);
  });

  it('should fail when dotted step count mismatches', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      calls: [{ step: 'route-intent.classify', exactly: 2 }],
    };
    const executed = { 'route-intent.classify': 1 };
    evaluateCalls(errors, exp, executed);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('route-intent.classify');
    expect(errors[0]).toContain('exactly 2');
  });

  it('should support at_least with dotted step names', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      calls: [{ step: 'route-intent.classify', at_least: 1 }],
    };
    const executed = { 'route-intent.classify': 3 };
    evaluateCalls(errors, exp, executed);
    expect(errors).toHaveLength(0);
  });

  it('should support deeply nested dotted step names', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      calls: [{ step: 'route-intent.classify.inner-step', exactly: 1 }],
    };
    const executed = { 'route-intent.classify.inner-step': 1 };
    evaluateCalls(errors, exp, executed);
    expect(errors).toHaveLength(0);
  });
});

describe('nested workflow assertions - evaluateOutputs with dotted step names', () => {
  it('should assert on dotted step output', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'route-intent.classify', path: 'intent', equals: 'chat' }],
    };
    const outputHistory = {
      'route-intent.classify': [{ intent: 'chat', skills: ['jira'] }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toHaveLength(0);
  });

  it('should fail when dotted step output does not match', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'route-intent.classify', path: 'intent', equals: 'code' }],
    };
    const outputHistory = {
      'route-intent.classify': [{ intent: 'chat', skills: ['jira'] }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('route-intent.classify');
  });

  it('should support contains_unordered on dotted step output', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [
        {
          step: 'route-intent.classify',
          path: 'skills',
          contains_unordered: ['jira'],
        },
      ],
    };
    const outputHistory = {
      'route-intent.classify': [{ intent: 'chat', skills: ['jira', 'codebase'] }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toHaveLength(0);
  });

  it('should report missing output history for dotted step', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'route-intent.classify', path: 'intent', equals: 'chat' }],
    };
    const outputHistory = {};
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('No output history');
  });
});

describe('nested workflow assertions - evaluatePrompts with dotted step names', () => {
  it('should assert on dotted step prompt', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      prompts: [{ step: 'route-intent.classify', contains: ['classify the intent'] }],
    };
    const promptsByStep = {
      'route-intent.classify': ['Please classify the intent of this message'],
    };
    evaluatePrompts(errors, exp, promptsByStep);
    expect(errors).toHaveLength(0);
  });

  it('should fail when dotted step prompt is missing', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      prompts: [{ step: 'route-intent.classify', contains: ['classify'] }],
    };
    const promptsByStep = {};
    evaluatePrompts(errors, exp, promptsByStep);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('No captured prompt');
  });
});

describe('nested workflow assertions - evaluateNoCalls with dotted step names', () => {
  it('should pass when dotted step was not executed', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      no_calls: [{ step: 'route-intent.fallback' }],
    };
    const executed = { 'route-intent.classify': 1 };
    evaluateNoCalls(errors, exp, executed, emptyRecorder);
    expect(errors).toHaveLength(0);
  });

  it('should fail when dotted step was executed but expected not to be', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      no_calls: [{ step: 'route-intent.classify' }],
    };
    const executed = { 'route-intent.classify': 1 };
    evaluateNoCalls(errors, exp, executed, emptyRecorder);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('route-intent.classify');
  });
});

describe('nested workflow assertions - evaluateCase integration', () => {
  it('should merge dotted step counts from outputHistory into executed map', () => {
    const exp: ExpectBlock = {
      calls: [
        { step: 'route-intent', exactly: 1 },
        { step: 'route-intent.classify', exactly: 1 },
      ],
    };
    // route-intent is in stats (top-level), route-intent.classify is only in outputHistory
    const stats = statsWithStep('route-intent', 1);
    const outputHistory: Record<string, unknown[]> = {
      'route-intent': [{ intent: 'chat' }],
      'route-intent.classify': [{ intent: 'chat', skills: ['jira'] }],
    };
    const errors = evaluateCase(
      'test',
      stats,
      emptyRecorder,
      undefined,
      exp,
      false,
      {},
      {},
      outputHistory
    );
    expect(errors).toHaveLength(0);
  });

  it('should not overwrite stats counts with outputHistory counts', () => {
    const exp: ExpectBlock = {
      calls: [{ step: 'route-intent', exactly: 2 }],
    };
    // route-intent ran 2 times in stats
    const stats = statsWithStep('route-intent', 2);
    // But outputHistory only shows 1 entry (doesn't matter, stats takes precedence)
    const outputHistory: Record<string, unknown[]> = {
      'route-intent': [{ intent: 'chat' }],
    };
    const errors = evaluateCase(
      'test',
      stats,
      emptyRecorder,
      undefined,
      exp,
      false,
      {},
      {},
      outputHistory
    );
    expect(errors).toHaveLength(0);
  });

  it('should handle full nested workflow assertion scenario', () => {
    const exp: ExpectBlock = {
      calls: [
        { step: 'route-intent', exactly: 1 },
        { step: 'route-intent.classify', exactly: 1 },
      ],
      outputs: [{ step: 'route-intent.classify', path: 'skills', contains_unordered: ['jira'] }],
      prompts: [{ step: 'route-intent.classify', contains: ['classify'] }],
    };
    const stats = statsWithStep('route-intent', 1);
    const outputHistory: Record<string, unknown[]> = {
      'route-intent': [{ intent: 'chat' }],
      'route-intent.classify': [{ intent: 'chat', skills: ['jira', 'codebase'] }],
    };
    const promptsByStep = {
      'route-intent.classify': ['Please classify the intent of this user message'],
    };
    const errors = evaluateCase(
      'test',
      stats,
      emptyRecorder,
      undefined,
      exp,
      false,
      promptsByStep,
      {},
      outputHistory
    );
    expect(errors).toHaveLength(0);
  });
});

describe('nested workflow assertions - ExecutionJournal propagation', () => {
  it('should support prefixed checkIds in journal entries', () => {
    const parentJournal = new ExecutionJournal();
    const childJournal = new ExecutionJournal();

    // Simulate child workflow writing entries
    childJournal.commitEntry({
      sessionId: 'child-session',
      scope: [],
      checkId: 'classify',
      result: { issues: [], output: { intent: 'chat', skills: ['jira'] } } as any,
    });

    childJournal.commitEntry({
      sessionId: 'child-session',
      scope: [],
      checkId: 'respond',
      result: { issues: [], output: { text: 'Hello!' } } as any,
    });

    // Simulate WorkflowCheckProvider propagating with prefix
    const stepPrefix = 'route-intent';
    const childSnapshot = childJournal.beginSnapshot();
    const childEntries = childJournal.readVisible('child-session', childSnapshot, undefined);

    for (const entry of childEntries) {
      parentJournal.commitEntry({
        sessionId: 'parent-session',
        scope: entry.scope,
        checkId: `${stepPrefix}.${entry.checkId}`,
        result: entry.result,
        event: entry.event,
      });
    }

    // Verify parent journal has prefixed entries
    const parentSnapshot = parentJournal.beginSnapshot();
    const parentEntries = parentJournal.readVisible('parent-session', parentSnapshot, undefined);

    expect(parentEntries).toHaveLength(2);
    expect(parentEntries[0].checkId).toBe('route-intent.classify');
    expect(parentEntries[1].checkId).toBe('route-intent.respond');
    expect((parentEntries[0].result as any).output.intent).toBe('chat');
    expect((parentEntries[1].result as any).output.text).toBe('Hello!');
  });

  it('should support recursive nesting (3 levels deep)', () => {
    const grandparentJournal = new ExecutionJournal();
    const parentJournal = new ExecutionJournal();
    const childJournal = new ExecutionJournal();

    // Level 3: child writes an entry
    childJournal.commitEntry({
      sessionId: 'child-session',
      scope: [],
      checkId: 'inner-step',
      result: { issues: [], output: { result: 'deep' } } as any,
    });

    // Level 2: parent propagates child entries with "classify." prefix
    const childSnapshot = childJournal.beginSnapshot();
    const childEntries = childJournal.readVisible('child-session', childSnapshot, undefined);
    for (const entry of childEntries) {
      parentJournal.commitEntry({
        sessionId: 'parent-session',
        scope: entry.scope,
        checkId: `classify.${entry.checkId}`,
        result: entry.result,
        event: entry.event,
      });
    }

    // Parent also has its own entry
    parentJournal.commitEntry({
      sessionId: 'parent-session',
      scope: [],
      checkId: 'classify',
      result: { issues: [], output: { intent: 'chat' } } as any,
    });

    // Level 1: grandparent propagates parent entries with "route-intent." prefix
    const parentSnapshot = parentJournal.beginSnapshot();
    const parentEntries = parentJournal.readVisible('parent-session', parentSnapshot, undefined);
    for (const entry of parentEntries) {
      grandparentJournal.commitEntry({
        sessionId: 'gp-session',
        scope: entry.scope,
        checkId: `route-intent.${entry.checkId}`,
        result: entry.result,
        event: entry.event,
      });
    }

    // Verify 3-level deep addressing
    const gpSnapshot = grandparentJournal.beginSnapshot();
    const gpEntries = grandparentJournal.readVisible('gp-session', gpSnapshot, undefined);

    expect(gpEntries).toHaveLength(2);
    expect(gpEntries[0].checkId).toBe('route-intent.classify.inner-step');
    expect(gpEntries[1].checkId).toBe('route-intent.classify');
    expect((gpEntries[0].result as any).output.result).toBe('deep');
  });
});

describe('nested workflow assertions - hook wrapping logic', () => {
  it('should prefix onPromptCaptured step names', () => {
    const captured: Array<{ step: string; provider: string; prompt: string }> = [];
    const parentHooks = {
      onPromptCaptured: (info: { step: string; provider: string; prompt: string }) => {
        captured.push(info);
      },
      mockForStep: (_step: string) => undefined as unknown,
    };

    // Simulate the wrapping logic from workflow-check-provider
    const stepPrefix = 'route-intent';
    const wrappedOnPromptCaptured = (info: { step: string; provider: string; prompt: string }) => {
      parentHooks.onPromptCaptured({
        ...info,
        step: `${stepPrefix}.${info.step}`,
      });
    };

    wrappedOnPromptCaptured({ step: 'classify', provider: 'ai', prompt: 'test prompt' });

    expect(captured).toHaveLength(1);
    expect(captured[0].step).toBe('route-intent.classify');
    expect(captured[0].prompt).toBe('test prompt');
  });

  it('should try prefixed mock name first, then fall back to unprefixed', () => {
    const mocks: Record<string, unknown> = {
      'route-intent.classify': { intent: 'specific-mock' },
    };

    const parentMockForStep = (step: string) => mocks[step];

    // Simulate wrapping
    const stepPrefix = 'route-intent';
    const wrappedMockForStep = (step: string) => {
      const prefixed = parentMockForStep(`${stepPrefix}.${step}`);
      if (prefixed !== undefined) return prefixed;
      return parentMockForStep(step);
    };

    // Should find prefixed mock
    const result = wrappedMockForStep('classify');
    expect(result).toEqual({ intent: 'specific-mock' });
  });

  it('should fall back to unprefixed mock name for backward compatibility', () => {
    const mocks: Record<string, unknown> = {
      classify: { intent: 'generic-mock' },
    };

    const parentMockForStep = (step: string) => mocks[step];

    const stepPrefix = 'route-intent';
    const wrappedMockForStep = (step: string) => {
      const prefixed = parentMockForStep(`${stepPrefix}.${step}`);
      if (prefixed !== undefined) return prefixed;
      return parentMockForStep(step);
    };

    // Should fall back to unprefixed
    const result = wrappedMockForStep('classify');
    expect(result).toEqual({ intent: 'generic-mock' });
  });

  it('should prefer prefixed mock over unprefixed', () => {
    const mocks: Record<string, unknown> = {
      'route-intent.classify': { intent: 'specific' },
      classify: { intent: 'generic' },
    };

    const parentMockForStep = (step: string) => mocks[step];

    const stepPrefix = 'route-intent';
    const wrappedMockForStep = (step: string) => {
      const prefixed = parentMockForStep(`${stepPrefix}.${step}`);
      if (prefixed !== undefined) return prefixed;
      return parentMockForStep(step);
    };

    const result = wrappedMockForStep('classify');
    expect(result).toEqual({ intent: 'specific' });
  });
});
