import { HttpClientProvider } from '../../../src/providers/http-client-provider';
import { PRInfo } from '../../../src/pr-analyzer';
import { ReviewSummary } from '../../../src/reviewer';
import { Liquid } from 'liquidjs';
import { EnvironmentResolver } from '../../../src/utils/env-resolver';

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

      expect(result).toEqual<ReviewSummary & { data: unknown }>({
        issues: [],
        data: responseData,
      });
    });

    it('should handle POST request with body', async () => {
      mockConfig.method = 'POST';
      mockConfig.body = '{"request": "data"}';

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
      mockLiquid.parseAndRender.mockResolvedValue('{"request": "data"}');

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(mockLiquid.parseAndRender).toHaveBeenCalledWith(
        '{"request": "data"}',
        expect.objectContaining({
          pr: expect.any(Object),
          outputs: {},
        })
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          body: '{"request": "data"}',
          headers: expect.objectContaining({
            Authorization: 'Bearer token',
            'Content-Type': 'application/json',
          }),
        })
      );

      expect((result as ReviewSummary & { data: unknown }).data).toEqual(responseData);
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

      expect((result as ReviewSummary & { data: unknown }).data).toEqual(transformedData);
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
});
