import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';

/**
 * No-operation check provider that doesn't perform any analysis.
 *
 * This provider is designed for command orchestration - it allows creating
 * checks that exist purely to trigger other checks through dependencies.
 *
 * Example use case: A "/review" command that triggers multiple analysis checks
 * without performing any analysis itself.
 */
export class NoopCheckProvider extends CheckProvider {
  getName(): string {
    return 'noop';
  }

  getDescription(): string {
    return 'No-operation provider for command orchestration and dependency triggering';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'noop'
    if (cfg.type !== 'noop') {
      return false;
    }

    return true;
  }

  async execute(
    _prInfo: PRInfo,
    _config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    // Noop provider doesn't perform any analysis
    // It exists purely for command orchestration and dependency triggering
    return {
      issues: [],
    };
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'command', 'depends_on', 'on', 'if', 'group'];
  }

  async isAvailable(): Promise<boolean> {
    // Noop provider is always available
    return true;
  }

  getRequirements(): string[] {
    return [
      'No external dependencies required',
      'Used for command orchestration and dependency triggering',
    ];
  }
}
