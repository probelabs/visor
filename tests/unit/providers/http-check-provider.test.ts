import { HttpCheckProvider } from '../../../src/providers/http-check-provider';
import { PRInfo } from '../../../src/pr-analyzer';
import { ReviewSummary } from '../../../src/reviewer';
import { Liquid } from 'liquidjs';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock Liquid
jest.mock('liquidjs', () => ({
  Liquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn(),
  })),
}));

// Mock liquid-extensions
jest.mock('../../../src/liquid-extensions', () => ({
  createExtendedLiquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn(),
  })),
}));

// Type for test configs where we may delete properties for validation testing
type TestConfig = {
  type?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

describe('HttpCheckProvider', () => {
  let provider: HttpCheckProvider;
  let mockPRInfo: PRInfo;
  let mockConfig: {
    type: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  let mockLiquid: jest.Mocked<Liquid>;
  let mockOutputs: Map<string, ReviewSummary>;

  beforeEach(() => {
    jest.clearAllMocks();

    provider = new HttpCheckProvider();
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
      type: 'http' as const,
      url: 'https://api.example.com/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: '{"pr": "{{ pr.number }}", "title": "{{ pr.title }}"}',
    };

    mockOutputs = new Map([
      [
        'previous-check',
        {
          issues: [
            {
              file: 'test.ts',
              line: 10,
              message: 'Test issue',
              severity: 'warning',
              category: 'style',
              ruleId: 'test-rule',
            },
          ],
        },
      ],
    ]);
  });

  describe('getName', () => {
    it('should return correct provider name', () => {
      expect(provider.getName()).toBe('http');
    });
  });

  describe('getDescription', () => {
    it('should return correct description', () => {
      expect(provider.getDescription()).toBe(
        'Send data to external HTTP endpoint for notifications or integration'
      );
    });
  });

  describe('execute', () => {
    it('should send HTTP request with rendered body', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue({
          comments: [],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('{"pr": "123", "title": "Test PR"}');

      const result = await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(mockLiquid.parseAndRender).toHaveBeenCalledWith(
        '{"pr": "{{ pr.number }}", "title": "{{ pr.title }}"}',
        expect.objectContaining({
          pr: expect.objectContaining({
            number: mockPRInfo.number,
            title: mockPRInfo.title,
          }),
          outputs: expect.any(Object),
          files: expect.any(Array),
          metadata: expect.any(Object),
        })
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token',
          },
          body: '{"pr":"123","title":"Test PR"}',
        })
      );

      expect(result).toEqual<ReviewSummary>({
        issues: [],
      });
    });

    it('should handle GET request without body', async () => {
      mockConfig.method = 'GET';
      // Keep body for template rendering

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue({
          comments: [],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('{"data": "test"}');

      const result = await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/webhook',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );

      expect(result.issues).toEqual([]);
      expect(result.issues).toEqual([]);
    });

    it('should handle HTTP errors', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('{"pr": "123"}');

      const result = await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toContain('500');
      expect(result.issues![0].message).toContain('error');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network timeout'));
      mockLiquid.parseAndRender.mockResolvedValue('{"pr": "123"}');

      const result = await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toContain('Network timeout');
      expect(result.issues![0].message).toContain('error');
    });

    it('should parse webhook response with comments', async () => {
      const webhookResponse = {
        comments: [
          {
            file: 'test.ts',
            line: 15,
            ruleId: 'webhook-rule',
            message: 'Webhook found an issue',
            severity: 'warning',
            category: 'style',
          },
        ],
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(webhookResponse),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('{"data": "test"}');

      const result = await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({
        file: 'test.ts',
        line: 15,
        message: 'Webhook found an issue',
        severity: 'warning',
        category: 'style',
      });
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toEqual({
        file: 'test.ts',
        line: 15,
        endLine: undefined,
        ruleId: 'webhook-rule',
        message: 'Webhook found an issue',
        severity: 'warning',
        category: 'style',
        suggestion: undefined,
        replacement: undefined,
      });
    });

    it('should handle template rendering errors', async () => {
      mockLiquid.parseAndRender.mockRejectedValue(new Error('Template syntax error'));

      const result = await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toContain('Template rendering failed');
      expect(result.issues![0].message).toContain('error');
    });

    it('should include outputs in template context', async () => {
      mockConfig.body = '{"issues": {{ outputs.previous-check.issues | size }}}';

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue({
          comments: [],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('{"issues": 1}');

      await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(mockLiquid.parseAndRender).toHaveBeenCalledWith(
        mockConfig.body,
        expect.objectContaining({
          outputs: expect.any(Object),
        })
      );
    });

    it('should default to POST method', async () => {
      delete mockConfig.method;

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue({
          comments: [],
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);
      mockLiquid.parseAndRender.mockResolvedValue('{}');

      await provider.execute(mockPRInfo, mockConfig, mockOutputs);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'POST' })
      );
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
      const configWithoutUrl: TestConfig = { ...mockConfig };
      delete configWithoutUrl.url;

      const isValid = await provider.validateConfig(configWithoutUrl);
      expect(isValid).toBe(false);
    });

    it('should require body field', async () => {
      const configWithoutBody: TestConfig = { ...mockConfig };
      delete configWithoutBody.body;

      const isValid = await provider.validateConfig(configWithoutBody);
      expect(isValid).toBe(false);
    });

    it('should require both url and body fields', async () => {
      const configWithoutFields: TestConfig = { ...mockConfig };
      delete configWithoutFields.url;
      delete configWithoutFields.body;

      const isValid = await provider.validateConfig(configWithoutFields);
      expect(isValid).toBe(false);
    });

    it('should validate with optional fields', async () => {
      mockConfig.method = 'PUT';
      mockConfig.headers = {
        'X-Custom-Header': 'value',
      };

      const isValid = await provider.validateConfig(mockConfig);
      expect(isValid).toBe(true);
    });
  });
});
