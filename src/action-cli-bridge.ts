import { CheckType } from './types/cli';
import { GitHubActionInputs, GitHubContext } from './types/github';

export { GitHubActionInputs, GitHubContext };

export interface ActionCliOutput {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  cliOutput?: {
    reviewScore?: number;
    issuesFound?: number;
    autoReviewCompleted?: boolean;
  };
}

/**
 * Minimal bridge between GitHub Action and Visor
 * Provides utility functions for parsing GitHub Action inputs
 */
export class ActionCliBridge {
  private githubToken: string;
  private context: GitHubContext;

  constructor(githubToken: string, context: GitHubContext) {
    this.githubToken = githubToken;
    this.context = context;
  }

  /**
   * Determine if legacy Visor inputs are present
   */
  public shouldUseVisor(inputs: GitHubActionInputs): boolean {
    return !!(inputs['visor-config-path'] || inputs['visor-checks']);
  }

  /**
   * Parse GitHub Action inputs into CLI arguments
   * Note: No validation - let the config system handle it
   */
  public parseGitHubInputsToCliArgs(inputs: GitHubActionInputs): string[] {
    const args: string[] = [];

    // Handle config path
    const configPath = inputs['visor-config-path'] || inputs['config-path'];
    if (configPath) {
      args.push('--config', configPath);
    }

    // Handle checks (no validation - config-driven)
    const checks = inputs['visor-checks'] || inputs.checks;
    if (checks) {
      const checkList = checks.split(',').map((c: string) => c.trim()).filter(Boolean);
      for (const check of checkList) {
        args.push('--check', check);
      }
    }

    // Always add output format
    args.push('--output', 'json');

    return args;
  }

  /**
   * Merge CLI outputs with legacy Action outputs
   */
  public mergeActionAndCliOutputs(
    inputs: GitHubActionInputs,
    cliResult: ActionCliOutput,
    legacyOutputs: Record<string, string> = {}
  ): Record<string, string> {
    const outputs = { ...legacyOutputs };

    if (cliResult.success && cliResult.cliOutput) {
      if (cliResult.cliOutput.reviewScore !== undefined) {
        outputs['review-score'] = String(cliResult.cliOutput.reviewScore);
      }
      if (cliResult.cliOutput.issuesFound !== undefined) {
        outputs['issues-found'] = String(cliResult.cliOutput.issuesFound);
      }
      if (cliResult.cliOutput.autoReviewCompleted !== undefined) {
        outputs['auto-review-completed'] = String(cliResult.cliOutput.autoReviewCompleted);
      }
    }

    return outputs;
  }

  /**
   * Cleanup method for compatibility (no-op since we don't create temp files)
   */
  public async cleanup(): Promise<void> {
    // No-op: we don't create temporary files anymore
    return Promise.resolve();
  }
}
