import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';

/**
 * Log levels supported by the log provider
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Check provider that outputs debugging and logging information.
 * Useful for troubleshooting check workflows and understanding execution flow.
 */
export class LogCheckProvider extends CheckProvider {
  private liquid: Liquid;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      strictVariables: false,
      strictFilters: false,
    });
  }

  getName(): string {
    return 'log';
  }

  getDescription(): string {
    return 'Output debugging and logging information for troubleshooting check workflows';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'log'
    if (cfg.type !== 'log') {
      return false;
    }

    // Message is required
    if (!cfg.message || typeof cfg.message !== 'string') {
      return false;
    }

    // Validate log level if provided
    if (cfg.level && !['debug', 'info', 'warn', 'error'].includes(cfg.level as string)) {
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    const message = config.message as string;
    const level = (config.level as LogLevel) || 'info';
    const includePrContext = config.include_pr_context !== false;
    const includeDependencies = config.include_dependencies !== false;
    const includeMetadata = config.include_metadata !== false;

    // Prepare template context
    const templateContext = this.buildTemplateContext(
      prInfo,
      dependencyResults,
      includePrContext,
      includeDependencies,
      includeMetadata,
      config.__outputHistory as Map<string, unknown[]> | undefined
    );

    // Render the log message template
    const renderedMessage = await this.liquid.parseAndRender(message, templateContext);

    // Build the log output
    const logOutput = this.formatLogOutput(
      level,
      renderedMessage,
      templateContext,
      includePrContext,
      includeDependencies,
      includeMetadata
    );

    // Route through centralized logger to keep stdout clean in JSON/SARIF
    if (level === 'error') logger.error(logOutput);
    else if (level === 'warn') logger.warn(logOutput);
    else if (level === 'debug') logger.debug(logOutput);
    else logger.info(logOutput);

    // Return with the log content as custom data for dependent checks
    return {
      issues: [],
      // Add log output as custom field
      logOutput,
    } as ReviewSummary & { logOutput: string };
  }

  private buildTemplateContext(
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    _includePrContext: boolean = true,
    _includeDependencies: boolean = true,
    includeMetadata: boolean = true,
    outputHistory?: Map<string, unknown[]>
  ): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    // Always provide pr context for template rendering
    context.pr = {
      number: prInfo.number,
      title: prInfo.title,
      body: prInfo.body,
      author: prInfo.author,
      base: prInfo.base,
      head: prInfo.head,
      totalAdditions: prInfo.totalAdditions,
      totalDeletions: prInfo.totalDeletions,
      files: prInfo.files.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })),
    };

    // Add convenience data
    context.filenames = prInfo.files.map(f => f.filename);
    context.fileCount = prInfo.files.length;

    // Always provide dependency data for template rendering
    if (dependencyResults) {
      const dependencies: Record<string, unknown> = {};
      const outputs: Record<string, unknown> = {};
      const history: Record<string, unknown[]> = {};
      context.dependencyCount = dependencyResults.size;

      for (const [checkName, result] of dependencyResults.entries()) {
        dependencies[checkName] = {
          issueCount: result.issues?.length || 0,
          suggestionCount: 0,
          issues: result.issues || [],
        };

        // Add outputs namespace for accessing dependency results directly
        const summary = result as import('../reviewer').ReviewSummary & { output?: unknown };
        outputs[checkName] = summary.output !== undefined ? summary.output : summary;
      }

      // Add history for each check if available
      if (outputHistory) {
        for (const [checkName, historyArray] of outputHistory) {
          history[checkName] = historyArray;
        }
      }

      // Attach history to the outputs object
      (outputs as any).history = history;

      context.dependencies = dependencies;
      context.outputs = outputs;
      // Alias: outputs_history mirrors outputs.history for consistency
      (context as any).outputs_history = history;
    }

    if (includeMetadata) {
      context.metadata = {
        timestamp: new Date().toISOString(),
        executionTime: Date.now(),
        nodeVersion: process.version,
        platform: process.platform,
        workingDirectory: process.cwd(),
      };
    }

    return context;
  }

  private formatLogOutput(
    level: LogLevel,
    message: string,
    templateContext: Record<string, unknown>,
    includePrContext: boolean,
    includeDependencies: boolean,
    includeMetadata: boolean
  ): string {
    const sections: string[] = [];

    // Log level and message
    const levelEmoji = this.getLevelEmoji(level);
    sections.push(`${levelEmoji} **${level.toUpperCase()}**: ${message}`);

    // PR context section
    if (includePrContext && templateContext.pr) {
      const pr = templateContext.pr as Record<string, unknown>;
      sections.push('');
      sections.push('### PR Context');
      sections.push(`- **PR #${pr.number}**: ${pr.title}`);
      sections.push(`- **Author**: ${pr.author}`);
      sections.push(`- **Base**: ${pr.base} → **Head**: ${pr.head}`);
      sections.push(`- **Changes**: +${pr.totalAdditions} -${pr.totalDeletions}`);
      sections.push(`- **Files Modified**: ${templateContext.fileCount}`);
    }

    // Dependencies section
    if (includeDependencies && templateContext.dependencies) {
      const deps = templateContext.dependencies as Record<string, Record<string, unknown>>;
      sections.push('');
      sections.push('### Dependency Results');

      if (Object.keys(deps).length === 0) {
        sections.push('- No dependency results available');
      } else {
        for (const [checkName, result] of Object.entries(deps)) {
          sections.push(
            `- **${checkName}**: ${result.issueCount} issues, ${result.suggestionCount} suggestions`
          );
        }
      }
    }

    // Metadata section
    if (includeMetadata && templateContext.metadata) {
      const meta = templateContext.metadata as Record<string, unknown>;
      sections.push('');
      sections.push('### Execution Metadata');
      sections.push(`- **Timestamp**: ${meta.timestamp}`);
      sections.push(`- **Node Version**: ${meta.nodeVersion}`);
      sections.push(`- **Platform**: ${meta.platform}`);
      sections.push(`- **Working Directory**: ${meta.workingDirectory}`);
    }

    return sections.join('\n');
  }

  private getLevelEmoji(level: LogLevel): string {
    switch (level) {
      case 'debug':
        return '🐛';
      case 'info':
        return 'ℹ️';
      case 'warn':
        return '⚠️';
      case 'error':
        return '❌';
      default:
        return 'ℹ️';
    }
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'message',
      'level',
      'include_pr_context',
      'include_dependencies',
      'include_metadata',
      'group',
      'command',
      'depends_on',
      'on',
      'if',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Log provider is always available
    return true;
  }

  getRequirements(): string[] {
    return [
      'No external dependencies required',
      'Used for debugging and logging check execution flow',
    ];
  }
}
