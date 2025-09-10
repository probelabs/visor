import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { AIReviewService, AIReviewConfig } from '../ai-review-service';

/**
 * AI-powered check provider using probe-chat
 */
export class AICheckProvider extends CheckProvider {
  private aiReviewService: AIReviewService;

  constructor() {
    super();
    this.aiReviewService = new AIReviewService();
  }

  getName(): string {
    return 'ai';
  }

  getDescription(): string {
    return 'AI-powered code review using Google Gemini, Anthropic Claude, or OpenAI GPT models';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'ai'
    if (cfg.type !== 'ai') {
      return false;
    }

    // Check for prompt or focus
    const prompt = cfg.prompt || cfg.focus;
    if (typeof prompt !== 'string') {
      return false;
    }

    // Validate focus if specified
    if (cfg.focus && !['security', 'performance', 'style', 'all'].includes(cfg.focus as string)) {
      return false;
    }

    // Validate AI provider config if present
    if (cfg.ai) {
      if (
        cfg.ai.provider &&
        !['google', 'anthropic', 'openai'].includes(cfg.ai.provider as string)
      ) {
        return false;
      }
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>
  ): Promise<ReviewSummary> {
    // Extract AI configuration - only set properties that are explicitly provided
    const aiConfig: AIReviewConfig = {};

    if (config.ai) {
      // Only set properties that are actually defined to avoid overriding env vars
      if (config.ai.apiKey !== undefined) {
        aiConfig.apiKey = config.ai.apiKey as string;
      }
      if (config.ai.model !== undefined) {
        aiConfig.model = config.ai.model as string;
      }
      if (config.ai.timeout !== undefined) {
        aiConfig.timeout = config.ai.timeout as number;
      }
      if (config.ai.provider !== undefined) {
        aiConfig.provider = config.ai.provider as 'google' | 'anthropic' | 'openai';
      }
      if (config.ai.debug !== undefined) {
        aiConfig.debug = config.ai.debug as boolean;
      }
    }

    // Get custom prompt from config - REQUIRED, no fallbacks
    const customPrompt = config.prompt;

    if (!customPrompt || typeof customPrompt !== 'string') {
      throw new Error(
        `No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`
      );
    }

    // Create AI service with config - environment variables will be used if aiConfig is empty
    const service = new AIReviewService(aiConfig);

    console.error(
      `🔧 Debug: AICheckProvider using custom prompt: ${customPrompt.substring(0, 100)}...`
    );

    // Always pass the custom prompt - no fallbacks
    return await service.executeReview(prInfo, customPrompt);
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'prompt', 'focus', 'ai.provider', 'ai.model', 'ai.apiKey', 'ai.timeout'];
  }

  async isAvailable(): Promise<boolean> {
    // Check if any AI API key is available
    return !!(
      process.env.GOOGLE_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY
    );
  }

  getRequirements(): string[] {
    return [
      'At least one of: GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY',
      'Optional: MODEL_NAME environment variable',
      'Network access to AI provider APIs',
    ];
  }
}
