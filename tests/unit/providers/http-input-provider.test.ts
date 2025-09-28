import { HttpInputProvider } from '../../../src/providers/http-input-provider';
import { PRInfo } from '../../../src/pr-analyzer';
import { ReviewSummary } from '../../../src/reviewer';
import { Liquid } from 'liquidjs';

// Mock Liquid
jest.mock('liquidjs', () => ({
  Liquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn().mockResolvedValue('{"transformed": "data"}'),
  })),
}));

// Mock liquid-extensions
jest.mock('../../../src/liquid-extensions', () => ({
  createExtendedLiquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn().mockResolvedValue('{"transformed": "data"}'),
  })),
}));

describe('HttpInputProvider', () => {
  let provider: HttpInputProvider;
  let mockPRInfo: PRInfo;
  let mockConfig: {
    type: string;
    endpoint?: string;
    on: string[];
    transform?: string;
  };
  let mockLiquid: jest.Mocked<Liquid>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock global webhook data
    (global as Record<string, unknown>).__visor_webhook_data = new Map<
      string,
      Record<string, unknown>
    >();

    provider = new HttpInputProvider();
    mockLiquid = {
      parseAndRender: jest.fn().mockResolvedValue('{"transformed": "data"}'),
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
      eventType: 'webhook_received',
    };

    mockConfig = {
      type: 'http_input' as const,
      endpoint: '/webhook/test',
      on: ['webhook_received'],
    };
  });

  afterEach(() => {
    delete (global as Record<string, unknown>).__visor_webhook_data;
  });

  describe('getName', () => {
    it('should return correct provider name', () => {
      expect(provider.getName()).toBe('http_input');
    });
  });

  describe('getDescription', () => {
    it('should return correct description', () => {
      expect(provider.getDescription()).toBe(
        'Receive and process HTTP webhook input data for use by dependent checks'
      );
    });
  });

  describe('execute', () => {
    it('should retrieve webhook data when available', async () => {
      const webhookData = {
        event: 'push',
        repository: 'test/repo',
        timestamp: '2024-01-01T00:00:00Z',
      };

      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', webhookData);
      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(result).toEqual<ReviewSummary & { data: unknown }>({
        issues: [],
        data: webhookData,
      });
    });

    it('should return empty result when no data available', async () => {
      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(result).toEqual<ReviewSummary>({
        issues: [],
      });
    });

    it('should apply transformation when specified', async () => {
      const webhookData = {
        originalField: 'value',
        nested: { field: 'data' },
      };

      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', webhookData);
      mockConfig.transform = '{"transformed": "{{ webhook.originalField }}"}';
      mockLiquid.parseAndRender.mockResolvedValue('{"transformed": "value"}');

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(mockLiquid.parseAndRender).toHaveBeenCalledWith(
        '{"transformed": "{{ webhook.originalField }}"}',
        expect.objectContaining({
          webhook: webhookData,
          pr: expect.objectContaining({
            number: mockPRInfo.number,
            title: mockPRInfo.title,
          }),
        })
      );

      expect((result as ReviewSummary & { data: unknown }).data).toEqual({ transformed: 'value' });
    });

    it('should handle transformation errors', async () => {
      const webhookData = { field: 'value' };
      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', webhookData);
      mockConfig.transform = '{"invalid": {{ broken }}';
      mockLiquid.parseAndRender.mockRejectedValue(new Error('Template error'));

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toContain(
        'Failed to transform webhook data: Template error'
      );
      expect(result.issues![0].severity).toBe('error');
      expect(result.issues![0].category).toBe('logic');
    });

    it('should handle invalid JSON transformation result', async () => {
      const webhookData = { field: 'value' };
      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', webhookData);
      mockConfig.transform = 'not json';
      mockLiquid.parseAndRender.mockResolvedValue('not json');

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toContain('Failed to transform webhook data');
      expect(result.issues![0].severity).toBe('error');
      expect(result.issues![0].category).toBe('logic');
    });

    it('should process webhook data without clearing it', async () => {
      const webhookData = { field: 'value' };
      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', webhookData);
      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect((result as ReviewSummary & { data: unknown }).data).toEqual(webhookData);
      // Data remains available for other checks
      const webhookStore = (global as Record<string, unknown>).__visor_webhook_data as Map<
        string,
        Record<string, unknown>
      >;
      expect(webhookStore.get('/webhook/test')).toEqual(webhookData);
    });

    it('should handle missing endpoint configuration', async () => {
      delete mockConfig.endpoint;

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(result.issues).toEqual([]);
      expect((result as ReviewSummary & { data?: unknown }).data).toBeUndefined();
    });

    it('should process webhook data without logging', async () => {
      const webhookData = { action: 'opened', number: 456 };
      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', webhookData);
      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect((result as ReviewSummary & { data: unknown }).data).toEqual(webhookData);
    });

    it('should handle complex nested webhook data', async () => {
      const complexData = {
        event: {
          type: 'deployment',
          status: 'success',
          metadata: {
            version: '1.2.3',
            environment: 'production',
            timestamp: new Date().toISOString(),
          },
        },
        actors: ['user1', 'user2'],
        metrics: {
          duration: 120,
          errors: 0,
        },
      };

      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', complexData);

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect((result as ReviewSummary & { data: unknown }).data).toEqual(complexData);
    });

    it('should pass headers to transformation context', async () => {
      const webhookData = { field: 'value' };
      const headers = { 'x-custom-header': 'custom-value' };

      // Store data with headers
      const dataWithHeaders = {
        data: webhookData,
        headers: headers,
      };
      (
        (global as Record<string, unknown>).__visor_webhook_data as Map<
          string,
          Record<string, unknown>
        >
      ).set('/webhook/test', dataWithHeaders);

      mockConfig.transform = '{"header": "{{ headers[\'x-custom-header\'] }}"}';

      await provider.execute(mockPRInfo, mockConfig, new Map());

      expect(mockLiquid.parseAndRender).toHaveBeenCalledWith(
        mockConfig.transform,
        expect.objectContaining({
          webhook: dataWithHeaders,
          pr: expect.objectContaining({
            number: mockPRInfo.number,
          }),
        })
      );
    });

    it('should handle webhook data as an object properly', async () => {
      // Ensure the object is properly initialized
      const webhookStore = (global as Record<string, unknown>).__visor_webhook_data as Map<
        string,
        Record<string, unknown>
      >;
      expect(webhookStore).toBeInstanceOf(Map);

      const data = { test: 'data' };
      webhookStore.set('/webhook/test', data);

      expect(webhookStore.get('/webhook/test')).toEqual(data);

      const result = await provider.execute(mockPRInfo, mockConfig, new Map());

      expect((result as ReviewSummary & { data: unknown }).data).toEqual(data);
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

    it('should require endpoint field', async () => {
      delete mockConfig.endpoint;

      const isValid = await provider.validateConfig(mockConfig);
      expect(isValid).toBe(false);
    });

    it('should validate with optional transform field', async () => {
      mockConfig.transform = '{"custom": "{{ webhook.field }}"}';

      const isValid = await provider.validateConfig(mockConfig);
      expect(isValid).toBe(true);
    });
  });
});
