import { CheckProvider } from './check-provider.interface';
import { AICheckProvider } from './ai-check-provider';
import { ToolCheckProvider } from './tool-check-provider';
import { HttpCheckProvider } from './http-check-provider';
import { HttpInputProvider } from './http-input-provider';
import { HttpClientProvider } from './http-client-provider';
import { NoopCheckProvider } from './noop-check-provider';
import { ClaudeCodeCheckProvider } from './claude-code-check-provider';

/**
 * Registry for managing check providers
 */
export class CheckProviderRegistry {
  private providers: Map<string, CheckProvider> = new Map();
  private static instance: CheckProviderRegistry;

  private constructor() {
    // Register default providers
    this.registerDefaultProviders();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): CheckProviderRegistry {
    if (!CheckProviderRegistry.instance) {
      CheckProviderRegistry.instance = new CheckProviderRegistry();
    }
    return CheckProviderRegistry.instance;
  }

  /**
   * Register default built-in providers
   */
  private registerDefaultProviders(): void {
    // Register all built-in providers
    this.register(new AICheckProvider());
    this.register(new ToolCheckProvider());
    this.register(new HttpCheckProvider());
    this.register(new HttpInputProvider());
    this.register(new HttpClientProvider());
    this.register(new NoopCheckProvider());

    // Try to register ClaudeCodeCheckProvider - it may fail if dependencies are missing
    try {
      this.register(new ClaudeCodeCheckProvider());
    } catch (error) {
      console.error(
        `Warning: Failed to register ClaudeCodeCheckProvider: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Register a check provider
   */
  register(provider: CheckProvider): void {
    const name = provider.getName();
    if (this.providers.has(name)) {
      throw new Error(`Provider '${name}' is already registered`);
    }
    this.providers.set(name, provider);
    // Only log provider registration in debug mode to avoid contaminating output
    if (process.env.VISOR_DEBUG === 'true') {
      console.error(`Registered check provider: ${name}`);
    }
  }

  /**
   * Unregister a check provider
   */
  unregister(name: string): void {
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
  getProvider(name: string): CheckProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get provider or throw if not found
   */
  getProviderOrThrow(name: string): CheckProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `Check provider '${name}' not found. Available providers: ${this.getAvailableProviders().join(', ')}`
      );
    }
    return provider;
  }

  /**
   * Check if a provider exists
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Get all registered provider names
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get all providers
   */
  getAllProviders(): CheckProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get providers that are currently available (have required dependencies)
   */
  async getActiveProviders(): Promise<CheckProvider[]> {
    const providers = this.getAllProviders();
    const activeProviders: CheckProvider[] = [];

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
  async listProviders(): Promise<
    Array<{
      name: string;
      description: string;
      available: boolean;
      requirements: string[];
    }>
  > {
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
  reset(): void {
    this.providers.clear();
    this.registerDefaultProviders();
  }

  /**
   * Clear singleton instance (for testing)
   */
  static clearInstance(): void {
    CheckProviderRegistry.instance = undefined!;
  }
}
