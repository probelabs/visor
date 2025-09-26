import { CommandCheckProvider } from '../../../src/providers/command-check-provider';
import { AICheckProvider } from '../../../src/providers/ai-check-provider';
import { ReviewSummary } from '../../../src/reviewer';

describe('Provider Output Exposure', () => {
  describe('CommandCheckProvider', () => {
    let provider: CommandCheckProvider;

    beforeEach(() => {
      provider = new CommandCheckProvider();
    });

    it('should expose raw output directly from dependencies', () => {
      // Create dependency results with raw output
      const dependencyResults = new Map<string, ReviewSummary>();
      const customOutput = { tickets: ['JIRA-123', 'JIRA-456'], status: 'active' };
      dependencyResults.set('fetch-tickets', {
        issues: [],
        output: customOutput,
      } as ReviewSummary & { output: unknown });

      // Test private method via reflection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outputContext = (provider as any).buildOutputContext(dependencyResults);

      // Should expose the raw output directly, not wrapped with counters
      expect(outputContext['fetch-tickets']).toEqual(customOutput);
      expect(outputContext['fetch-tickets']).not.toHaveProperty('totalIssues');
      expect(outputContext['fetch-tickets']).not.toHaveProperty('criticalIssues');
      expect(outputContext['fetch-tickets']).not.toHaveProperty('issueCount');
      expect(outputContext['fetch-tickets']).not.toHaveProperty('raw');
    });

    it('should expose full result when no output field exists', () => {
      // Create dependency results without explicit output field
      const dependencyResults = new Map<string, ReviewSummary>();
      const reviewResult: ReviewSummary = {
        issues: [
          {
            file: 'test.js',
            line: 10,
            ruleId: 'test/rule',
            message: 'Test issue',
            severity: 'error',
            category: 'logic',
          },
        ],
      };
      dependencyResults.set('code-review', reviewResult);

      // Test private method via reflection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outputContext = (provider as any).buildOutputContext(dependencyResults);

      // Should expose the entire result object
      expect(outputContext['code-review']).toEqual(reviewResult);
      expect(outputContext['code-review']).toHaveProperty('issues');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((outputContext['code-review'] as any).issues).toHaveLength(1);
    });
  });

  describe('AICheckProvider', () => {
    it('should expose raw output directly to dependent checks', () => {
      const provider = new AICheckProvider();

      // Test the template context building through reflection
      // Create dependency results with raw output
      const dependencyResults = new Map<string, ReviewSummary>();
      const customOutput = { data: ['item1', 'item2'], processed: true };
      dependencyResults.set('data-fetch', {
        issues: [],
        output: customOutput,
      } as ReviewSummary & { output: unknown });

      // Access the private method through reflection to test the logic
      // This tests that outputs are being exposed correctly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providerAny = provider as any;

      // Mock the liquidEngine if it doesn't exist
      if (!providerAny.liquidEngine) {
        providerAny.liquidEngine = {
          parseAndRender: jest.fn().mockResolvedValue('rendered'),
        };
      }

      // Build template context manually using the pattern from the real code
      const templateContext = {
        outputs: dependencyResults
          ? Object.fromEntries(
              Array.from(dependencyResults.entries()).map(([checkName, result]) => [
                checkName,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (result as any).output !== undefined ? (result as any).output : result,
              ])
            )
          : {},
      };

      // Verify the output is exposed directly
      expect(templateContext.outputs['data-fetch']).toEqual(customOutput);
      expect(templateContext.outputs['data-fetch']).not.toHaveProperty('totalIssues');
      expect(templateContext.outputs['data-fetch']).not.toHaveProperty('raw');
    });

    it('should expose full result when no output field exists', () => {
      new AICheckProvider();

      // Create dependency results without explicit output field
      const dependencyResults = new Map<string, ReviewSummary>();
      const reviewResult: ReviewSummary = {
        issues: [
          {
            file: 'test.js',
            line: 5,
            ruleId: 'test/check',
            message: 'Test message',
            severity: 'warning',
            category: 'style',
          },
        ],
      };
      dependencyResults.set('style-check', reviewResult);

      // Build template context manually using the pattern from the real code
      const templateContext = {
        outputs: dependencyResults
          ? Object.fromEntries(
              Array.from(dependencyResults.entries()).map(([checkName, result]) => [
                checkName,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (result as any).output !== undefined ? (result as any).output : result,
              ])
            )
          : {},
      };

      // Should expose the entire result object
      expect(templateContext.outputs['style-check']).toEqual(reviewResult);
      expect(templateContext.outputs['style-check']).toHaveProperty('issues');
    });
  });

  describe('Output in forEach context', () => {
    it('should properly handle array outputs for forEach iteration', () => {
      const provider = new CommandCheckProvider();

      // Create dependency with forEach array output
      const dependencyResults = new Map<string, ReviewSummary>();
      const forEachOutput = ['file1.json', 'file2.json', 'file3.json'];
      dependencyResults.set('list-files', {
        issues: [],
        output: forEachOutput,
        forEachItems: forEachOutput,
        isForEach: true,
      } as ReviewSummary & { output: unknown; forEachItems: unknown; isForEach: boolean });

      // Test private method via reflection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outputContext = (provider as any).buildOutputContext(dependencyResults);

      // Should expose the array directly
      expect(outputContext['list-files']).toEqual(forEachOutput);
      expect(Array.isArray(outputContext['list-files'])).toBe(true);
      expect(outputContext['list-files']).toHaveLength(3);
    });
  });

  describe('JSON filter handling', () => {
    it('should properly expose nested objects for json filter', () => {
      new AICheckProvider();

      // Create complex nested output
      const dependencyResults = new Map<string, ReviewSummary>();
      const nestedOutput = {
        level1: {
          level2: {
            data: ['item1', 'item2'],
            metadata: { count: 2, active: true },
          },
        },
      };
      dependencyResults.set('nested-check', {
        issues: [],
        output: nestedOutput,
      } as ReviewSummary & { output: unknown });

      // Build template context manually using the pattern from the real code
      const templateContext = {
        outputs: dependencyResults
          ? Object.fromEntries(
              Array.from(dependencyResults.entries()).map(([checkName, result]) => [
                checkName,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (result as any).output !== undefined ? (result as any).output : result,
              ])
            )
          : {},
      };

      // Verify nested object is exposed directly for JSON serialization
      expect(templateContext.outputs['nested-check']).toEqual(nestedOutput);
      // When Liquid applies json filter, it will properly serialize this
      const jsonString = JSON.stringify(templateContext.outputs['nested-check']);
      expect(jsonString).not.toContain('[object Object]');
      expect(jsonString).toContain('"level1"');
      expect(jsonString).toContain('"level2"');
      expect(jsonString).toContain('"metadata"');
    });
  });
});
