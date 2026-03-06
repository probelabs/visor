import {
  OAuth2TokenCache,
  OAuth2ClientCredentialsConfig,
} from '../../../src/utils/oauth2-token-cache';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    verbose: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// Mock env-resolver
jest.mock('../../../src/utils/env-resolver', () => ({
  EnvironmentResolver: {
    resolveValue: jest.fn((v: string) => v),
  },
}));

describe('OAuth2TokenCache', () => {
  const config: OAuth2ClientCredentialsConfig = {
    type: 'oauth2_client_credentials',
    token_url: 'https://cloud.mongodb.com/api/oauth/token',
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    token_ttl_buffer: 300,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    OAuth2TokenCache.resetInstance();
  });

  it('fetches a new token on first call', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-token-123',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    const cache = OAuth2TokenCache.getInstance();
    const token = await cache.getToken(config);

    expect(token).toBe('new-token-123');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify the fetch call
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://cloud.mongodb.com/api/oauth/token');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(options.headers['Authorization']).toMatch(/^Basic /);
    expect(options.body).toBe('grant_type=client_credentials');
  });

  it('returns cached token on subsequent calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'cached-token',
        expires_in: 3600,
      }),
    });

    const cache = OAuth2TokenCache.getInstance();
    const token1 = await cache.getToken(config);
    const token2 = await cache.getToken(config);

    expect(token1).toBe('cached-token');
    expect(token2).toBe('cached-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes token when expired', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'old-token',
          expires_in: 1, // expires in 1 second
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          expires_in: 3600,
        }),
      });

    const cache = OAuth2TokenCache.getInstance();

    // Use a config with 0 buffer so the token expires after 1s
    const shortConfig = { ...config, token_ttl_buffer: 0 };
    await cache.getToken(shortConfig);

    // Wait for token to expire
    await new Promise(resolve => setTimeout(resolve, 1100));

    const token = await cache.getToken(shortConfig);
    expect(token).toBe('new-token');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes token when within buffer period', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'expiring-token',
          expires_in: 200, // 200 seconds — within 300s buffer
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'fresh-token',
          expires_in: 3600,
        }),
      });

    const cache = OAuth2TokenCache.getInstance();
    await cache.getToken(config);

    // Second call should refresh because 200s < 300s buffer
    const token = await cache.getToken(config);
    expect(token).toBe('fresh-token');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent token fetches', async () => {
    let resolveToken: (v: unknown) => void;
    const tokenPromise = new Promise(resolve => {
      resolveToken = resolve;
    });

    mockFetch.mockImplementationOnce(async () => {
      await tokenPromise;
      return {
        ok: true,
        json: async () => ({
          access_token: 'shared-token',
          expires_in: 3600,
        }),
      };
    });

    const cache = OAuth2TokenCache.getInstance();
    const promise1 = cache.getToken(config);
    const promise2 = cache.getToken(config);

    // Release the fetch
    resolveToken!(undefined);

    const [token1, token2] = await Promise.all([promise1, promise2]);
    expect(token1).toBe('shared-token');
    expect(token2).toBe('shared-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid credentials',
    });

    const cache = OAuth2TokenCache.getInstance();
    await expect(cache.getToken(config)).rejects.toThrow('OAuth2 token request failed: HTTP 401');
  });

  it('throws on missing access_token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const cache = OAuth2TokenCache.getInstance();
    await expect(cache.getToken(config)).rejects.toThrow('missing access_token');
  });

  it('sends scopes when configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'scoped-token',
        expires_in: 3600,
      }),
    });

    const cache = OAuth2TokenCache.getInstance();
    await cache.getToken({ ...config, scopes: ['read', 'write'] });

    const body = mockFetch.mock.calls[0][1].body;
    expect(body).toContain('scope=read+write');
  });

  it('uses base64-encoded client_id:client_secret', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'token',
        expires_in: 3600,
      }),
    });

    const cache = OAuth2TokenCache.getInstance();
    await cache.getToken(config);

    const expectedBasic = Buffer.from('test-client-id:test-client-secret').toString('base64');
    const authHeader = mockFetch.mock.calls[0][1].headers['Authorization'];
    expect(authHeader).toBe(`Basic ${expectedBasic}`);
  });

  it('clear() removes all cached tokens', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'token',
        expires_in: 3600,
      }),
    });

    const cache = OAuth2TokenCache.getInstance();
    await cache.getToken(config);
    cache.clear();

    // Should fetch again after clear
    await cache.getToken(config);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('supports multiple providers with different cache keys', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-a', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-b', expires_in: 3600 }),
      });

    const configB = {
      ...config,
      token_url: 'https://other-provider.com/oauth/token',
      client_id: 'other-client',
    };

    const cache = OAuth2TokenCache.getInstance();
    const tokenA = await cache.getToken(config);
    const tokenB = await cache.getToken(configB);

    expect(tokenA).toBe('token-a');
    expect(tokenB).toBe('token-b');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
