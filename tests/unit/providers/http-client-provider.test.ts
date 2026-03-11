import { HttpClientProvider } from '../../../src/providers/http-client-provider';
import { PRInfo } from '../../../src/pr-analyzer';
import { ReviewSummary } from '../../../src/reviewer';
// eslint-disable-next-line no-restricted-imports -- needed for type in test mock
import { Liquid } from 'liquidjs';
import { EnvironmentResolver } from '../../../src/utils/env-resolver';
import { OAuth2TokenCache } from '../../../src/utils/oauth2-token-cache';
import { RateLimiterRegistry } from '../../../src/utils/rate-limiter';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock Liquid
jest.mock('liquidjs', () => ({
  Liquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn(),
  })),
}));

jest.mock('../../../src/liquid-extensions', () => ({
  createExtendedLiquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn(),
  })),
}));

describe('HttpClientProvider', () => {
  let provider: HttpClientProvider;
  let mockPRInfo: PRInfo;
  let mockConfig: {
    type: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    transform?: string;
    timeout?: number;
  };
  let mockLiquid: jest.Mocked<Liquid>;
  let mockOutputs: Map<string, ReviewSummary>;

  afterEach(() => {
    RateLimiterRegistry.getInstance().cleanup();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    provider = new HttpClientProvider();
    mockLiquid = {
      parseAndRender: jest.fn(),
    } as unknown as jest.Mocked<Liquid>;
    (provider as unknown as { liquid: jest.Mocked<Liquid> }).liquid = mockLiquid;

    mockPRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test description',
      author: 'testuser',
      base: 'main',
      head: 'feature-branch',
      files: [],
      totalAdditions: 10,
      totalDeletions: 5,
      eventType: 'manual',
    };

    mockConfig = {
      type: 'http_client' as const,
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: {
        Authorization: 'Bearer token',
      },
    };

    mockOutputs = new Map([
      [
        'previous-check',
        {
          issues: [],
        },
      ],
    ]);
  });

  describe('getName', () => {
    it('should return correct provider name', () => {
      expect(provider.getName()).toBe('http_client');
    });
  });

  describe('getDescription', () => {
    it('should return correct description', () => {
      expect(provider.getDescription()).toBe(
        'Fetch data from HTTP endpoints for use by dependent checks'
      );
    });
  });

  describe('execute', () => {
    it('should fetch data successfully', async () => {
      const responseData = { status: 'ok', data: { value: 123 } };
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: jest.fn().mockReturnValue('application/json'),
        },
        json: jest.fn().mockResolvedValue(responseData),
        text: jest.fn().mockResolvedValue(JSON.stringify(responseData)),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'GET',
          headers: {
            Authorization: 'Bearer token',
          },
          signal: expect.any(AbortSignal),
        })
      );

      // The provider returns data in the 'output' property (consistent with other providers)
      expect(result).toEqual({
        issues: [],
        output: { status: 'ok', data: { value: 123 } },
      });
    });

    it('should handle POST request with body', async () => {
      mockConfig.method = 'POST';
      // Use a body with Liquid template to trigger parseAndRender
      mockConfig.body = '{"request": "{{ pr.title }}"}';

      const responseData = { result: 'success' };
      const mockResponse = {
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: {
          get: jest.fn().mockReturnValue('application/json'),
        },
        json: jest.fn().mockResolvedValue(responseData),
        text: jest.fn().mockResolvedValue(JSON.stringify(responseData)),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('{"request": "Test PR"}');

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      // Verify the body template was parsed by Liquid with the correct template
      expect(mockLiquid.parseAndRender).toHaveBeenCalledWith(
        '{"request": "{{ pr.title }}"}',
        expect.objectContaining({
          pr: expect.any(Object),
          outputs: expect.any(Object),
        })
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          body: '{"request": "Test PR"}',
          headers: expect.objectContaining({
            Authorization: 'Bearer token',
            'Content-Type': 'application/json',
          }),
        })
      );

      // The provider returns data in the 'output' property
      expect((result as ReviewSummary & { output: { result: string } }).output.result).toEqual(
        'success'
      );
    });

    it('should handle HTTP errors', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: {
          get: jest.fn().mockReturnValue(null),
        },
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
        text: jest.fn().mockResolvedValue('Server error'),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toContain('500');
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].severity).toBe('error');
      expect(result.issues![0].category).toBe('logic');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toContain('Network timeout');
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].severity).toBe('error');
      expect(result.issues![0].category).toBe('logic');
    });

    it('should apply transformation', async () => {
      const responseData = { original: 'data' };
      const transformedData = { transformed: 'result' };

      mockConfig.transform = '{"transformed": "{{ response.original }}"}';

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: jest.fn().mockReturnValue('application/json'),
        },
        json: jest.fn().mockResolvedValue(responseData),
        text: jest.fn().mockResolvedValue(JSON.stringify(responseData)),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue(JSON.stringify(transformedData));

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(mockLiquid.parseAndRender).toHaveBeenCalledWith(
        '{"transformed": "{{ response.original }}"}',
        expect.objectContaining({
          response: responseData,
          pr: expect.any(Object),
        })
      );

      // The provider returns data in the 'output' property
      expect(
        (result as ReviewSummary & { output: { transformed: string } }).output.transformed
      ).toEqual('result');
    });
  });

  describe('isAvailable', () => {
    it('should always return true', async () => {
      expect(await provider.isAvailable()).toBe(true);
    });
  });

  describe('validateConfig', () => {
    it('should validate valid configuration', async () => {
      const isValid = await provider.validateConfig(mockConfig);
      expect(isValid).toBe(true);
    });

    it('should require url field', async () => {
      delete mockConfig.url;

      const isValid = await provider.validateConfig(mockConfig);
      expect(isValid).toBe(false);
    });

    it('should validate with optional fields', async () => {
      mockConfig.transform = '{"custom": "{{ response.field }}"}';
      mockConfig.body = '{"request": "data"}';
      mockConfig.timeout = 5000;

      const isValid = await provider.validateConfig(mockConfig);
      expect(isValid).toBe(true);
    });

    it('should not require method (defaults to GET)', async () => {
      delete mockConfig.method;

      const isValid = await provider.validateConfig(mockConfig);
      expect(isValid).toBe(true);
    });
  });

  describe('header environment variable resolution', () => {
    beforeEach(() => {
      // Set up test environment variables
      process.env.TEST_API_KEY = 'test-key-123';
      process.env.TEST_TOKEN = 'test-token-456';
    });

    afterEach(() => {
      // Clean up test environment variables
      delete process.env.TEST_API_KEY;
      delete process.env.TEST_TOKEN;
    });

    it('should resolve shell-style environment variables in headers', () => {
      const headers = {
        Authorization: 'Bearer ${TEST_API_KEY}',
        'X-Custom': '${TEST_TOKEN}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer test-key-123');
      expect(resolved['X-Custom']).toBe('test-token-456');
    });

    it('should resolve simple shell-style environment variables in headers', () => {
      const headers = {
        Authorization: 'Bearer $TEST_API_KEY',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer test-key-123');
    });

    it('should resolve GitHub Actions-style environment variables in headers', () => {
      const headers = {
        Authorization: 'Bearer ${{ env.TEST_API_KEY }}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer test-key-123');
    });

    it('should handle mixed environment variable syntaxes in headers', () => {
      const headers = {
        'X-Key1': '${TEST_API_KEY}',
        'X-Key2': '$TEST_TOKEN',
        'X-Key3': '${{ env.TEST_API_KEY }}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved['X-Key1']).toBe('test-key-123');
      expect(resolved['X-Key2']).toBe('test-token-456');
      expect(resolved['X-Key3']).toBe('test-key-123');
    });

    it('should leave unresolved variables as-is when environment variable is missing', () => {
      const headers = {
        Authorization: 'Bearer ${NONEXISTENT_VAR}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer ${NONEXISTENT_VAR}');
    });

    it('should handle headers without environment variables', () => {
      const headers = {
        'Content-Type': 'application/json',
        'X-Static': 'static-value',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved['Content-Type']).toBe('application/json');
      expect(resolved['X-Static']).toBe('static-value');
    });

    it('should resolve headers in execute method', async () => {
      const configWithEnvVars = {
        ...mockConfig,
        headers: {
          Authorization: 'Bearer ${TEST_API_KEY}',
          'X-Token': '$TEST_TOKEN',
        },
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: jest.fn().mockReturnValue('application/json'),
        },
        json: jest.fn().mockResolvedValue({ data: 'test' }),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('https://api.example.com/data');

      await provider.execute(mockPRInfo, configWithEnvVars, mockOutputs);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key-123',
            'X-Token': 'test-token-456',
          }),
        })
      );
    });
  });

  describe('base_url + path support', () => {
    it('should build URL from base_url and path', async () => {
      const config = {
        type: 'http_client' as const,
        base_url: 'https://cloud.mongodb.com/api/atlas/v2',
        path: '/groups',
        headers: { Accept: 'application/json' },
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ results: [] }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await provider.execute(mockPRInfo, config, new Map());

      expect(mockFetch).toHaveBeenCalledWith(
        'https://cloud.mongodb.com/api/atlas/v2/groups',
        expect.any(Object)
      );
    });

    it('should substitute path params', async () => {
      const config = {
        type: 'http_client' as const,
        base_url: 'https://cloud.mongodb.com/api/atlas/v2',
        path: '/groups/{groupId}/clusters/{clusterName}',
        params: { groupId: 'abc123', clusterName: 'my-cluster' },
        headers: {},
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ name: 'my-cluster' }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await provider.execute(mockPRInfo, config, new Map());

      expect(mockFetch).toHaveBeenCalledWith(
        'https://cloud.mongodb.com/api/atlas/v2/groups/abc123/clusters/my-cluster',
        expect.any(Object)
      );
    });

    it('should append query parameters', async () => {
      const config = {
        type: 'http_client' as const,
        base_url: 'https://api.example.com/v2',
        path: '/items',
        query: { status: 'OPEN', limit: '10' },
        headers: {},
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ results: [] }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await provider.execute(mockPRInfo, config, new Map());

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('https://api.example.com/v2/items?');
      expect(calledUrl).toContain('status=OPEN');
      expect(calledUrl).toContain('limit=10');
    });

    it('should handle trailing/leading slashes correctly', async () => {
      const config = {
        type: 'http_client' as const,
        base_url: 'https://api.example.com/v2/',
        path: '/items/',
        headers: {},
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({}),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await provider.execute(mockPRInfo, config, new Map());

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v2/items/',
        expect.any(Object)
      );
    });

    it('should validate config with base_url instead of url', async () => {
      const config = {
        type: 'http_client' as const,
        base_url: 'https://api.example.com/v2',
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });
  });

  describe('OAuth2 auth support', () => {
    beforeEach(() => {
      OAuth2TokenCache.resetInstance();
    });

    it('should inject Bearer token from OAuth2 auth config', async () => {
      // Mock the OAuth2 token fetch
      const tokenFetchResponse = {
        ok: true,
        json: async () => ({ access_token: 'oauth-token-xyz', expires_in: 3600 }),
      };

      const apiResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ clusters: [] }),
      };

      // First call = OAuth token, second = API call
      mockFetch.mockResolvedValueOnce(tokenFetchResponse).mockResolvedValueOnce(apiResponse);

      const config = {
        type: 'http_client' as const,
        url: 'https://cloud.mongodb.com/api/atlas/v2/groups',
        headers: { Accept: 'application/vnd.atlas.2025-03-12+json' },
        auth: {
          type: 'oauth2_client_credentials' as const,
          token_url: 'https://cloud.mongodb.com/api/oauth/token',
          client_id: 'my-client-id',
          client_secret: 'my-client-secret',
        },
      };

      await provider.execute(mockPRInfo, config, new Map());

      // Verify token was fetched
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify the API call includes the Bearer token
      const apiCallHeaders = mockFetch.mock.calls[1][1].headers;
      expect(apiCallHeaders['Authorization']).toBe('Bearer oauth-token-xyz');
      expect(apiCallHeaders['Accept']).toBe('application/vnd.atlas.2025-03-12+json');
    });

    it('should work with base_url + path + auth combined', async () => {
      const tokenFetchResponse = {
        ok: true,
        json: async () => ({ access_token: 'combined-token', expires_in: 3600 }),
      };

      const apiResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ name: 'my-cluster' }),
      };

      mockFetch.mockResolvedValueOnce(tokenFetchResponse).mockResolvedValueOnce(apiResponse);

      const config = {
        type: 'http_client' as const,
        base_url: 'https://cloud.mongodb.com/api/atlas/v2',
        path: '/groups/{groupId}/clusters',
        params: { groupId: 'proj-123' },
        query: { itemsPerPage: '5' },
        headers: { Accept: 'application/vnd.atlas.2025-03-12+json' },
        auth: {
          type: 'oauth2_client_credentials' as const,
          token_url: 'https://cloud.mongodb.com/api/oauth/token',
          client_id: 'cid',
          client_secret: 'csecret',
        },
      };

      const result = await provider.execute(mockPRInfo, config, new Map());

      expect(result.issues).toHaveLength(0);
      // Verify URL was built correctly
      const calledUrl = mockFetch.mock.calls[1][0];
      expect(calledUrl).toBe(
        'https://cloud.mongodb.com/api/atlas/v2/groups/proj-123/clusters?itemsPerPage=5'
      );
      // Verify auth header
      expect(mockFetch.mock.calls[1][1].headers['Authorization']).toBe('Bearer combined-token');
    });
  });

  describe('rate_limit support', () => {
    it('should pass rate_limit config through to fetch and succeed normally', async () => {
      const config = {
        type: 'http_client' as const,
        url: 'https://api.workable.com/spi/v3/accounts',
        headers: { Authorization: 'Bearer token' },
        rate_limit: {
          key: 'workable',
          requests: 10,
          per: 'minute' as const,
        },
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ accounts: [] }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await provider.execute(mockPRInfo, config, new Map());

      expect(result.issues).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 when rate_limit is configured', async () => {
      const config = {
        type: 'http_client' as const,
        url: 'https://api.workable.com/spi/v3/accounts',
        headers: { Authorization: 'Bearer token' },
        rate_limit: {
          key: 'workable-retry-test',
          requests: 100,
          per: 'second' as const,
          max_retries: 2,
          initial_delay_ms: 10,
        },
      };

      const response429 = {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'Retry-After': '0' }),
        text: jest.fn().mockResolvedValue('rate limited'),
      };
      const response200 = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ accounts: ['a'] }),
      };
      mockFetch.mockResolvedValueOnce(response429).mockResolvedValueOnce(response200);

      const result = await provider.execute(mockPRInfo, config, new Map());

      expect(result.issues).toHaveLength(0);
      // rateLimitedFetch retried: 1st call returned 429, 2nd returned 200
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should work without rate_limit config (passthrough)', async () => {
      const config = {
        type: 'http_client' as const,
        url: 'https://api.example.com/data',
        headers: {},
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: jest.fn().mockReturnValue('application/json') },
        json: jest.fn().mockResolvedValue({ data: 'ok' }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await provider.execute(mockPRInfo, config, new Map());

      expect(result.issues).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
