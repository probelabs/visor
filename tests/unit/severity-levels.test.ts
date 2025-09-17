import { AIReviewService } from '../../src/ai-review-service';

describe('Severity Levels', () => {
  describe('Critical Issues Count', () => {
    it('should count only critical severity as critical issues', () => {
      const service = new AIReviewService({ apiKey: 'test' });

      const mockResponse = JSON.stringify({
        issues: [
          {
            file: 'a.js',
            line: 1,
            ruleId: 'style/info',
            message: 'Info',
            severity: 'info',
            category: 'style',
          },
          {
            file: 'b.js',
            line: 2,
            ruleId: 'style/warning',
            message: 'Warning',
            severity: 'warning',
            category: 'style',
          },
          {
            file: 'c.js',
            line: 3,
            ruleId: 'logic/error',
            message: 'Error',
            severity: 'error',
            category: 'logic',
          },
          {
            file: 'd.js',
            line: 4,
            ruleId: 'security/critical',
            message: 'Critical',
            severity: 'critical',
            category: 'security',
          },
        ],
        suggestions: [],
      });

      const result = (service as any).parseAIResponse(mockResponse, undefined, 'code-review');

      // Should correctly process issues with critical severity
      expect(result.issues).toBeDefined();
      expect(result.issues.length).toBe(4);
      expect(result.issues[3].severity).toBe('critical');

      // Test dynamic calculation of critical issues
      const criticalCount = result.issues.filter(
        (issue: any) => issue.severity === 'critical'
      ).length;
      expect(criticalCount).toBe(1);
    });
  });
});
