import CliTable3 from 'cli-table3';
import {
  ReviewSummary,
  ReviewComment,
  ReviewIssue,
  calculateTotalIssues,
  calculateCriticalIssues,
  convertIssuesToComments,
} from './reviewer';
import { GitRepositoryInfo } from './git-repository-analyzer';
import { FailureConditionResult } from './types/config';

export interface AnalysisResult {
  repositoryInfo: GitRepositoryInfo;
  reviewSummary: ReviewSummary;
  executionTime: number;
  timestamp: string;
  checksExecuted: string[];
  executionStatistics?: import('./check-execution-engine').ExecutionStatistics; // Detailed execution statistics
  debug?: DebugInfo; // Optional debug information when debug mode is enabled
  failureConditions?: FailureConditionResult[]; // Optional failure condition results
  isCodeReview?: boolean; // Whether this is a code review context (affects output formatting)
}

export interface DebugInfo {
  provider?: string;
  model?: string;
  processingTime?: number;
  parallelExecution?: boolean;
  checksExecuted?: string[];
  totalApiCalls?: number;
  apiCallDetails?: Array<{
    checkName: string;
    provider: string;
    model: string;
    processingTime: number;
    success: boolean;
  }>;
}

export interface OutputFormatterOptions {
  showDetails?: boolean;
  groupByCategory?: boolean;
  includeFiles?: boolean;
  includeTimestamp?: boolean;
}

export class OutputFormatters {
  // Hard safety limits to prevent pathological table rendering hangs
  // Can be tuned via env vars if needed
  private static readonly MAX_CELL_CHARS: number = parseInt(
    process.env.VISOR_MAX_TABLE_CELL || '4000',
    10
  );
  private static readonly MAX_CODE_LINES: number = parseInt(
    process.env.VISOR_MAX_TABLE_CODE_LINES || '120',
    10
  );
  private static readonly WRAP_WIDTH_MESSAGE = 55;
  private static readonly WRAP_WIDTH_MESSAGE_NARROW = 45;
  private static readonly WRAP_WIDTH_CODE = 58; // fits into Message col width ~60

