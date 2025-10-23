import { CheckProvider } from './check-provider.interface';
/**
 * Registry for managing check providers
 */
export declare class CheckProviderRegistry {
    private providers;
    private static instance;
    private constructor();
    /**
     * Get singleton instance
     */
    static getInstance(): CheckProviderRegistry;
    /**
     * Register default built-in providers
     */
    private registerDefaultProviders;
    /**
     * Register a check provider
     */
    register(provider: CheckProvider): void;
    /**
     * Unregister a check provider
     */
    unregister(name: string): void;
    /**
     * Get a provider by name
     */
    getProvider(name: string): CheckProvider | undefined;
    /**
     * Get provider or throw if not found
     */
    getProviderOrThrow(name: string): CheckProvider;
    /**
     * Check if a provider exists
     */
    hasProvider(name: string): boolean;
    /**
     * Get all registered provider names
     */
    getAvailableProviders(): string[];
    /**
     * Get all providers
     */
    getAllProviders(): CheckProvider[];
    /**
     * Get providers that are currently available (have required dependencies)
     */
    getActiveProviders(): Promise<CheckProvider[]>;
    /**
     * List provider information
     */
    listProviders(): Promise<Array<{
        name: string;
        description: string;
        available: boolean;
        requirements: string[];
    }>>;
    /**
     * Reset registry (mainly for testing)
     */
    reset(): void;
    /**
     * Clear singleton instance (for testing)
     */
    static clearInstance(): void;
}
//# sourceMappingURL=check-provider-registry.d.ts.map