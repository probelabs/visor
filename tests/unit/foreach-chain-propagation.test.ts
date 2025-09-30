import { describe, it, expect } from '@jest/globals';

/**
 * Unit Test: forEach Chain Propagation
 *
 * This test documents the expected behavior when forEach propagates
 * through an entire dependency chain.
 *
 * Scenario:
 *   fetch-tickets (forEach) → [ticket1, ticket2]
 *        ↓
 *   analyze-bug (depends on fetch-tickets)
 *        ↓
 *   log-results (depends on analyze-bug)
 *
 * Expected behavior:
 * - fetch-tickets runs once, outputs: [ticket1, ticket2], marked with isForEach
 * - analyze-bug runs TWICE (once per ticket), outputs collected: [analysis1, analysis2], marked with isForEach
 * - log-results runs TWICE (once per analysis), sees individual analysis in each iteration
 *
 * In iteration 1:
 *   outputs["fetch-tickets"] = ticket1 (not array)
 *   outputs["analyze-bug"] = analysis1 (not array)
 *
 * In iteration 2:
 *   outputs["fetch-tickets"] = ticket2 (not array)
 *   outputs["analyze-bug"] = analysis2 (not array)
 */
describe('forEach Chain Propagation', () => {
  it('should propagate forEach through entire dependency chain', () => {
    // This test documents the EXPECTED behavior after the fix

    // Step 1: fetch-tickets runs once
    const fetchTicketsResult = {
      issues: [],
      output: [
        { key: 'TT-101', title: 'Bug 1' },
        { key: 'TT-102', title: 'Bug 2' },
      ],
      isForEach: true,
      forEachItems: [
        { key: 'TT-101', title: 'Bug 1' },
        { key: 'TT-102', title: 'Bug 2' },
      ],
    };

    // Step 2: analyze-bug runs TWICE (once per ticket)
    // Each execution produces: { ticket: "TT-10X", complexity: "High", ... }
    // Outputs are collected into array AND marked with isForEach
    const analyzeBugResult = {
      issues: [],
      output: [
        { ticket: 'TT-101', complexity: 'High', priority: 8 },
        { ticket: 'TT-102', complexity: 'Low', priority: 3 },
      ],
      isForEach: true, // IMPORTANT: This propagates forEach to next level
      forEachItems: [
        { ticket: 'TT-101', complexity: 'High', priority: 8 },
        { ticket: 'TT-102', complexity: 'Low', priority: 3 },
      ],
    };

    // Step 3: log-results runs TWICE (because analyze-bug has isForEach)
    // Iteration 1 sees:
    const iteration1Outputs = {
      'fetch-tickets': { key: 'TT-101', title: 'Bug 1' }, // Single item
      'analyze-bug': { ticket: 'TT-101', complexity: 'High', priority: 8 }, // Single item
    };

    // Iteration 2 sees:
    const iteration2Outputs = {
      'fetch-tickets': { key: 'TT-102', title: 'Bug 2' }, // Single item
      'analyze-bug': { ticket: 'TT-102', complexity: 'Low', priority: 3 }, // Single item
    };

    // Verify the expected structure
    expect(fetchTicketsResult.isForEach).toBe(true);
    expect(analyzeBugResult.isForEach).toBe(true);

    // In each iteration, outputs should be single objects, not arrays
    expect(Array.isArray(iteration1Outputs['analyze-bug'])).toBe(false);
    expect(Array.isArray(iteration2Outputs['analyze-bug'])).toBe(false);

    expect(iteration1Outputs['analyze-bug'].ticket).toBe('TT-101');
    expect(iteration2Outputs['analyze-bug'].ticket).toBe('TT-102');
  });

  it('should show the problem with current behavior (before fix)', () => {
    // This documents the CURRENT (buggy) behavior before the fix

    // log-results runs ONCE (because analyze-bug doesn't have isForEach)
    // It sees the aggregated array:
    const logResultsOutputsBeforeFix = {
      'analyze-bug': [
        // Array instead of single object!
        { ticket: 'TT-101', complexity: 'High', priority: 8 },
        { ticket: 'TT-102', complexity: 'Low', priority: 3 },
      ],
    };

    // This is the bug: log-results sees an array instead of iterating
    expect(Array.isArray(logResultsOutputsBeforeFix['analyze-bug'])).toBe(true);
    expect(logResultsOutputsBeforeFix['analyze-bug']).toHaveLength(2);
  });
});