  /**
   * Format analysis results as a table using cli-table3
   */
  static formatAsTable(result: AnalysisResult, options: OutputFormatterOptions = {}): string {
    const { showDetails = false, groupByCategory = true } = options;
    let output = '';

    // Filter out system-level issues (fail_if conditions, internal errors)
    // These should not appear in user-facing output
    const issues = (result.reviewSummary.issues || []).filter(
      issue => !(issue.file === 'system' && issue.line === 0)
    );
    const totalIssues = issues.length;
    const criticalIssues = issues.filter(i => i.severity === 'critical').length;

    // Check if this is a code review context
    const isCodeReview = result.isCodeReview || issues.some(i => i.schema === 'code-review');

    // Only show "Analysis Summary" table for code review contexts or when there are issues
    // For other contexts, the execution statistics table already provides summary
    if (isCodeReview || totalIssues > 0) {
      // Summary table
      const summaryTable = new CliTable3({
        head: ['Metric', 'Value'],
        colWidths: [25, 30],
        style: {
          head: ['cyan', 'bold'],
          border: ['grey'],
        },
      });

      // Add issue metrics
      summaryTable.push(['Total Issues', totalIssues.toString()]);
      if (criticalIssues > 0) {
        summaryTable.push(['Critical Issues', criticalIssues.toString()]);
      }

      // Add code-review specific metrics if in code review context
      if (isCodeReview && result.repositoryInfo.files.length > 0) {
        summaryTable.push(
          ['Files Analyzed', result.repositoryInfo.files.length.toString()],
          ['Total Additions', result.repositoryInfo.totalAdditions.toString()],
          ['Total Deletions', result.repositoryInfo.totalDeletions.toString()]
        );
      }

      // Always show execution time and checks executed
      summaryTable.push(
        ['Execution Time', `${result.executionTime}ms`],
        ['Checks Executed', this.truncateCell(result.checksExecuted.join(', '))]
      );

      output += 'Analysis Summary\n';
      output += summaryTable.toString() + '\n';

      output += '\n';
    }

    // Issues by category table
    if (issues.length > 0) {
      if (groupByCategory) {
        const groupedComments = this.groupCommentsByCategory(convertIssuesToComments(issues));

        for (const [category, comments] of Object.entries(groupedComments)) {
          if (comments.length === 0) continue;

          const categoryTable = new CliTable3({
            head: ['File', 'Line', 'Severity', 'Message'],
            colWidths: [25, 8, 15, 60],
            // We pre-wrap and truncate ourselves to avoid expensive wrap-ansi work
            wordWrap: false,
            style: {
              head: ['cyan', 'bold'],
              border: ['grey'],
            },
          });

          output += `${category.toUpperCase()} Issues (${comments.length})\n`;

          for (const comment of comments.slice(0, showDetails ? comments.length : 5)) {
            // Convert comment back to issue to access suggestion/replacement fields
            const issue = (issues || []).find(
              i => i.file === comment.file && i.line === comment.line
            );

            // Pre-wrap and truncate content to keep cli-table3 fast and responsive
            let messageContent = this.safeWrapAndTruncate(
              comment.message,
              OutputFormatters.WRAP_WIDTH_MESSAGE
            );

            // Add suggestion if available
            if (issue?.suggestion) {
              messageContent +=
                '\nSuggestion: ' +
                this.safeWrapAndTruncate(issue.suggestion, OutputFormatters.WRAP_WIDTH_MESSAGE - 2);
            }

            // Add replacement code if available
            if (issue?.replacement) {
              const code = this.formatCodeBlock(issue.replacement);
              messageContent += '\nCode fix:\n' + code;
            }

            categoryTable.push([
              comment.file,
              comment.line.toString(),
              { content: this.formatSeverity(comment.severity), hAlign: 'center' },
              this.truncateCell(messageContent),
            ]);
          }

          output += categoryTable.toString() + '\n';

          if (!showDetails && comments.length > 5) {
            output += `... and ${comments.length - 5} more issues\n`;
          }
          output += '\n';
        }
      } else {
        // All issues in one table
        const issuesTable = new CliTable3({
          head: ['File', 'Line', 'Category', 'Severity', 'Message'],
          colWidths: [20, 6, 12, 15, 50],
          wordWrap: false,
          style: {
            head: ['cyan', 'bold'],
            border: ['grey'],
          },
        });

        output += 'All Issues\n';

        for (const issue of issues.slice(0, showDetails ? undefined : 10)) {
          let messageContent = this.safeWrapAndTruncate(
            issue.message,
            OutputFormatters.WRAP_WIDTH_MESSAGE_NARROW
          );

          // Add suggestion if available
          if (issue.suggestion) {
            messageContent +=
              '\nSuggestion: ' +
              this.safeWrapAndTruncate(
                issue.suggestion,
                OutputFormatters.WRAP_WIDTH_MESSAGE_NARROW - 2
              );
          }

          // Add replacement code if available
          if (issue.replacement) {
            const code = this.formatCodeBlock(issue.replacement);
            messageContent += '\nCode fix:\n' + code;
          }

          issuesTable.push([
            this.truncateText(issue.file, 18),
            issue.line.toString(),
            issue.category,
            this.formatSeverity(issue.severity),
            this.truncateCell(messageContent),
          ]);
        }

        output += issuesTable.toString() + '\n\n';
      }
    } else {
      output += 'No issues found!\n\n';
    }

    // Files table (if requested)
    if (options.includeFiles && result.repositoryInfo.files.length > 0) {
      const filesTable = new CliTable3({
        head: ['File', 'Status', 'Additions', 'Deletions'],
        colWidths: [40, 12, 12, 12],
        style: {
          head: ['cyan', 'bold'],
          border: ['grey'],
        },
      });

      output += 'Files Changed\n';

      for (const file of result.repositoryInfo.files) {
        const statusEmoji = this.getFileStatusEmoji(file.status);
        filesTable.push([
          this.truncateText(file.filename, 35),
          `${statusEmoji} ${file.status}`,
          `+${file.additions}`,
          `-${file.deletions}`,
        ]);
      }

      output += filesTable.toString() + '\n\n';
    }

    if (options.includeTimestamp) {
      output += `Generated at: ${result.timestamp}\n`;
    }

    return output;
  }

