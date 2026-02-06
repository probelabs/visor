/**
 * Unit tests for halt_execution in failure condition evaluator
 */

import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';
import { ReviewSummary } from '../../src/reviewer';

describe('FailureConditionEvaluator halt_execution', () => {
  let evaluator: FailureConditionEvaluator;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();
  });

  it('should detect halt_execution: true in failure_conditions', async () => {
    const reviewSummary: ReviewSummary = {
      issues: [],
      output: { critical: true, error: true },
    } as any;

    const checkConditions = {
      critical_failure: {
        condition: 'output.critical === true',
        message: 'Critical failure detected',
        severity: 'error' as const,
        halt_execution: true,
      },
    };

    const results = await evaluator.evaluateConditions(
      'test-check',
      'code-review',
      'default',
      reviewSummary,
      undefined,
      checkConditions
    );

    expect(results.length).toBe(1);
    expect(results[0].failed).toBe(true);
    expect(results[0].haltExecution).toBe(true);
  });

  it('should not halt when halt_execution: false', async () => {
    const reviewSummary: ReviewSummary = {
      issues: [],
      output: { error: true },
    } as any;

    const checkConditions = {
      non_critical: {
        condition: 'output.error === true',
        message: 'Non-critical error',
        severity: 'warning' as const,
        halt_execution: false,
      },
    };

    const results = await evaluator.evaluateConditions(
      'test-check',
      'code-review',
      'default',
      reviewSummary,
      undefined,
      checkConditions
    );

    expect(results.length).toBe(1);
    expect(results[0].failed).toBe(true);
    expect(results[0].haltExecution).toBe(false);
  });

  it('should return false haltExecution by default when not specified', async () => {
    const reviewSummary: ReviewSummary = {
      issues: [],
      output: { error: true },
    } as any;

    const checkConditions = {
      simple_failure: {
        condition: 'output.error === true',
        message: 'Simple failure',
        // No halt_execution specified
      },
    };

    const results = await evaluator.evaluateConditions(
      'test-check',
      'code-review',
      'default',
      reviewSummary,
      undefined,
      checkConditions
    );

    expect(results.length).toBe(1);
    expect(results[0].failed).toBe(true);
    expect(results[0].haltExecution).toBe(false);
  });

  it('shouldHaltExecution returns true when any condition has haltExecution', () => {
    const results = [
      {
        conditionName: 'a',
        failed: true,
        expression: 'true',
        severity: 'error' as const,
        haltExecution: false,
      },
      {
        conditionName: 'b',
        failed: true,
        expression: 'true',
        severity: 'error' as const,
        haltExecution: true,
      },
      {
        conditionName: 'c',
        failed: false,
        expression: 'false',
        severity: 'warning' as const,
        haltExecution: false,
      },
    ];

    expect(FailureConditionEvaluator.shouldHaltExecution(results)).toBe(true);
  });

  it('shouldHaltExecution returns false when no condition has haltExecution', () => {
    const results = [
      {
        conditionName: 'a',
        failed: true,
        expression: 'true',
        severity: 'error' as const,
        haltExecution: false,
      },
      {
        conditionName: 'b',
        failed: false,
        expression: 'false',
        severity: 'warning' as const,
        haltExecution: true,
      },
    ];

    // Second one has haltExecution but failed=false, so it shouldn't halt
    expect(FailureConditionEvaluator.shouldHaltExecution(results)).toBe(false);
  });
});
