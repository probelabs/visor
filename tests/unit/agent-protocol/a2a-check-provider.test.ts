import { A2ACheckProvider, AgentCardCache } from '../../../src/providers/a2a-check-provider';

describe('A2ACheckProvider', () => {
  let provider: A2ACheckProvider;

  beforeEach(() => {
    provider = new A2ACheckProvider();
  });

  describe('getName', () => {
    it('should return "a2a"', () => {
      expect(provider.getName()).toBe('a2a');
    });
  });

  describe('validateConfig', () => {
    it('should accept valid config with agent_card', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_card: 'https://agent.example.com/.well-known/agent-card.json',
        message: 'Hello agent',
      });
      expect(result).toBe(true);
    });

    it('should accept valid config with agent_url', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_url: 'http://localhost:9001',
        message: 'Hello agent',
      });
      expect(result).toBe(true);
    });

    it('should reject config with both agent_card and agent_url', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_card: 'https://agent.example.com/.well-known/agent-card.json',
        agent_url: 'http://localhost:9001',
        message: 'Hello agent',
      });
      expect(result).toBe(false);
    });

    it('should reject config with neither agent_card nor agent_url', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        message: 'Hello agent',
      });
      expect(result).toBe(false);
    });

    it('should reject config without message', async () => {
      const result = await provider.validateConfig({
        type: 'a2a',
        agent_url: 'http://localhost:9001',
      });
      expect(result).toBe(false);
    });

    it('should reject non-a2a type', async () => {
      const result = await provider.validateConfig({
        type: 'ai',
        agent_url: 'http://localhost:9001',
        message: 'Hello',
      });
      expect(result).toBe(false);
    });

    it('should reject null/undefined config', async () => {
      expect(await provider.validateConfig(null)).toBe(false);
      expect(await provider.validateConfig(undefined)).toBe(false);
    });
  });

  describe('isAvailable', () => {
    it('should always return true', async () => {
      expect(await provider.isAvailable()).toBe(true);
    });
  });

  describe('getSupportedConfigKeys', () => {
    it('should return expected keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('agent_card');
      expect(keys).toContain('agent_url');
      expect(keys).toContain('message');
      expect(keys).toContain('auth');
      expect(keys).toContain('blocking');
      expect(keys).toContain('timeout');
      expect(keys).toContain('max_turns');
      expect(keys).toContain('on_input_required');
      expect(keys).toContain('transform_js');
    });
  });

  describe('getRequirements', () => {
    it('should return empty array', () => {
      expect(provider.getRequirements()).toEqual([]);
    });
  });
});

describe('AgentCardCache', () => {
  it('should cache and return cards', async () => {
    const cache = new AgentCardCache(60_000);
    let fetchCount = 0;

    // Mock global fetch
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          name: 'Test Agent',
          supported_interfaces: [{ url: 'http://localhost:9001' }],
        }),
      };
    }) as any;

    try {
      const card1 = await cache.fetch('http://example.com/agent-card.json');
      expect(card1.name).toBe('Test Agent');
      expect(fetchCount).toBe(1);

      // Second fetch should use cache
      const card2 = await cache.fetch('http://example.com/agent-card.json');
      expect(card2.name).toBe('Test Agent');
      expect(fetchCount).toBe(1); // No additional fetch

      // Clear cache and fetch again
      cache.clear();
      const card3 = await cache.fetch('http://example.com/agent-card.json');
      expect(card3.name).toBe('Test Agent');
      expect(fetchCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should throw on non-ok response', async () => {
    const cache = new AgentCardCache();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })) as any;

    try {
      await expect(cache.fetch('http://example.com/agent-card.json')).rejects.toThrow(
        'Failed to fetch Agent Card'
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should throw on invalid card (missing name)', async () => {
    const cache = new AgentCardCache();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ description: 'no name field' }),
    })) as any;

    try {
      await expect(cache.fetch('http://example.com/agent-card.json')).rejects.toThrow(
        'Missing required fields'
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should invalidate specific URL', async () => {
    const cache = new AgentCardCache(60_000);
    let fetchCount = 0;
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          name: 'Test Agent',
          supported_interfaces: [{ url: 'http://localhost:9001' }],
        }),
      };
    }) as any;

    try {
      await cache.fetch('http://example.com/agent-card.json');
      expect(fetchCount).toBe(1);

      cache.invalidate('http://example.com/agent-card.json');

      await cache.fetch('http://example.com/agent-card.json');
      expect(fetchCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
