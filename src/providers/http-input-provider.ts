import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';

/**
 * Check provider that receives input from HTTP webhooks and makes it available to dependent checks
 */
export class HttpInputProvider extends CheckProvider {
  private liquid: Liquid;
  private webhookContext?: Map<string, unknown>;

  constructor() {
    super();
    this.liquid = createExtendedLiquid();
  }

  /**
   * Set webhook context for accessing webhook data
   */
  setWebhookContext(webhookContext: Map<string, unknown>): void {
    this.webhookContext = webhookContext;
  }

  getName(): string {
    return 'http_input';
  }

  getDescription(): string {
    return 'Receive and process HTTP webhook input data for use by dependent checks';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'http_input'
    if (cfg.type !== 'http_input') {
      return false;
    }

    // Must have endpoint specified
    if (typeof cfg.endpoint !== 'string' || !cfg.endpoint) {
      return false;
    }

    // Transform is optional but must be string if provided
    if (cfg.transform !== undefined && typeof cfg.transform !== 'string') {
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    const endpoint = config.endpoint as string;
    const transform = config.transform as string | undefined;

    // In actual implementation, this would receive data from the webhook server
    // For now, we'll check if there's webhook data in the execution context
    const webhookData = this.getWebhookData(endpoint);

    if (!webhookData) {
      return {
        issues: [],
      };
    }

    // Apply transformation if specified
    let processedData = webhookData;
    if (transform) {
      try {
        const templateContext = {
          webhook: webhookData,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            base: prInfo.base,
            head: prInfo.head,
          },
        };
        const rendered = await this.liquid.parseAndRender(transform, templateContext);
        processedData = JSON.parse(rendered);
        logger.verbose(`✓ Applied webhook transform successfully`);
      } catch (error) {
        logger.error(`✗ Failed to transform webhook data: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return {
          issues: [
            {
              file: 'webhook_input',
              line: 0,
              ruleId: 'webhook_input/transform_error',
              message: `Failed to transform webhook data: ${error instanceof Error ? error.message : 'Unknown error'}`,
              severity: 'error',
              category: 'logic',
            },
          ],
        };
      }
    }

    // Return the processed data as a custom field for dependent checks to access
    // This will be available in outputs for dependent checks
    return {
      issues: [],
      // Add custom data field that will be passed through
      data: processedData,
    } as ReviewSummary & { data: unknown };
  }

  private getWebhookData(endpoint: string): Record<string, unknown> | null {
    // Use webhook context if available (preferred method)
    if (this.webhookContext) {
      return (this.webhookContext.get(endpoint) as Record<string, unknown>) || null;
    }

    // Fallback to global store for backwards compatibility
    // This should be removed once all usages are migrated
    const globalWebhookStore = (global as Record<string, unknown>).__visor_webhook_data as
      | Map<string, Record<string, unknown>>
      | undefined;
    if (globalWebhookStore && globalWebhookStore.get) {
      console.warn(
        'HttpInputProvider: Using deprecated global webhook store. Please use webhook context instead.'
      );
      return globalWebhookStore.get(endpoint) || null;
    }

    return null;
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'endpoint', 'transform', 'on', 'depends_on', 'if', 'group'];
  }

  async isAvailable(): Promise<boolean> {
    // Available if webhook server is configured and running
    return true;
  }

  getRequirements(): string[] {
    return [
      'HTTP server must be configured and running',
      'Valid endpoint path specified',
      'Optional: Transform template for data processing',
    ];
  }
}
