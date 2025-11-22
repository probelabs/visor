/**
 * Git Checkout Provider
 *
 * Provides git checkout functionality using worktrees for efficient
 * multi-workflow execution.
 */

import { CheckProvider } from './check-provider.interface';
import { worktreeManager } from '../utils/worktree-manager';
import { logger } from '../logger';
import { createExtendedLiquid } from '../liquid-extensions';
import { buildSandboxEnv } from '../utils/env-exposure';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary, ReviewIssue } from '../reviewer';
import type { CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import type { GitCheckoutConfig, GitCheckoutOutput } from '../types/git-checkout';

export class GitCheckoutProvider extends CheckProvider {
  private liquid = createExtendedLiquid();

  getName(): string {
    return 'git-checkout';
  }

  getDescription(): string {
    return 'Checkout code from git repositories using worktrees for efficient multi-workflow execution';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      logger.error('Invalid config: must be an object');
      return false;
    }

    const checkoutConfig = config as GitCheckoutConfig;

    // Required: ref
    if (!checkoutConfig.ref || typeof checkoutConfig.ref !== 'string') {
      logger.error('Invalid config: ref is required and must be a string');
      return false;
    }

    // Optional validations
    if (checkoutConfig.fetch_depth !== undefined) {
      if (typeof checkoutConfig.fetch_depth !== 'number' || checkoutConfig.fetch_depth < 0) {
        logger.error('Invalid config: fetch_depth must be a non-negative number');
        return false;
      }
    }

    if (checkoutConfig.fetch_tags !== undefined && typeof checkoutConfig.fetch_tags !== 'boolean') {
      logger.error('Invalid config: fetch_tags must be a boolean');
      return false;
    }

    if (checkoutConfig.submodules !== undefined) {
      const validSubmoduleValues = [true, false, 'recursive'];
      if (!validSubmoduleValues.includes(checkoutConfig.submodules as any)) {
        logger.error('Invalid config: submodules must be true, false, or "recursive"');
        return false;
      }
    }

    if (checkoutConfig.sparse_checkout !== undefined && !Array.isArray(checkoutConfig.sparse_checkout)) {
      logger.error('Invalid config: sparse_checkout must be an array');
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const checkoutConfig = config as unknown as GitCheckoutConfig;
    const issues: ReviewIssue[] = [];

    try {
      // Build template context
      const templateContext = this.buildTemplateContext(prInfo, dependencyResults, context, checkoutConfig);

      // Resolve dynamic variables
      const resolvedRef = await this.liquid.parseAndRender(checkoutConfig.ref, templateContext);
      const resolvedRepository = checkoutConfig.repository
        ? await this.liquid.parseAndRender(checkoutConfig.repository, templateContext)
        : process.env.GITHUB_REPOSITORY || 'unknown/unknown';
      const resolvedToken = checkoutConfig.token ? await this.liquid.parseAndRender(checkoutConfig.token, templateContext) : undefined;
      const resolvedWorkingDirectory = checkoutConfig.working_directory
        ? await this.liquid.parseAndRender(checkoutConfig.working_directory, templateContext)
        : undefined;

      logger.info(`Checking out repository: ${resolvedRepository}@${resolvedRef}`);

      // Get repository URL
      const repoUrl = worktreeManager.getRepositoryUrl(resolvedRepository, resolvedToken);

      // Create worktree
      const worktree = await worktreeManager.createWorktree(resolvedRepository, repoUrl, resolvedRef, {
        token: resolvedToken,
        workingDirectory: resolvedWorkingDirectory,
        clean: checkoutConfig.clean !== false, // Default: true
        workflowId: (context as any)?.workflowId,
        fetchDepth: checkoutConfig.fetch_depth,
      });

      // Build output
      const output: GitCheckoutOutput = {
        success: true,
        path: worktree.path,
        ref: resolvedRef,
        commit: worktree.commit,
        worktree_id: worktree.id,
        repository: resolvedRepository,
        is_worktree: true,
      };

      logger.info(`Successfully checked out ${resolvedRepository}@${resolvedRef} to ${worktree.path}`);

      return {
        issues,
        output,
      } as any;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Git checkout failed: ${errorMessage}`);

      // Add error issue
      issues.push({
        file: 'git-checkout',
        line: 0,
        ruleId: 'git-checkout/error',
        message: `Failed to checkout code: ${errorMessage}`,
        severity: 'error',
        category: 'logic',
      });

      // Build error output
      const output: GitCheckoutOutput = {
        success: false,
        error: errorMessage,
      };

      return {
        issues,
        output,
      } as any;
    }
  }

  /**
   * Build template context for variable resolution
   */
  private buildTemplateContext(
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext,
    config?: GitCheckoutConfig
  ): Record<string, any> {
    // Build outputs object from dependency results
    const outputsObj: Record<string, any> = {};
    if (dependencyResults) {
      for (const [checkName, result] of dependencyResults.entries()) {
        outputsObj[checkName] = (result as any).output !== undefined ? (result as any).output : result;
      }
    }

    // Build outputs history
    const outputHistory = config?.__outputHistory;
    const historyObj: Record<string, any[]> = {};
    if (outputHistory) {
      for (const [checkName, history] of outputHistory.entries()) {
        historyObj[checkName] = history;
      }
    }

    // Safe environment variables
    const safeEnv = buildSandboxEnv(process.env);

    // Template context
    return {
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        author: prInfo.author,
        head: prInfo.head,
        base: prInfo.base,
        repo: process.env.GITHUB_REPOSITORY || '',
        files: prInfo.files,
      },
      files: prInfo.files,
      outputs: outputsObj,
      outputs_history: historyObj,
      env: safeEnv,
      inputs: context?.workflowInputs,
    };
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'ref',
      'repository',
      'token',
      'fetch_depth',
      'fetch_tags',
      'submodules',
      'working_directory',
      'use_worktree',
      'clean',
      'sparse_checkout',
      'lfs',
      'timeout',
      'criticality',
      'assume',
      'guarantee',
      'cleanup_on_failure',
      'persist_worktree',
      'depends_on',
      'if',
      'fail_if',
      'on',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Check if git is available
    try {
      const { commandExecutor } = await import('../utils/command-executor');
      const result = await commandExecutor.execute('git --version', { timeout: 5000 });
      return result.exitCode === 0;
    } catch (error) {
      return false;
    }
  }

  getRequirements(): string[] {
    return ['git'];
  }
}
