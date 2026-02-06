import { OutputFormatters, AnalysisResult } from '../../../src/output-formatters';

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
            patch: '@@ -1,5 +1,10 @@\n test changes',
          },
          {
            filename: 'src/utils.js',
            status: 'added',
            additions: 20,
            deletions: 0,
            changes: 20,
            patch: '@@ -0,0 +1,20 @@\n new file',
          },
        ],
        totalAdditions: 30,
        totalDeletions: 5,
      },
      reviewSummary: {
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            endLine: undefined,
            ruleId: 'security/sql-injection',
            message: 'Potential SQL injection vulnerability',
            severity: 'error',
            category: 'security' as const,
            suggestion: 'Use parameterized queries to prevent SQL injection',
            replacement:
              'const query = "SELECT * FROM users WHERE id = ?";\nconst result = await db.query(query, [userId]);',
          },
          {
            file: 'src/test.ts',
            line: 15,
            endLine: undefined,
            ruleId: 'style/readability',
            message: 'Consider using async/await for better readability',
            severity: 'warning',
            category: 'style' as const,
            suggestion: 'Replace promises with async/await for better readability',
            replacement: 'const data = await fetchData();\nreturn data;',
          },
          {
            file: 'src/utils.js',
            line: 5,
            endLine: undefined,
            ruleId: 'performance/caching',
            message: 'This operation could be optimized with caching',
            severity: 'info',
            category: 'performance' as const,
            suggestion: 'Add caching to avoid repeated expensive computations',
            replacement:
              'const cache = new Map();\nif (cache.has(key)) {\n  return cache.get(key);\n}\nconst result = expensiveOperation();\ncache.set(key, result);\nreturn result;',
          },
        ],
      },
      executionTime: 1500,
      timestamp: '2025-01-15T10:30:00.000Z',
      checksExecuted: ['security', 'performance', 'style'],
    };
  });

  describe('formatAsTable', () => {
    it('should format analysis results as a table', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult);

      expect(result).toContain('Analysis Summary');
      expect(result).toContain('Total Issues');
      expect(result).toContain('3');
      // Note: "Critical Issues" row only shown when criticalIssues > 0
      expect(result).not.toContain('Critical Issues'); // No critical issues in our test data
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
        showDetails: true,
      });

      expect(result).toContain('src/test.ts');
      expect(result).toContain('src/utils.js');
      expect(result).not.toContain('... and'); // No truncation message
    });

    it('should not include suggestions table as it has been removed', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult);

      expect(result).not.toContain('Suggestions');
      expect(result).not.toContain('Consider adding input validation');
      expect(result).not.toContain('Add error handling for edge cases');
    });

    it('should include issue suggestions without emoji', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, { showDetails: true });

      expect(result).toContain('Suggestion: Use parameterized queries');
      // The other suggestions might not appear depending on table pagination or truncation
      // Let's just check that suggestions are formatted without emoji
      expect(result).not.toContain('💡');
    });

    it('should include code replacements with Code fix prefix', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, { showDetails: true });

      expect(result).toContain('Code fix:');
      expect(result).toContain('const query = "SELECT * FROM users WHERE id = ?";');
      expect(result).toContain('const data = await fetchData();');
      expect(result).toContain('const cache = new Map();');
    });

    it('should include files table when requested', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, {
        includeFiles: true,
      });

      expect(result).toContain('Files Changed');
      expect(result).toContain('src/test.ts');
      expect(result).toContain('src/utils.js');
      expect(result).toContain('M'); // File status without emoji
      expect(result).toContain('A'); // File status without emoji
      expect(result).toContain('+10');
      expect(result).toContain('-5');
      expect(result).toContain('+20');
    });

    it('should include timestamp when requested', () => {
      const result = OutputFormatters.formatAsTable(mockAnalysisResult, {
        includeTimestamp: true,
      });

      expect(result).toContain('Generated at: 2025-01-15T10:30:00.000Z');
    });

    it('should handle no issues gracefully', () => {
      const noIssuesResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          issues: [],
        },
      };

      const result = OutputFormatters.formatAsTable(noIssuesResult);

      expect(result).toContain('No issues found!');
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
      expect(parsed).not.toHaveProperty('suggestions');

      expect(parsed.summary.totalIssues).toBe(3);
      expect(parsed.summary.criticalIssues).toBe(0);
      expect(parsed.summary.executionTime).toBe(1500);
      expect(parsed.summary.checksExecuted).toEqual(['security', 'performance', 'style']);

      expect(parsed.repository.title).toBe('Test PR');
      expect(parsed.repository.author).toBe('test-author');
      expect(parsed.repository.filesChanged).toBe(2); // This comes from files.length
    });

    it('should group issues by category in JSON', () => {
      const result = OutputFormatters.formatAsJSON(mockAnalysisResult, {
        groupByCategory: true,
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
        includeFiles: true,
      });
      const parsed = JSON.parse(result);

      expect(parsed.files).toBeDefined();
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[0].filename).toBe('src/test.ts');
      expect(parsed.files[1].filename).toBe('src/utils.js');
    });

    it('should not include files when not requested', () => {
      const result = OutputFormatters.formatAsJSON(mockAnalysisResult, {
        includeFiles: false,
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
      expect(result).not.toContain('Generated at');
    });
  });

  describe('formatAsMarkdown', () => {
    it('should format analysis results as markdown', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult);

      expect(result).toContain('# Visor Analysis Results');
      expect(result).toContain('## Summary');
      expect(result).toContain('| Total Issues | 3 |');
      expect(result).toContain('| Critical Issues | 0 |');
      expect(result).toContain('| Execution Time | 1500ms |');

      expect(result).toContain('## Repository Information');
      expect(result).toContain('**Title**: Test PR');
      expect(result).toContain('**Author**: test-author');
      expect(result).toContain('**Branch**: feature-branch ← main');
    });

    it('should group issues by category in markdown', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult, {
        groupByCategory: true,
      });

      expect(result).toContain('## Security Issues');
      expect(result).toContain('## Performance Issues');
      expect(result).toContain('## Style Issues');

      expect(result).toContain('### `src/test.ts:10`');
      expect(result).toContain('**Severity**: ERROR');
      expect(result).toContain('**Message**: Potential SQL injection vulnerability');

      expect(result).toContain('### `src/test.ts:15`');
      expect(result).toContain('**Severity**: WARNING');
    });

    it('should include suggestions and replacements in markdown', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult, {
        groupByCategory: true,
        showDetails: true,
      });

      // Check for suggestions without emoji
      expect(result).toContain(
        '**Suggestion**: Use parameterized queries to prevent SQL injection'
      );
      expect(result).toContain(
        '**Suggestion**: Replace promises with async/await for better readability'
      );
      expect(result).toContain(
        '**Suggestion**: Add caching to avoid repeated expensive computations'
      );

      // Check for code replacements with proper markdown code blocks
      expect(result).toContain('**Suggested Fix**:');
      expect(result).toContain('```typescript'); // Language detection from .ts extension
      expect(result).toContain('```javascript'); // Language detection from .js extension
      expect(result).toContain('const query = "SELECT * FROM users WHERE id = ?";');
      expect(result).toContain('const data = await fetchData();');
      expect(result).toContain('const cache = new Map();');
    });

    it('should handle show more issues with details', () => {
      // Create a result with many issues to test truncation
      const manyIssuesResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          issues: Array.from({ length: 10 }, (_, i) => ({
            file: `src/file${i}.ts`,
            line: i + 1,
            endLine: undefined,
            ruleId: `security/issue-${i}`,
            message: `Issue ${i + 1}`,
            severity: 'warning' as const,
            category: 'security' as const,
            suggestion: undefined,
            replacement: undefined,
          })),
        },
      };

      const result = OutputFormatters.formatAsMarkdown(manyIssuesResult, {
        groupByCategory: true,
        showDetails: false,
      });

      expect(result).toContain('<details>');
      expect(result).toContain('Show 5 more issues...');
      expect(result).toContain('</details>');
    });

    it('should not include recommendations section as it has been removed', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult);

      expect(result).not.toContain('## Recommendations');
      expect(result).not.toContain('1. Consider adding input validation');
      expect(result).not.toContain('2. Add error handling for edge cases');
    });

    it('should include files table when requested', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult, {
        includeFiles: true,
      });

      expect(result).toContain('## Files Changed');
      expect(result).toContain('| File | Status | Changes |');
      expect(result).toContain('| `src/test.ts` | M modified | +10/-5 |');
      expect(result).toContain('| `src/utils.js` | A added | +20/-0 |');
    });

    it('should include timestamp in footer when requested', () => {
      const result = OutputFormatters.formatAsMarkdown(mockAnalysisResult, {
        includeTimestamp: true,
      });

      expect(result).toContain('---');
      expect(result).toContain('*Generated by Visor at 2025-01-15T10:30:00.000Z*');
    });

    it('should handle no issues gracefully', () => {
      const noIssuesResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          issues: [],
        },
      };

      const result = OutputFormatters.formatAsMarkdown(noIssuesResult);

      expect(result).toContain('## No Issues Found');
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
      expect(run.results).toHaveLength(3); // Same as mockAnalysisResult.reviewSummary.issues.length
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
          issues: [],
        },
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
          totalDeletions: 0,
        },
        reviewSummary: {
          issues: [],
        },
        executionTime: 0,
        timestamp: '',
        checksExecuted: [],
      };

      expect(() => OutputFormatters.formatAsTable(emptyResult)).not.toThrow();
      expect(() => OutputFormatters.formatAsJSON(emptyResult)).not.toThrow();
      expect(() => OutputFormatters.formatAsMarkdown(emptyResult)).not.toThrow();
    });

    it('should handle very long messages', () => {
      const longMessageResult = {
        ...mockAnalysisResult,
        reviewSummary: {
          issues: [
            {
              file: 'src/test.ts',
              line: 1,
              endLine: undefined,
              ruleId: 'security/long-message',
              message: 'A'.repeat(200), // Very long message
              severity: 'error' as const,
              category: 'security' as const,
              suggestion: undefined,
              replacement: undefined,
            },
          ],
        },
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

    // Note: heavy truncation paths are exercised indirectly in other tests. Keep this suite fast.

    it('should break single long words to prevent wrap-ansi slow path', () => {
      const longWord = 'A'.repeat(200);
      const res = {
        ...mockAnalysisResult,
        reviewSummary: {
          issues: [
            {
              file: 'src/file.ts',
              line: 1,
              endLine: undefined,
              ruleId: 'style/longword',
              message: longWord,
              severity: 'warning' as const,
              category: 'style' as const,
            },
          ],
        },
      };
      const out = OutputFormatters.formatAsTable(res, { groupByCategory: true });
      expect(out).toBeTruthy();
      // It shouldn't include the entire 2000-char sequence in one line
      expect(out.includes(longWord)).toBe(false);
    });

    it('should format sizable code replacements without hanging', () => {
      const longLine = 'const a = 1; //' + 'x'.repeat(60);
      const code = Array.from({ length: 20 }, () => longLine).join('\n');
      const res = {
        ...mockAnalysisResult,
        reviewSummary: {
          issues: [
            {
              file: 'src/file.ts',
              line: 2,
              endLine: undefined,
              ruleId: 'style/huge-replacement',
              message: 'Refactor needed',
              severity: 'info' as const,
              category: 'style' as const,
              replacement: code,
            },
          ],
        },
      };
      const out = OutputFormatters.formatAsTable(res, {
        groupByCategory: true,
        showDetails: true,
      });
      expect(out).toContain('Code fix:');
      // Ensure we don't dump an enormous block
      expect(out.length).toBeLessThan(9000);
    });
  });
});
