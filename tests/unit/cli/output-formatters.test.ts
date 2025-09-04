import { OutputFormatters, AnalysisResult } from '../../../src/output-formatters';
import { ReviewSummary, ReviewComment } from '../../../src/reviewer';
import { GitRepositoryInfo } from '../../../src/git-repository-analyzer';

describe('OutputFormatters', () => {
  let mockAnalysisResult: AnalysisResult;

  beforeEach(() => {
    mockAnalysisResult = {
      repositoryInfo: {
        title: 'Test PR',
        body: 'Test PR description',
        author: 'test-author',
        base: 'main',
        head: 'feature-branch',
        isGitRepository: true,
        workingDirectory: '/test/repo',
        files: [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 10,
            deletions: 5,
            changes: 15,
            patch: '@@ -1,5 +1,10 @@\n test changes'
          },
          {
            filename: 'src/utils.js',
            status: 'added',
            additions: 20,
            deletions: 0,
            changes: 20,
            patch: '@@ -0,0 +1,20 @@\n new file'
          }
        ],
        totalAdditions: 30,
        totalDeletions: 5
      },
      reviewSummary: {
        overallScore: 85,
        totalIssues: 3,
        criticalIssues: 1,
        suggestions: [
          'Consider adding input validation',
          'Add error handling for edge cases'
        ],
        comments: [
          {
            file: 'src/test.ts',
            line: 10,
            message: 'Potential SQL injection vulnerability',
            severity: 'error',
            category: 'security' as const
          },
          {
            file: 'src/test.ts',
            line: 15,
            message: 'Consider using async/await for better readability',
            severity: 'warning',
            category: 'style' as const
          },
          {
            file: 'src/utils.js',
            line: 5,
            message: 'This operation could be optimized with caching',
            severity: 'info',
            category: 'performance' as const
          }
        ]
      },
      executionTime: 1500,
      timestamp: '2025-01-15T10:30:00.000Z',
      checksExecuted: ['security', 'performance', 'style']
    };
  });

  describe('formatAsTable', () => {
    it('should format analysis results as a table', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult);
      
      expect(result).toContain('📊 Analysis Summary');
      expect(result).toContain('Overall Score');
      expect(result).toContain('85/100');
      expect(result).toContain('Total Issues');
      expect(result).toContain('3');
      expect(result).toContain('Critical Issues');
      expect(result).toContain('1');
      expect(result).toContain('Execution Time');
      expect(result).toContain('1500ms');
      expect(result).toContain('security, performance, style');
    });

    it('should group issues by category', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, { groupByCategory: true });
      
      expect(result).toContain('SECURITY Issues');
      expect(result).toContain('PERFORMANCE Issues');
      expect(result).toContain('STYLE Issues');
      expect(result).toContain('SQL injection vulnerability');
      expect(result).toContain('async/await for better read');
      expect(result).toContain('optimized wit'); // Truncated due to 45 char limit
    });

    it('should show all issues when showDetails is true', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, { 
        groupByCategory: true, 
        showDetails: true 
      });
      
      expect(result).toContain('src/test.ts');
      expect(result).toContain('src/utils.js');
      expect(result).not.toContain('... and'); // No truncation message
    });

    it('should include suggestions table', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult);
      
      expect(result).toContain('💡 Suggestions');
      expect(result).toContain('Consider adding input validation');
      expect(result).toContain('Add error handling for edge cases');
    });

    it('should include files table when requested', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, { 
        includeFiles: true 
      });
      
      expect(result).toContain('📁 Files Changed');
      expect(result).toContain('src/test.ts');
      expect(result).toContain('src/utils.js');
      expect(result).toContain('📝 modifi'); // Truncated in table
      expect(result).toContain('✅ added');
      expect(result).toContain('+10');
      expect(result).toContain('-5');
      expect(result).toContain('+20');
    });

    it('should include timestamp when requested', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, { 
        includeTimestamp: true 
      });
      
      expect(result).toContain('Generated at: 2025-01-15T10:30:00.000Z');
    });

    it('should handle no issues gracefully', () => {
      const noIssuesResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          ...mockAnalysisResult.reviewSummary,
          totalIssues: 0,
          criticalIssues: 0,
          comments: []
        }
      };
      
      const result = OutputFormatters.formatAsTable(noIssuesResult);
      
      expect(result).toContain('✅ No issues found!');
      expect(result).not.toContain('SECURITY Issues');
    });
  });

  describe('formatAsJSON', () => {
    it('should format analysis results as JSON', () => {
      const result = OutputFormatters.formatAsJSON(mockAnalysisResult);
      const parsed = JSON.parse(result);
      
      expect(parsed).toHaveProperty('summary');
      expect(parsed).toHaveProperty('repository');
      expect(parsed).toHaveProperty('issues');
      expect(parsed).toHaveProperty('suggestions');
      
      expect(parsed.summary.overallScore).toBe(85);
      expect(parsed.summary.totalIssues).toBe(3);
      expect(parsed.summary.executionTime).toBe(1500);
      expect(parsed.summary.checksExecuted).toEqual(['security', 'performance', 'style']);
      
      expect(parsed.repository.title).toBe('Test PR');
      expect(parsed.repository.author).toBe('test-author');
      expect(parsed.repository.filesChanged).toBe(2); // This comes from files.length
    });

    it('should group issues by category in JSON', () => {
      const result = OutputFormatters.formatAsJSON(mockAnalysisResult, { 
        groupByCategory: true 
      });
      const parsed = JSON.parse(result);
      
      expect(parsed.issues).toHaveProperty('security');
      expect(parsed.issues).toHaveProperty('performance');
      expect(parsed.issues).toHaveProperty('style');
      
      expect(parsed.issues.security).toHaveLength(1);
      expect(parsed.issues.performance).toHaveLength(1);
      expect(parsed.issues.style).toHaveLength(1);
      
      expect(parsed.issues.security[0].message).toContain('SQL injection');
    });

    it('should include files when requested', () => {
      const result = OutputFormatters.formatAsJSON(mockAnalysisResult, { 
        includeFiles: true 
      });
      const parsed = JSON.parse(result);
      
      expect(parsed.files).toBeDefined();
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[0].filename).toBe('src/test.ts');
      expect(parsed.files[1].filename).toBe('src/utils.js');
    });

    it('should not include files when not requested', () => {
      const result = OutputFormatters.formatAsJSON(mockAnalysisResult, { 
        includeFiles: false 
      });
      const parsed = JSON.parse(result);
      
      expect(parsed.files).toBeUndefined();
    });

    it('should output pure JSON without decorative headers', () => {
      const result = OutputFormatters.formatAsJSON(mockAnalysisResult);
      
      // Should be valid JSON
      expect(() => JSON.parse(result)).not.toThrow();
      
      // Should not contain any decorative text outside JSON
      expect(result.trim().startsWith('{')).toBe(true);
      expect(result.trim().endsWith('}')).toBe(true);
      
      // Should not contain console decorative messages
      expect(result).not.toContain('Analysis Summary');
      expect(result).not.toContain('📊');
      expect(result).not.toContain('Generated at');
    });
  });

  describe('formatAsMarkdown', () => {
    it('should format analysis results as markdown', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult);
      
      expect(result).toContain('# 🔍 Visor Analysis Results');
      expect(result).toContain('## 📊 Summary');
      expect(result).toContain('| Overall Score | 85/100 |');
      expect(result).toContain('| Total Issues | 3 |');
      expect(result).toContain('| Execution Time | 1500ms |');
      
      expect(result).toContain('## 📁 Repository Information');
      expect(result).toContain('**Title**: Test PR');
      expect(result).toContain('**Author**: test-author');
      expect(result).toContain('**Branch**: feature-branch ← main');
    });

    it('should group issues by category in markdown', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult, { 
        groupByCategory: true 
      });
      
      expect(result).toContain('## 🔒 Security Issues');
      expect(result).toContain('## 📈 Performance Issues');
      expect(result).toContain('## 🎨 Style Issues');
      
      expect(result).toContain('### 🚨 `src/test.ts:10`');
      expect(result).toContain('**Severity**: ERROR');
      expect(result).toContain('**Message**: Potential SQL injection vulnerability');
      
      expect(result).toContain('### ⚠️ `src/test.ts:15`');
      expect(result).toContain('**Severity**: WARNING');
    });

    it('should handle show more issues with details', () => {
      // Create a result with many issues to test truncation
      const manyIssuesResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          ...mockAnalysisResult.reviewSummary,
          totalIssues: 10,
          comments: Array.from({ length: 10 }, (_, i) => ({
            file: `src/file${i}.ts`,
            line: i + 1,
            message: `Issue ${i + 1}`,
            severity: 'warning' as const,
            category: 'security' as const
          }))
        }
      };
      
      const result = OutputFormatters.formatAsMarkdown(manyIssuesResult, { 
        groupByCategory: true,
        showDetails: false 
      });
      
      expect(result).toContain('<details>');
      expect(result).toContain('Show 5 more issues...');
      expect(result).toContain('</details>');
    });

    it('should include recommendations section', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult);
      
      expect(result).toContain('## 💡 Recommendations');
      expect(result).toContain('1. Consider adding input validation');
      expect(result).toContain('2. Add error handling for edge cases');
    });

    it('should include files table when requested', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult, { 
        includeFiles: true 
      });
      
      expect(result).toContain('## 📁 Files Changed');
      expect(result).toContain('| File | Status | Changes |');
      expect(result).toContain('| `src/test.ts` | 📝 modified | +10/-5 |');
      expect(result).toContain('| `src/utils.js` | ✅ added | +20/-0 |');
    });

    it('should include timestamp in footer when requested', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult, { 
        includeTimestamp: true 
      });
      
      expect(result).toContain('---');
      expect(result).toContain('*Generated by Visor at 2025-01-15T10:30:00.000Z*');
    });

    it('should handle no issues gracefully', () => {
      const noIssuesResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          ...mockAnalysisResult.reviewSummary,
          totalIssues: 0,
          criticalIssues: 0,
          comments: []
        }
      };
      
      const result = OutputFormatters.formatAsMarkdown(noIssuesResult);
      
      expect(result).toContain('## ✅ No Issues Found');
      expect(result).toContain('Great job! No issues were detected');
      expect(result).not.toContain('## 🔒 Security Issues');
    });
  });

  describe('formatAsSarif', () => {
    it('should format analysis results as SARIF 2.1.0', () => {
      const result = OutputFormatters.formatAsSarif(mockAnalysisResult);
      const parsed = JSON.parse(result);
      
      expect(parsed).toHaveProperty('$schema', 'https://json.schemastore.org/sarif-2.1.0.json');
      expect(parsed).toHaveProperty('version', '2.1.0');
      expect(parsed).toHaveProperty('runs');
      expect(parsed.runs).toHaveLength(1);
      
      const run = parsed.runs[0];
      expect(run).toHaveProperty('tool');
      expect(run.tool.driver.name).toBe('Visor');
      expect(run.tool.driver.version).toBe('1.0.0');
      expect(run.tool.driver.rules).toBeDefined();
      expect(run.tool.driver.rules.length).toBeGreaterThan(0);
      
      expect(run).toHaveProperty('results');
      expect(run.results).toHaveLength(3); // Same as mockAnalysisResult.reviewSummary.comments.length
    });

    it('should map Visor categories to SARIF rule IDs correctly', () => {
      const result = OutputFormatters.formatAsSarif(mockAnalysisResult);
      const parsed = JSON.parse(result);
      
      const results = parsed.runs[0].results;
      expect(results[0].ruleId).toBe('visor-security-input-validation'); // security category
      expect(results[1].ruleId).toBe('visor-style-consistency'); // style category  
      expect(results[2].ruleId).toBe('visor-performance-optimization'); // performance category
    });

    it('should map Visor severities to SARIF levels correctly', () => {
      const result = OutputFormatters.formatAsSarif(mockAnalysisResult);
      const parsed = JSON.parse(result);
      
      const results = parsed.runs[0].results;
      expect(results[0].level).toBe('error'); // error severity
      expect(results[1].level).toBe('warning'); // warning severity
      expect(results[2].level).toBe('note'); // info severity -> note in SARIF
    });

    it('should include proper location information', () => {
      const result = OutputFormatters.formatAsSarif(mockAnalysisResult);
      const parsed = JSON.parse(result);
      
      const firstResult = parsed.runs[0].results[0];
      expect(firstResult.locations).toHaveLength(1);
      
      const location = firstResult.locations[0];
      expect(location.physicalLocation.artifactLocation.uri).toBe('src/test.ts');
      expect(location.physicalLocation.artifactLocation.uriBaseId).toBe('%SRCROOT%');
      expect(location.physicalLocation.region.startLine).toBe(10);
      expect(location.physicalLocation.region.startColumn).toBe(1);
    });

    it('should include rule definitions with proper structure', () => {
      const result = OutputFormatters.formatAsSarif(mockAnalysisResult);
      const parsed = JSON.parse(result);
      
      const rules = parsed.runs[0].tool.driver.rules;
      expect(rules.length).toBeGreaterThan(0);
      
      // Check first rule structure
      const firstRule = rules[0];
      expect(firstRule).toHaveProperty('id');
      expect(firstRule).toHaveProperty('shortDescription');
      expect(firstRule.shortDescription).toHaveProperty('text');
      expect(firstRule).toHaveProperty('fullDescription');
      expect(firstRule.fullDescription).toHaveProperty('text');
      expect(firstRule).toHaveProperty('helpUri');
    });

    it('should handle empty results gracefully', () => {
      const emptyResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          ...mockAnalysisResult.reviewSummary,
          comments: []
        }
      };
      
      const result = OutputFormatters.formatAsSarif(emptyResult);
      const parsed = JSON.parse(result);
      
      expect(parsed.runs[0].results).toHaveLength(0);
      expect(parsed.runs[0].tool.driver.rules).toBeDefined();
      expect(parsed.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
    });

    it('should output pure SARIF JSON without decorative headers', () => {
      const result = OutputFormatters.formatAsSarif(mockAnalysisResult);
      
      // Should be valid JSON
      expect(() => JSON.parse(result)).not.toThrow();
      
      // Should not contain any decorative text outside JSON
      expect(result.trim().startsWith('{')).toBe(true);
      expect(result.trim().endsWith('}')).toBe(true);
      
      // Should not contain console decorative messages
      expect(result).not.toContain('Analysis Summary');
      expect(result).not.toContain('📊');
      expect(result).not.toContain('Generated at');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty repository info', () => {
      const emptyResult: AnalysisResult = {
        repositoryInfo: {
          title: '',
          body: '',
          author: '',
          base: '',
          head: '',
          isGitRepository: false,
          workingDirectory: '',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0
        },
        reviewSummary: {
          overallScore: 0,
          totalIssues: 0,
          criticalIssues: 0,
          suggestions: [],
          comments: []
        },
        executionTime: 0,
        timestamp: '',
        checksExecuted: []
      };
      
      expect(() => OutputFormatters.formatAsTable(emptyResult)).not.toThrow();
      expect(() => OutputFormatters.formatAsJSON(emptyResult)).not.toThrow();
      expect(() => OutputFormatters.formatAsMarkdown(emptyResult)).not.toThrow();
    });

    it('should handle very long messages', () => {
      const longMessageResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          ...mockAnalysisResult.reviewSummary,
          comments: [{
            file: 'src/test.ts',
            line: 1,
            message: 'A'.repeat(200), // Very long message
            severity: 'error' as const,
            category: 'security' as const
          }]
        }
      };
      
      const tableResult = OutputFormatters.formatAsTable(longMessageResult);
      const jsonResult = OutputFormatters.formatAsJSON(longMessageResult);
      const markdownResult = OutputFormatters.formatAsMarkdown(longMessageResult);
      
      expect(tableResult).toBeDefined();
      expect(jsonResult).toBeDefined();
      expect(markdownResult).toBeDefined();
      
      // Table should truncate long messages - just check it doesn't crash
      expect(tableResult).toBeDefined();
    });
  });
});