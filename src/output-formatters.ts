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

export interface AnalysisResult {
  repositoryInfo: GitRepositoryInfo;
  reviewSummary: ReviewSummary;
  executionTime: number;
  timestamp: string;
  checksExecuted: string[];
  debug?: DebugInfo; // Optional debug information when debug mode is enabled
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
  /**
   * Format analysis results as a table using cli-table3
   */
  static formatAsTable(result: AnalysisResult, options: OutputFormatterOptions = {}): string {
    const { showDetails = false, groupByCategory = true } = options;
    let output = '';

    // Calculate metrics from issues once at the top
    const issues = result.reviewSummary.issues || [];
    const totalIssues = issues.length;
    const criticalIssues = issues.filter(i => i.severity === 'critical').length;
    // Summary table
    const summaryTable = new CliTable3({
      head: ['Metric', 'Value'],
      colWidths: [25, 30],
      style: {
        head: ['cyan', 'bold'],
        border: ['grey'],
      },
    });

    summaryTable.push(
      ['Total Issues', totalIssues.toString()],
      ['Critical Issues', criticalIssues.toString()],
      ['Files Analyzed', result.repositoryInfo.files.length.toString()],
      ['Total Additions', result.repositoryInfo.totalAdditions.toString()],
      ['Total Deletions', result.repositoryInfo.totalDeletions.toString()],
      ['Execution Time', `${result.executionTime}ms`],
      ['Checks Executed', result.checksExecuted.join(', ')]
    );

    output += '📊 Analysis Summary\n';
    output += summaryTable.toString() + '\n';

    output += '\n';

    // Issues by category table
    if (issues.length > 0) {
      if (groupByCategory) {
        const groupedComments = this.groupCommentsByCategory(convertIssuesToComments(issues));

        for (const [category, comments] of Object.entries(groupedComments)) {
          if (comments.length === 0) continue;

          const categoryTable = new CliTable3({
            head: ['File', 'Line', 'Severity', 'Message'],
            colWidths: [25, 8, 15, 60],
            wordWrap: true,
            style: {
              head: ['cyan', 'bold'],
              border: ['grey'],
            },
          });

          const emoji = this.getCategoryEmoji(category);
          output += `${emoji} ${category.toUpperCase()} Issues (${comments.length})\n`;

          for (const comment of comments.slice(0, showDetails ? comments.length : 5)) {
            // Convert comment back to issue to access suggestion/replacement fields
            const issue = issues.find(i => i.file === comment.file && i.line === comment.line);

            let messageContent = this.wrapText(comment.message, 55);

            // Add suggestion if available
            if (issue?.suggestion) {
              messageContent += '\n💡 ' + this.wrapText(issue.suggestion, 53);
            }

            // Add replacement code if available
            if (issue?.replacement) {
              messageContent +=
                '\n📝 Code fix:\n' +
                issue.replacement
                  .split('\n')
                  .map(line => '  ' + line)
                  .join('\n');
            }

            categoryTable.push([
              comment.file,
              comment.line.toString(),
              { content: this.formatSeverity(comment.severity), hAlign: 'center' },
              messageContent,
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
          wordWrap: true,
          style: {
            head: ['cyan', 'bold'],
            border: ['grey'],
          },
        });

        output += '🔍 All Issues\n';

        for (const issue of issues.slice(0, showDetails ? undefined : 10)) {
          let messageContent = this.wrapText(issue.message, 45);

          // Add suggestion if available
          if (issue.suggestion) {
            messageContent += '\n💡 ' + this.wrapText(issue.suggestion, 43);
          }

          // Add replacement code if available
          if (issue.replacement) {
            messageContent +=
              '\n📝 Code fix:\n' +
              issue.replacement
                .split('\n')
                .map(line => '  ' + line)
                .join('\n');
          }

          issuesTable.push([
            this.truncateText(issue.file, 18),
            issue.line.toString(),
            issue.category,
            this.formatSeverity(issue.severity),
            messageContent,
          ]);
        }

        output += issuesTable.toString() + '\n\n';
      }
    } else {
      output += '✅ No issues found!\n\n';
    }

    // Suggestions table
    if (result.reviewSummary.suggestions.length > 0) {
      const suggestionsTable = new CliTable3({
        head: ['#', 'Suggestion'],
        colWidths: [5, 70],
        style: {
          head: ['cyan', 'bold'],
          border: ['grey'],
        },
      });

      output += '💡 Suggestions\n';

      result.reviewSummary.suggestions.forEach((suggestion, index) => {
        suggestionsTable.push([(index + 1).toString(), this.wrapText(suggestion, 65)]);
      });

      output += suggestionsTable.toString() + '\n\n';
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

      output += '📁 Files Changed\n';

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
    // Calculate metrics from issues
    const issues = result.reviewSummary.issues;
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
        ? this.groupCommentsByCategory(convertIssuesToComments(issues))
        : issues,
      suggestions: result.reviewSummary.suggestions,
      files: options.includeFiles ? result.repositoryInfo.files : undefined,
      debug: result.debug, // Include debug information when available
    };

    return JSON.stringify(jsonResult, null, 2);
  }

  /**
   * Format analysis results as SARIF 2.1.0
   */
  static formatAsSarif(result: AnalysisResult, _options: OutputFormatterOptions = {}): string {
    // Get issues from result
    const issues = result.reviewSummary.issues;

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
    const sarifResults = issues.map((issue: ReviewIssue, _index: number) => {
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

    // Calculate metrics from issues
    const issues = result.reviewSummary.issues;
    const totalIssues = calculateTotalIssues(issues);
    const criticalIssues = calculateCriticalIssues(issues);

    // Header with summary
    output += `# 🔍 Visor Analysis Results\n\n`;
    output += `## 📊 Summary\n\n`;
    output += `| Metric | Value |\n`;
    output += `|--------|-------|\n`;
    output += `| Total Issues | ${totalIssues} |\n`;
    output += `| Critical Issues | ${criticalIssues} |\n`;
    output += `| Files Analyzed | ${result.repositoryInfo.files.length} |\n`;
    output += `| Execution Time | ${result.executionTime}ms |\n`;
    output += `| Checks Executed | ${result.checksExecuted.join(', ')} |\n\n`;

    // Repository info
    output += `## 📁 Repository Information\n\n`;
    output += `- **Title**: ${result.repositoryInfo.title}\n`;
    output += `- **Author**: ${result.repositoryInfo.author}\n`;
    output += `- **Branch**: ${result.repositoryInfo.head} ← ${result.repositoryInfo.base}\n`;
    output += `- **Working Directory**: \`${result.repositoryInfo.workingDirectory}\`\n`;
    output += `- **Changes**: +${result.repositoryInfo.totalAdditions}/-${result.repositoryInfo.totalDeletions}\n\n`;

    // Issues
    if (issues.length > 0) {
      if (groupByCategory) {
        const groupedComments = this.groupCommentsByCategory(convertIssuesToComments(issues));

        for (const [category, comments] of Object.entries(groupedComments)) {
          if (comments.length === 0) continue;

          const emoji = this.getCategoryEmoji(category);
          const issueCount = comments.length;
          output += `## ${emoji} ${category.charAt(0).toUpperCase() + category.slice(1)} Issues (${issueCount} found)\n\n`;

          for (const comment of comments.slice(0, showDetails ? comments.length : 5)) {
            // Convert comment back to issue to access suggestion/replacement fields
            const issue = issues.find(i => i.file === comment.file && i.line === comment.line);

            const severityEmoji = this.getSeverityEmoji(comment.severity);
            output += `### ${severityEmoji} \`${comment.file}:${comment.line}\`\n`;
            output += `**Severity**: ${comment.severity.toUpperCase()}  \n`;
            output += `**Message**: ${comment.message}  \n`;

            // Add suggestion if available
            if (issue?.suggestion) {
              output += `**💡 Suggestion**: ${issue.suggestion}  \n`;
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

              output += `\n**📝 Suggested Fix**:\n\`\`\`${lang}\n${issue.replacement}\n\`\`\`\n`;
            }

            output += '\n';
          }

          if (!showDetails && comments.length > 5) {
            output += `<details>\n`;
            output += `<summary>Show ${comments.length - 5} more issues...</summary>\n\n`;

            for (const comment of comments.slice(5)) {
              // Convert comment back to issue to access suggestion/replacement fields
              const issue = issues.find(i => i.file === comment.file && i.line === comment.line);

              const severityEmoji = this.getSeverityEmoji(comment.severity);
              output += `### ${severityEmoji} \`${comment.file}:${comment.line}\`\n`;
              output += `**Severity**: ${comment.severity.toUpperCase()}  \n`;
              output += `**Message**: ${comment.message}  \n`;

              // Add suggestion if available
              if (issue?.suggestion) {
                output += `**💡 Suggestion**: ${issue.suggestion}  \n`;
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

                output += `\n**📝 Suggested Fix**:\n\`\`\`${lang}\n${issue.replacement}\n\`\`\`\n`;
              }

              output += '\n';
            }

            output += `</details>\n\n`;
          }
        }
      } else {
        output += `## 🔍 All Issues\n\n`;

        for (const issue of issues) {
          const severityEmoji = this.getSeverityEmoji(issue.severity);
          output += `### ${severityEmoji} \`${issue.file}:${issue.line}\` (${issue.category})\n`;
          output += `**Severity**: ${issue.severity.toUpperCase()}  \n`;
          output += `**Message**: ${issue.message}  \n`;

          // Add suggestion if available
          if (issue.suggestion) {
            output += `**💡 Suggestion**: ${issue.suggestion}  \n`;
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

            output += `\n**📝 Suggested Fix**:\n\`\`\`${lang}\n${issue.replacement}\n\`\`\`\n`;
          }

          output += '\n';
        }
      }
    } else {
      output += `## ✅ No Issues Found\n\n`;
      output += `Great job! No issues were detected in the analyzed code.\n\n`;
    }

    // Suggestions
    if (result.reviewSummary.suggestions.length > 0) {
      output += `## 💡 Recommendations\n\n`;

      result.reviewSummary.suggestions.forEach((suggestion, index) => {
        output += `${index + 1}. ${suggestion}\n`;
      });
      output += '\n';
    }

    // Files (if requested)
    if (options.includeFiles && result.repositoryInfo.files.length > 0) {
      output += `## 📁 Files Changed\n\n`;
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

  private static getCategoryEmoji(category: string): string {
    const emojiMap: Record<string, string> = {
      security: '🔒',
      performance: '📈',
      style: '🎨',
      logic: '🧠',
      documentation: '📚',
    };
    return emojiMap[category] || '📝';
  }

  private static getSeverityEmoji(severity: string): string {
    const emojiMap: Record<string, string> = {
      critical: '🔥',
      error: '🚨',
      warning: '⚠️',
      info: 'ℹ️',
    };
    return emojiMap[severity] || '📝';
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
    const emojiMap: Record<string, string> = {
      added: '✅',
      removed: '❌',
      modified: '📝',
      renamed: '🔄',
    };
    return emojiMap[status] || '📄';
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
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines.join('\n');
  }
}
