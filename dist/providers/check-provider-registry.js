"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckProviderRegistry = void 0;
const ai_check_provider_1 = require("./ai-check-provider");
const tool_check_provider_1 = require("./tool-check-provider");
const webhook_check_provider_1 = require("./webhook-check-provider");
const noop_check_provider_1 = require("./noop-check-provider");
/**
 * Registry for managing check providers
 */
class CheckProviderRegistry {
    providers = new Map();
    static instance;
    constructor() {
        // Register default providers
        this.registerDefaultProviders();
    }
    /**
     * Get singleton instance
     */
    static getInstance() {
        if (!CheckProviderRegistry.instance) {
            CheckProviderRegistry.instance = new CheckProviderRegistry();
        }
        return CheckProviderRegistry.instance;
    }
    /**
     * Register default built-in providers
     */
    registerDefaultProviders() {
        // Register all built-in providers
        this.register(new ai_check_provider_1.AICheckProvider());
        this.register(new tool_check_provider_1.ToolCheckProvider());
        this.register(new webhook_check_provider_1.WebhookCheckProvider());
        this.register(new noop_check_provider_1.NoopCheckProvider());
    }
    /**
     * Register a check provider
     */
    register(provider) {
        const name = provider.getName();
        if (this.providers.has(name)) {
            throw new Error(`Provider '${name}' is already registered`);
        }
        this.providers.set(name, provider);
        // Send provider registration messages to stderr to avoid contaminating JSON output
        console.error(`Registered check provider: ${name}`);
    }
    /**
     * Unregister a check provider
     */
    unregister(name) {
        if (!this.providers.has(name)) {
            throw new Error(`Provider '${name}' not found`);
        }
        this.providers.delete(name);
        // Send provider unregistration messages to stderr to avoid contaminating JSON output
        console.error(`Unregistered check provider: ${name}`);
    }
    /**
     * Get a provider by name
     */
    getProvider(name) {
        return this.providers.get(name);
    }
    /**
     * Get provider or throw if not found
     */
    getProviderOrThrow(name) {
        const provider = this.providers.get(name);
        if (!provider) {
            throw new Error(`Check provider '${name}' not found. Available providers: ${this.getAvailableProviders().join(', ')}`);
        }
        return provider;
    }
    /**
     * Check if a provider exists
     */
    hasProvider(name) {
        return this.providers.has(name);
    }
    /**
     * Get all registered provider names
     */
    getAvailableProviders() {
        return Array.from(this.providers.keys());
    }
    /**
     * Get all providers
     */
    getAllProviders() {
        return Array.from(this.providers.values());
    }
    /**
     * Get providers that are currently available (have required dependencies)
     */
    async getActiveProviders() {
        const providers = this.getAllProviders();
        const activeProviders = [];
        for (const provider of providers) {
            if (await provider.isAvailable()) {
                activeProviders.push(provider);
            }
        }
        return activeProviders;
    }
    /**
     * List provider information
     */
    async listProviders() {
        const providers = this.getAllProviders();
        const info = [];
        for (const provider of providers) {
            info.push({
                name: provider.getName(),
                description: provider.getDescription(),
                available: await provider.isAvailable(),
                requirements: provider.getRequirements(),
            });
        }
        return info;
    }
    /**
     * Reset registry (mainly for testing)
     */
    reset() {
        this.providers.clear();
        this.registerDefaultProviders();
    }
    /**
     * Clear singleton instance (for testing)
     */
    static clearInstance() {
        CheckProviderRegistry.instance = undefined;
    }
}
exports.CheckProviderRegistry = CheckProviderRegistry;
//# sourceMappingURL=check-provider-registry.js.map