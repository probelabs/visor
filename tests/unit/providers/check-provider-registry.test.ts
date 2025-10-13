import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import {
  CheckProvider,
  CheckProviderConfig,
} from '../../../src/providers/check-provider.interface';
import { PRInfo } from '../../../src/pr-analyzer';
import { ReviewSummary } from '../../../src/reviewer';

// Mock provider for testing
class MockCheckProvider extends CheckProvider {
  constructor(private name: string) {
    super();
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string {
    return `Mock ${this.name} provider`;
  }

  async validateConfig(_config: unknown): Promise<boolean> {
    return true;
  }

  async execute(_prInfo: PRInfo, _config: CheckProviderConfig): Promise<ReviewSummary> {
    return {
      issues: [],
    };
  }

  getSupportedConfigKeys(): string[] {
    return ['type'];
  }

  async isAvailable(): Promise<boolean> {
    return this.name !== 'unavailable';
  }

  getRequirements(): string[] {
    return [`${this.name} requirements`];
  }
}

describe('CheckProviderRegistry', () => {
  let registry: CheckProviderRegistry;

  beforeEach(() => {
    // Clear singleton instance before each test
    CheckProviderRegistry.clearInstance();
    registry = CheckProviderRegistry.getInstance();
  });

  afterEach(() => {
    CheckProviderRegistry.clearInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = CheckProviderRegistry.getInstance();
      const instance2 = CheckProviderRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should register default providers', () => {
      const providers = registry.getAvailableProviders();
      expect(providers).toContain('ai');
      expect(providers).toContain('command');
      expect(providers).toContain('http');
      expect(providers).toContain('http_input');
      expect(providers).toContain('http_client');
      expect(providers).toContain('noop');
    });
  });

  describe('register', () => {
    it('should register a new provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      expect(registry.hasProvider('custom')).toBe(true);
    });

    it('should throw error for duplicate provider', () => {
      const provider1 = new MockCheckProvider('custom');
      const provider2 = new MockCheckProvider('custom');

      registry.register(provider1);
      expect(() => registry.register(provider2)).toThrow("Provider 'custom' is already registered");
    });
  });

  describe('unregister', () => {
    it('should unregister a provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      registry.unregister('custom');
      expect(registry.hasProvider('custom')).toBe(false);
    });

    it('should throw error for non-existent provider', () => {
      expect(() => registry.unregister('nonexistent')).toThrow("Provider 'nonexistent' not found");
    });
  });

  describe('getProvider', () => {
    it('should return registered provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      const retrieved = registry.getProvider('custom');
      expect(retrieved).toBe(provider);
    });

    it('should return undefined for non-existent provider', () => {
      const retrieved = registry.getProvider('nonexistent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getProviderOrThrow', () => {
    it('should return registered provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      const retrieved = registry.getProviderOrThrow('custom');
      expect(retrieved).toBe(provider);
    });

    it('should throw error for non-existent provider', () => {
      expect(() => registry.getProviderOrThrow('nonexistent')).toThrow(
        /Check provider 'nonexistent' not found/
      );
    });
  });

  describe('hasProvider', () => {
    it('should return true for registered provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      expect(registry.hasProvider('custom')).toBe(true);
    });

    it('should return false for non-existent provider', () => {
      expect(registry.hasProvider('nonexistent')).toBe(false);
    });
  });

  describe('getAvailableProviders', () => {
    it('should return all registered provider names', () => {
      registry.reset(); // Clear default providers

      const provider1 = new MockCheckProvider('provider1');
      const provider2 = new MockCheckProvider('provider2');

      registry.register(provider1);
      registry.register(provider2);

      const providers = registry.getAvailableProviders();
      expect(providers).toContain('provider1');
      expect(providers).toContain('provider2');
    });
  });

  describe('getAllProviders', () => {
    it('should return all provider instances', () => {
      registry.reset();

      const provider1 = new MockCheckProvider('provider1');
      const provider2 = new MockCheckProvider('provider2');

      registry.register(provider1);
      registry.register(provider2);

      const providers = registry.getAllProviders();
      expect(providers).toContain(provider1);
      expect(providers).toContain(provider2);
      // Reset adds 10 default providers (ai, command, http, http_input, http_client, noop, log, memory, github, claude-code) + 2 custom = 12 total
      expect(providers.length).toBe(12);
    });
  });

  describe('getActiveProviders', () => {
    it('should return only available providers', async () => {
      registry.reset();

      const availableProvider = new MockCheckProvider('available');
      const unavailableProvider = new MockCheckProvider('unavailable');

      registry.register(availableProvider);
      registry.register(unavailableProvider);

      const activeProviders = await registry.getActiveProviders();
      expect(activeProviders).toContain(availableProvider);
      expect(activeProviders).not.toContain(unavailableProvider);
    });
  });

  describe('listProviders', () => {
    it('should return provider information', async () => {
      registry.reset();

      const provider = new MockCheckProvider('custom');
      registry.register(provider);

      const info = await registry.listProviders();
      const customInfo = info.find(p => p.name === 'custom');

      expect(customInfo).toBeDefined();
      expect(customInfo?.description).toBe('Mock custom provider');
      expect(customInfo?.available).toBe(true);
      expect(customInfo?.requirements).toEqual(['custom requirements']);
    });
  });

  describe('reset', () => {
    it('should clear all providers and re-register defaults', () => {
      const customProvider = new MockCheckProvider('custom');
      registry.register(customProvider);

      registry.reset();

      expect(registry.hasProvider('custom')).toBe(false);
      expect(registry.hasProvider('ai')).toBe(true);
      expect(registry.hasProvider('command')).toBe(true);
      expect(registry.hasProvider('http')).toBe(true);
      expect(registry.hasProvider('http_input')).toBe(true);
      expect(registry.hasProvider('http_client')).toBe(true);
      expect(registry.hasProvider('noop')).toBe(true);
    });
  });
});