  /**
   * Format analysis results as JSON
   */
  static formatAsJSON(result: AnalysisResult, options: OutputFormatterOptions = {}): string {
    // Filter out system-level issues (fail_if conditions, internal errors)
    const issues = (result.reviewSummary.issues || []).filter(
      issue => !(issue.file === 'system' && issue.line === 0)
    );
    const totalIssues = calculateTotalIssues(issues);
    const criticalIssues = calculateCriticalIssues(issues);

    const jsonResult = {
      summary: {
        totalIssues,
        criticalIssues,
        executionTime: result.executionTime,
        timestamp: result.timestamp,
        checksExecuted: result.checksExecuted,
      },
      repository: {
        title: result.repositoryInfo.title,
        author: result.repositoryInfo.author,
        base: result.repositoryInfo.base,
        head: result.repositoryInfo.head,
        isGitRepository: result.repositoryInfo.isGitRepository,
        workingDirectory: result.repositoryInfo.workingDirectory,
        filesChanged: result.repositoryInfo.files.length,
        totalAdditions: result.repositoryInfo.totalAdditions,
        totalDeletions: result.repositoryInfo.totalDeletions,
      },
      issues: options.groupByCategory
        ? this.groupCommentsByCategory(convertIssuesToComments(issues || []))
        : issues || [],
      files: options.includeFiles ? result.repositoryInfo.files : undefined,
      debug: result.debug, // Include debug information when available
      failureConditions: result.failureConditions || [], // Include failure condition results
    };

    return JSON.stringify(jsonResult, null, 2);
  }

