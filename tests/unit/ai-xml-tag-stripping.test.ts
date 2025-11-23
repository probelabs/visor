import { AIReviewService } from '../../src/ai-review-service';

describe('AI Review Service - Plain Schema Handling', () => {
  let service: AIReviewService;

  beforeEach(() => {
    service = new AIReviewService();
  });

  describe('parseAIResponse with plain schema', () => {
    it('should return raw response as text output for plain schema', () => {
      const response = '<result>This is the actual content we want to keep</result>';
      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.issues).toHaveLength(0);
      expect((result as any).output).toMatchObject({
        text: response,
      });
    });

    it('should return raw response as text output for any plain text response', () => {
      const response = 'This is plain text without any XML tags';
      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.issues).toHaveLength(0);
      expect((result as any).output).toMatchObject({
        text: response,
      });
    });

    it('should handle multiline plain text responses', () => {
      const response = `This is a substantial and well-executed pull request that introduces:
- Feature 1
- Feature 2
- Feature 3

## Summary
The changes look good overall.`;

      const result = (service as any).parseAIResponse(response, undefined, 'plain');

      expect(result.issues).toHaveLength(0);
      expect((result as any).output).toMatchObject({
        text: response,
      });
    });

    it('should include debug info when provided', () => {
      const response = 'This is plain text';
      const debugInfo = { rawResponse: response, responseLength: response.length };
      const result = (service as any).parseAIResponse(response, debugInfo, 'plain');

      expect(result.issues).toHaveLength(0);
      expect((result as any).output.text).toBe(response);
      expect(result.debug).toBe(debugInfo);
    });
  });

  describe('parseAIResponse with code-review schema', () => {
    it('should properly parse JSON for code-review schema', () => {
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
      });

      const result = (service as any).parseAIResponse(jsonResponse, undefined, 'code-review');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].file).toBe('test.ts');
      expect(result.issues[0].line).toBe(10);
      expect(result.issues[0].message).toBe('Test issue');
      expect(result.issues[0].severity).toBe('warning');
      expect(result.issues[0].category).toBe('style');
    });
  });
});
