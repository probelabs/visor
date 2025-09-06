"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AICheckProvider = void 0;
const check_provider_interface_1 = require("./check-provider.interface");
const ai_review_service_1 = require("../ai-review-service");
/**
 * AI-powered check provider using probe-chat
 */
class AICheckProvider extends check_provider_interface_1.CheckProvider {
    aiReviewService;
    constructor() {
        super();
        this.aiReviewService = new ai_review_service_1.AIReviewService();
    }
    getName() {
        return 'ai';
    }
    getDescription() {
        return 'AI-powered code review using Google Gemini, Anthropic Claude, or OpenAI GPT models';
    }
    async validateConfig(config) {
        if (!config || typeof config !== 'object') {
            return false;
        }
        const cfg = config;
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
        if (cfg.focus && !['security', 'performance', 'style', 'all'].includes(cfg.focus)) {
            return false;
        }
        // Validate AI provider config if present
        if (cfg.ai) {
            if (cfg.ai.provider &&
                !['google', 'anthropic', 'openai'].includes(cfg.ai.provider)) {
                return false;
            }
        }
        return true;
    }
    async execute(prInfo, config) {
        // Extract AI configuration
        const aiConfig = {};
        if (config.ai) {
            aiConfig.apiKey = config.ai.apiKey;
            aiConfig.model = config.ai.model;
            aiConfig.timeout = config.ai.timeout;
            aiConfig.provider = config.ai.provider;
        }
        // Determine focus from prompt or focus field
        let focus = 'all';
        const prompt = config.prompt || config.focus;
        if (typeof prompt === 'string') {
            if (prompt === 'security' || prompt.includes('security')) {
                focus = 'security';
            }
            else if (prompt === 'performance' || prompt.includes('performance')) {
                focus = 'performance';
            }
            else if (prompt === 'style' || prompt.includes('style')) {
                focus = 'style';
            }
        }
        // Create AI service with config
        const service = new ai_review_service_1.AIReviewService(aiConfig);
        // Execute the review
        return await service.executeReview(prInfo, focus);
    }
    getSupportedConfigKeys() {
        return ['type', 'prompt', 'focus', 'ai.provider', 'ai.model', 'ai.apiKey', 'ai.timeout'];
    }
    async isAvailable() {
        // Check if any AI API key is available
        return !!(process.env.GOOGLE_API_KEY ||
            process.env.ANTHROPIC_API_KEY ||
            process.env.OPENAI_API_KEY);
    }
    getRequirements() {
        return [
            'At least one of: GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY',
            'Optional: MODEL_NAME environment variable',
            'Network access to AI provider APIs',
        ];
    }
}
exports.AICheckProvider = AICheckProvider;
//# sourceMappingURL=ai-check-provider.js.map