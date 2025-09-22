import { AIReviewService } from '../../src/ai-review-service';

describe('AI Review Service - XML Tag Stripping', () => {
  let service: AIReviewService;

  beforeEach(() => {
    service = new AIReviewService();
  });

  describe('parseAIResponse with plain schema', () => {
    it('should strip <result> tags from plain text responses', () => {
      const response = '<result>This is the actual content we want to keep</result>';
      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toBe('This is the actual content we want to keep');
      expect(result.suggestions[0]).not.toContain('<result>');
      expect(result.suggestions[0]).not.toContain('</result>');
    });

    it('should strip <response> tags from plain text responses', () => {
      const response = '<response>Another type of wrapper tag</response>';
      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toBe('Another type of wrapper tag');
      expect(result.suggestions[0]).not.toContain('<response>');
      expect(result.suggestions[0]).not.toContain('</response>');
    });

    it('should strip <answer> tags from plain text responses', () => {
      const response = '<answer>Yet another wrapper format</answer>';
      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toBe('Yet another wrapper format');
      expect(result.suggestions[0]).not.toContain('<answer>');
      expect(result.suggestions[0]).not.toContain('</answer>');
    });

    it('should handle multiline content within tags', () => {
      const response = `<result>
This is a substantial and well-executed pull request that introduces:
- Feature 1
- Feature 2
- Feature 3

## Summary
The changes look good overall.
</result>`;

      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toContain(
        'This is a substantial and well-executed pull request'
      );
      expect(result.suggestions[0]).toContain('## Summary');
      expect(result.suggestions[0]).not.toContain('<result>');
      expect(result.suggestions[0]).not.toContain('</result>');
    });

    it('should handle responses without XML tags', () => {
      const response = 'This is plain text without any XML tags';
      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toBe('This is plain text without any XML tags');
    });

    it('should handle case-insensitive tag matching', () => {
      const response = '<Result>Mixed case tags should also be stripped</RESULT>';
      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toBe('Mixed case tags should also be stripped');
    });

    it('should only strip outer wrapper tags, not nested XML', () => {
      const response = `<result>
## Analysis

The PR includes changes to:
- <file>src/index.ts</file>
- <file>src/config.ts</file>

These changes look good.
</result>`;

      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toContain('<file>src/index.ts</file>');
      expect(result.suggestions[0]).toContain('<file>src/config.ts</file>');
      expect(result.suggestions[0]).not.toContain('<result>');
      expect(result.suggestions[0]).not.toContain('</result>');
    });

    it('should handle responses with whitespace around tags', () => {
      const response = `  <result>
      Content with surrounding whitespace
  </result>  `;

      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toBe('Content with surrounding whitespace');
    });
  });

  describe('parseAIResponse with code-review schema', () => {
    it('should not affect JSON parsing for code-review schema', () => {
      const jsonResponse = JSON.stringify({
        issues: [
          {
            file: 'test.ts',
            line: 10,
            message: 'Test issue',
            severity: 'warning',
            category: 'style',
          },
        ],
        suggestions: ['Fix the style issue'],
      });

      const result = (service as any).parseAIResponse(jsonResponse, undefined, 'code-review');

      expect(result.issues).toHaveLength(1);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toBe('Fix the style issue');
    });
  });
});