  /**
   * Format analysis results as SARIF 2.1.0
   */
  static formatAsSarif(result: AnalysisResult, _options: OutputFormatterOptions = {}): string {
    // Filter out system-level issues (fail_if conditions, internal errors)
    const issues = (result.reviewSummary.issues || []).filter(
      issue => !(issue.file === 'system' && issue.line === 0)
    );

    // Generate unique rule definitions for each issue category
    const rules: Array<{
      id: string;
      shortDescription: { text: string };
      fullDescription: { text: string };
      helpUri: string;
    }> = [
      {
        id: 'visor-security-input-validation',
        shortDescription: {
          text: 'Input validation required',
        },
        fullDescription: {
          text: 'Input validation and sanitization should be implemented to prevent security vulnerabilities.',
        },
        helpUri: 'https://owasp.org/www-project-top-ten/2017/A1_2017-Injection',
      },
      {
        id: 'visor-performance-optimization',
        shortDescription: {
          text: 'Performance optimization needed',
        },
        fullDescription: {
          text: 'Code performance can be improved through caching, algorithm optimization, or resource management.',
        },
        helpUri: 'https://web.dev/performance/',
      },
      {
        id: 'visor-style-consistency',
        shortDescription: {
          text: 'Code style inconsistency',
        },
        fullDescription: {
          text: 'Code should follow consistent naming conventions and formatting standards.',
        },
        helpUri: 'https://google.github.io/styleguide/',
      },
      {
        id: 'visor-logic-complexity',
        shortDescription: {
          text: 'Logic complexity issue',
        },
        fullDescription: {
          text: 'Code logic could be simplified or broken down into smaller, more manageable components.',
        },
        helpUri: 'https://refactoring.guru/',
      },
      {
        id: 'visor-documentation-missing',
        shortDescription: {
          text: 'Documentation missing',
        },
        fullDescription: {
          text: 'Public functions and complex logic should be documented for maintainability.',
        },
        helpUri: 'https://jsdoc.app/',
      },
    ];

    // Map Visor categories to rule IDs
    const categoryToRuleId: Record<string, string> = {
      security: 'visor-security-input-validation',
      performance: 'visor-performance-optimization',
      style: 'visor-style-consistency',
      logic: 'visor-logic-complexity',
      documentation: 'visor-documentation-missing',
    };

    // Map Visor severity to SARIF level
    const severityToLevel: Record<string, string> = {
      critical: 'error',
      error: 'error',
      warning: 'warning',
      info: 'note',
    };

    // Convert ReviewIssues to SARIF results
    const sarifResults = (issues || []).map((issue: ReviewIssue, _index: number) => {
      const ruleId = categoryToRuleId[issue.category] || 'visor-logic-complexity';
      const ruleIndex = rules.findIndex(rule => rule.id === ruleId);

      return {
        ruleId: ruleId,
        ruleIndex: ruleIndex,
        level: severityToLevel[issue.severity] || 'warning',
        message: {
          text: issue.message,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: issue.file,
                uriBaseId: '%SRCROOT%',
              },
              region: {
                startLine: issue.line,
                startColumn: 1,
              },
            },
          },
        ],
      };
    });

    // Construct the complete SARIF 2.1.0 structure
    const sarifReport = {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'Visor',
              version: '1.0.0',
              informationUri: 'https://github.com/your-org/visor',
              rules: rules,
            },
          },
          results: sarifResults,
        },
      ],
    };

    return JSON.stringify(sarifReport, null, 2);
  }

  /**
   * Format analysis results as markdown
   */
  static formatAsMarkdown(result: AnalysisResult, options: OutputFormatterOptions = {}): string {
    const { showDetails = false, groupByCategory = true } = options;
    let output = '';

    // Filter out system-level issues (fail_if conditions, internal errors)
    const issues = (result.reviewSummary.issues || []).filter(
      issue => !(issue.file === 'system' && issue.line === 0)
    );
    const totalIssues = calculateTotalIssues(issues);
    const criticalIssues = calculateCriticalIssues(issues);

    // Header with summary
    output += `# Visor Analysis Results\n\n`;
    output += `## Summary\n\n`;
    output += `| Metric | Value |\n`;
    output += `|--------|-------|\n`;
    output += `| Total Issues | ${totalIssues} |\n`;
    output += `| Critical Issues | ${criticalIssues} |\n`;
    output += `| Files Analyzed | ${result.repositoryInfo.files.length} |\n`;
    output += `| Execution Time | ${result.executionTime}ms |\n`;
    output += `| Checks Executed | ${result.checksExecuted.join(', ')} |\n\n`;

    // Repository info
    output += `## Repository Information\n\n`;
    output += `- **Title**: ${result.repositoryInfo.title}\n`;
    output += `- **Author**: ${result.repositoryInfo.author}\n`;
    output += `- **Branch**: ${result.repositoryInfo.head} ← ${result.repositoryInfo.base}\n`;
    output += `- **Working Directory**: \`${result.repositoryInfo.workingDirectory}\`\n`;
    output += `- **Changes**: +${result.repositoryInfo.totalAdditions}/-${result.repositoryInfo.totalDeletions}\n\n`;

    // Issues
    if ((issues || []).length > 0) {
      if (groupByCategory) {
        const groupedComments = this.groupCommentsByCategory(convertIssuesToComments(issues || []));

        for (const [category, comments] of Object.entries(groupedComments)) {
          if (comments.length === 0) continue;

          const issueCount = comments.length;
          output += `## ${category.charAt(0).toUpperCase() + category.slice(1)} Issues (${issueCount} found)\n\n`;

          for (const comment of comments.slice(0, showDetails ? comments.length : 5)) {
            // Convert comment back to issue to access suggestion/replacement fields
            const issue = (issues || []).find(
              i => i.file === comment.file && i.line === comment.line
            );

            output += `### \`${comment.file}:${comment.line}\`\n`;
            output += `**Severity**: ${comment.severity.toUpperCase()}  \n`;
            output += `**Message**: ${comment.message}  \n`;

            // Add suggestion if available
            if (issue?.suggestion) {
              output += `**Suggestion**: ${issue.suggestion}  \n`;
            }

            // Add replacement code if available
            if (issue?.replacement) {
              // Determine language from file extension
              const ext = comment.file.split('.').pop() || '';
              const langMap: Record<string, string> = {
                js: 'javascript',
                jsx: 'javascript',
                ts: 'typescript',
                tsx: 'typescript',
                py: 'python',
                rb: 'ruby',
                go: 'go',
                java: 'java',
                cpp: 'cpp',
                c: 'c',
                cs: 'csharp',
                php: 'php',
                swift: 'swift',
                kt: 'kotlin',
                rs: 'rust',
                sh: 'bash',
                yaml: 'yaml',
                yml: 'yaml',
                json: 'json',
              };
              const lang = langMap[ext] || '';

              output += `\n**Suggested Fix**:\n\`\`\`${lang}\n${issue.replacement}\n\`\`\`\n`;
            }

            output += '\n';
          }

          if (!showDetails && comments.length > 5) {
            output += `<details>\n`;
            output += `<summary>Show ${comments.length - 5} more issues...</summary>\n\n`;

            for (const comment of comments.slice(5)) {
              // Convert comment back to issue to access suggestion/replacement fields
              const issue = (issues || []).find(
                i => i.file === comment.file && i.line === comment.line
              );

              output += `### \`${comment.file}:${comment.line}\`\n`;
              output += `**Severity**: ${comment.severity.toUpperCase()}  \n`;
              output += `**Message**: ${comment.message}  \n`;

              // Add suggestion if available
              if (issue?.suggestion) {
                output += `**Suggestion**: ${issue.suggestion}  \n`;
              }

              // Add replacement code if available
              if (issue?.replacement) {
                // Determine language from file extension
                const ext = comment.file.split('.').pop() || '';
                const langMap: Record<string, string> = {
                  js: 'javascript',
                  jsx: 'javascript',
                  ts: 'typescript',
                  tsx: 'typescript',
                  py: 'python',
                  rb: 'ruby',
                  go: 'go',
                  java: 'java',
                  cpp: 'cpp',
                  c: 'c',
                  cs: 'csharp',
                  php: 'php',
                  swift: 'swift',
                  kt: 'kotlin',
                  rs: 'rust',
                  sh: 'bash',
                  yaml: 'yaml',
                  yml: 'yaml',
                  json: 'json',
                };
                const lang = langMap[ext] || '';

                output += `\n**Suggested Fix**:\n\`\`\`${lang}\n${issue.replacement}\n\`\`\`\n`;
              }

              output += '\n';
            }

            output += `</details>\n\n`;
          }
        }
      } else {
        output += `## All Issues\n\n`;

        for (const issue of issues || []) {
          output += `### \`${issue.file}:${issue.line}\` (${issue.category})\n`;
          output += `**Severity**: ${issue.severity.toUpperCase()}  \n`;
          output += `**Message**: ${issue.message}  \n`;

          // Add suggestion if available
          if (issue.suggestion) {
            output += `**Suggestion**: ${issue.suggestion}  \n`;
          }

          // Add replacement code if available
          if (issue.replacement) {
            // Determine language from file extension
            const ext = issue.file.split('.').pop() || '';
            const langMap: Record<string, string> = {
              js: 'javascript',
              jsx: 'javascript',
              ts: 'typescript',
              tsx: 'typescript',
              py: 'python',
              rb: 'ruby',
              go: 'go',
              java: 'java',
              cpp: 'cpp',
              c: 'c',
              cs: 'csharp',
              php: 'php',
              swift: 'swift',
              kt: 'kotlin',
              rs: 'rust',
              sh: 'bash',
              yaml: 'yaml',
              yml: 'yaml',
              json: 'json',
            };
            const lang = langMap[ext] || '';

            output += `\n**Suggested Fix**:\n\`\`\`${lang}\n${issue.replacement}\n\`\`\`\n`;
          }

          output += '\n';
        }
      }
    } else {
      output += `## No Issues Found\n\n`;
      output += `Great job! No issues were detected in the analyzed code.\n\n`;
    }

    // Files (if requested)
    if (options.includeFiles && result.repositoryInfo.files.length > 0) {
      output += `## Files Changed\n\n`;
      output += `| File | Status | Changes |\n`;
      output += `|------|--------|---------|\n`;

      for (const file of result.repositoryInfo.files) {
        const statusEmoji = this.getFileStatusEmoji(file.status);
        output += `| \`${file.filename}\` | ${statusEmoji} ${file.status} | +${file.additions}/-${file.deletions} |\n`;
      }
      output += '\n';
    }

    // Footer
    if (options.includeTimestamp) {
      output += `---\n`;
      output += `*Generated by Visor at ${result.timestamp}*\n`;
    }

    return output;
  }

  private static groupCommentsByCategory(
    comments: ReviewComment[]
  ): Record<string, ReviewComment[]> {
    const grouped: Record<string, ReviewComment[]> = {
      security: [],
      performance: [],
      style: [],
      logic: [],
      documentation: [],
    };

    for (const comment of comments) {
      if (!grouped[comment.category]) {
        grouped[comment.category] = [];
      }
      grouped[comment.category].push(comment);
    }

    return grouped;
  }

  /**
   * Convert ReviewIssue to ReviewComment for backward compatibility
   */
  private static issueToComment(issue: ReviewIssue | ReviewComment): ReviewComment {
    // If it's already a ReviewComment, return as-is
    if ('ruleId' in issue) {
      return {
        file: issue.file,
        line: issue.line,
        message: issue.message,
        severity: issue.severity,
        category: issue.category,
      };
    }
    return issue;
  }

  /**
   * Group issues by category for display
   */
  private static groupIssuesByCategory(
    issues: (ReviewIssue | ReviewComment)[]
  ): Record<string, ReviewComment[]> {
    const grouped: Record<string, ReviewComment[]> = {
      security: [],
      performance: [],
      style: [],
      logic: [],
      documentation: [],
    };

    for (const issue of issues) {
      const comment = this.issueToComment(issue);
      if (!grouped[comment.category]) {
        grouped[comment.category] = [];
      }
      grouped[comment.category].push(comment);
    }

    return grouped;
  }

  private static formatSeverity(severity: string): string {
    const severityMap: Record<string, string> = {
      info: 'INFO',
      warning: 'WARNING',
      error: 'ERROR',
      critical: '🔥 CRITICAL',
    };
    return severityMap[severity.toLowerCase()] || severity.toUpperCase();
  }

  private static getFileStatusEmoji(status: string): string {
    const statusMap: Record<string, string> = {
      added: 'A',
      removed: 'D',
      modified: 'M',
      renamed: 'R',
    };
    return statusMap[status] || 'U';
  }

  private static getSeverityColor(severity: string): string {
    const colorMap: Record<string, string> = {
      critical: 'red',
      error: 'red',
      warning: 'yellow',
      info: 'cyan',
    };
    return colorMap[severity] || 'white';
  }

  private static truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  private static wrapText(text: string, width: number): string {
    if (text.length <= width) return text;

    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        // Break overly-long words to avoid pathological wrapping in cli-table3
        if (word.length > width) {
          const chunks = word.match(new RegExp(`.{1,${width}}`, 'g')) || [word];
          // First chunk becomes current line, the rest are full lines
          currentLine = chunks.shift() || '';
          for (const chunk of chunks) lines.push(chunk);
        } else {
          currentLine = word;
        }
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines.join('\n');
  }

  // Truncate any cell content defensively
  private static truncateCell(text: string): string {
    if (text.length <= OutputFormatters.MAX_CELL_CHARS) return text;
    return text.substring(0, OutputFormatters.MAX_CELL_CHARS - 12) + '\n… [truncated]\n';
  }

  // Safer wrapper that first wraps, then truncates
  private static safeWrapAndTruncate(text: string, width: number): string {
    return this.truncateCell(this.wrapText(text, width));
  }

  // Format code blocks with line and width limits to keep rendering fast
  private static formatCodeBlock(code: string): string {
    const lines = code.split('\n');
    const limited = lines.slice(0, OutputFormatters.MAX_CODE_LINES).map(line => {
      // Soft-wrap code lines to avoid cli-table heavy wrapping
      const chunks = line.match(new RegExp(`.{1,${OutputFormatters.WRAP_WIDTH_CODE}}`, 'g')) || [
        '',
      ];
      return chunks.map(c => '  ' + c).join('\n');
    });
    let out = limited.join('\n');
    // Indicate truncation of extra lines
    if (lines.length > OutputFormatters.MAX_CODE_LINES) {
      out += `\n  … [${lines.length - OutputFormatters.MAX_CODE_LINES} more lines truncated]`;
    }
    return this.truncateCell(out);
  }
}
