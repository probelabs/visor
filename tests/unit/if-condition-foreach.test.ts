import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';
import { ReviewSummary } from '../../src/reviewer';

describe('If condition with forEach outputs', () => {
  let evaluator: FailureConditionEvaluator;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();
  });

  describe('forEach output unwrapping', () => {
    it('should unwrap output field from forEach checks', async () => {
      // Create a forEach check result with nested structure
      const forEachResult = {
        issues: [],
        output: [
          { key: 'TICKET-1', priority: 'high', issueType: 'Bug' },
          { key: 'TICKET-2', priority: 'low', issueType: 'Feature' },
        ],
        forEachItems: [
          { key: 'TICKET-1', priority: 'high', issueType: 'Bug' },
          { key: 'TICKET-2', priority: 'low', issueType: 'Feature' },
        ],
        isForEach: true,
      } as ReviewSummary & { output: unknown; forEachItems: unknown; isForEach: boolean };

      const previousResults = new Map<string, ReviewSummary>();
      previousResults.set('fetch-tickets', forEachResult);

      // Test accessing the unwrapped output directly
      const shouldRunForBugs = await evaluator.evaluateIfCondition(
        'analyze-bugs',
        'outputs["fetch-tickets"][0].issueType === "Bug"',
        {
          branch: 'main',
          previousResults,
        }
      );

      expect(shouldRunForBugs).toBe(true);

      // Test that we get the array directly, not the wrapper
      const hasMultipleTickets = await evaluator.evaluateIfCondition(
        'process-tickets',
        'outputs["fetch-tickets"].length === 2',
        {
          branch: 'main',
          previousResults,
        }
      );

      expect(hasMultipleTickets).toBe(true);

      // Test accessing specific properties
      const hasHighPriority = await evaluator.evaluateIfCondition(
        'high-priority-check',
        'outputs["fetch-tickets"].some(t => t.priority === "high")',
        {
          branch: 'main',
          previousResults,
        }
      );

      expect(hasHighPriority).toBe(true);
    });

    it('should handle non-forEach outputs normally', async () => {
      // Create a regular check result without forEach
      const regularResult = {
        issues: [{ file: 'test.js', line: 1, severity: 'error', message: 'Test error' }],
      } as ReviewSummary;

      const previousResults = new Map<string, ReviewSummary>();
      previousResults.set('regular-check', regularResult);

      // Should expose the full ReviewSummary when no output field exists
      const hasIssues = await evaluator.evaluateIfCondition(
        'follow-up-check',
        'outputs["regular-check"].issues.length > 0',
        {
          branch: 'main',
          previousResults,
        }
      );

      expect(hasIssues).toBe(true);
    });

    it('should handle custom output fields', async () => {
      // Create a check with custom output field
      const customResult = {
        issues: [],
        output: {
          apiResponse: { status: 'success', data: [1, 2, 3] },
          customField: 'custom value',
        },
      } as ReviewSummary & { output: unknown };

      const previousResults = new Map<string, ReviewSummary>();
      previousResults.set('api-check', customResult);

      // Should access the custom output directly
      const isSuccess = await evaluator.evaluateIfCondition(
        'process-api',
        'outputs["api-check"].apiResponse.status === "success"',
        {
          branch: 'main',
          previousResults,
        }
      );

      expect(isSuccess).toBe(true);

      // Test accessing nested data
      const hasData = await evaluator.evaluateIfCondition(
        'validate-data',
        'outputs["api-check"].apiResponse.data.length === 3',
        {
          branch: 'main',
          previousResults,
        }
      );

      expect(hasData).toBe(true);
    });

    it('should use log function to debug outputs', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const forEachResult = {
        issues: [],
        output: ['item1', 'item2'],
        forEachItems: ['item1', 'item2'],
        isForEach: true,
      } as ReviewSummary & { output: unknown; forEachItems: unknown; isForEach: boolean };

      const previousResults = new Map<string, ReviewSummary>();
      previousResults.set('test-check', forEachResult);

      await evaluator.evaluateIfCondition(
        'debug-check',
        'log("Outputs:", outputs); log("Test check output:", outputs["test-check"]); true',
        {
          branch: 'main',
          previousResults,
        }
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        '🔍 Debug:',
        'Outputs:',
        expect.objectContaining({
          'test-check': ['item1', 'item2'],
        })
      );
      expect(consoleSpy).toHaveBeenCalledWith('🔍 Debug:', 'Test check output:', [
        'item1',
        'item2',
      ]);

      consoleSpy.mockRestore();
    });
  });
});
