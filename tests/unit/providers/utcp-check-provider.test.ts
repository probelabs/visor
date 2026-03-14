import { UtcpCheckProvider } from '../../../src/providers/utcp-check-provider';

// Mock the UTCP SDK
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockGetTools = jest
  .fn()
  .mockResolvedValue([{ name: 'test_manual.analyze', description: 'Analyze code' }]);
const mockCallTool = jest.fn().mockResolvedValue({ status: 'ok', data: 'result' });
const mockCreate = jest.fn().mockResolvedValue({
  close: mockClose,
  getTools: mockGetTools,
  callTool: mockCallTool,
});

jest.mock('@utcp/sdk', () => ({
  UtcpClient: {
    create: (...args: any[]) => mockCreate(...args),
  },
}));

jest.mock('@utcp/http', () => ({}));

// Mock fs for file-based manual tests
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(),
}));

describe('UTCP Check Provider', () => {
  let provider: UtcpCheckProvider;
  const mockPRInfo = {
    number: 42,
    title: 'Test PR',
    body: 'Test body',
    author: 'testuser',
    base: 'main',
    head: 'feature-branch',
    files: [
      {
        filename: 'src/index.ts',
        status: 'modified' as const,
        additions: 10,
        deletions: 5,
        changes: 15,
        patch: '@@ -1,5 +1,10 @@\n+new code',
      },
    ],
    totalAdditions: 10,
    totalDeletions: 5,
    eventType: 'manual' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new UtcpCheckProvider();
    mockCreate.mockResolvedValue({
      close: mockClose,
      getTools: mockGetTools,
      callTool: mockCallTool,
    });
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(provider.getName()).toBe('utcp');
    });

    it('should have correct description', () => {
      const desc = provider.getDescription();
      expect(desc).toContain('UTCP');
    });

    it('should be available when SDK is importable', async () => {
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('should list requirements', () => {
      const reqs = provider.getRequirements();
      expect(reqs.some(r => r.includes('@utcp/sdk'))).toBe(true);
      expect(reqs.some(r => r.includes('manual'))).toBe(true);
      expect(reqs.some(r => r.includes('method'))).toBe(true);
    });

    it('should list supported config keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('type');
      expect(keys).toContain('manual');
      expect(keys).toContain('method');
      expect(keys).toContain('methodArgs');
      expect(keys).toContain('variables');
      expect(keys).toContain('plugins');
      expect(keys).toContain('transform');
      expect(keys).toContain('transform_js');
      expect(keys).toContain('timeout');
    });
  });

  describe('validateConfig', () => {
    it('should accept valid URL manual config', async () => {
      const result = await provider.validateConfig({
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'analyze',
      });
      expect(result).toBe(true);
    });

    it('should accept valid file path manual config', async () => {
      const result = await provider.validateConfig({
        type: 'utcp',
        manual: './tools/manual.json',
        method: 'lint',
      });
      expect(result).toBe(true);
    });

    it('should accept valid inline manual config', async () => {
      const result = await provider.validateConfig({
        type: 'utcp',
        manual: {
          call_template_type: 'http',
          url: 'https://api.example.com/utcp',
          http_method: 'GET',
        },
        method: 'analyze',
      });
      expect(result).toBe(true);
    });

    it('should reject missing manual', async () => {
      const result = await provider.validateConfig({
        type: 'utcp',
        method: 'analyze',
      });
      expect(result).toBe(false);
    });

    it('should reject missing method', async () => {
      const result = await provider.validateConfig({
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
      });
      expect(result).toBe(false);
    });

    it('should reject wrong type', async () => {
      const result = await provider.validateConfig({
        type: 'mcp',
        manual: 'https://api.example.com/utcp',
        method: 'analyze',
      });
      expect(result).toBe(false);
    });

    it('should reject inline manual without call_template_type', async () => {
      const result = await provider.validateConfig({
        type: 'utcp',
        manual: { url: 'https://api.example.com/utcp' },
        method: 'analyze',
      });
      expect(result).toBe(false);
    });

    it('should reject invalid URL format', async () => {
      const result = await provider.validateConfig({
        type: 'utcp',
        manual: 'http://[invalid',
        method: 'analyze',
      });
      expect(result).toBe(false);
    });

    it('should reject null config', async () => {
      const result = await provider.validateConfig(null);
      expect(result).toBe(false);
    });

    it('should reject non-object config', async () => {
      const result = await provider.validateConfig('not an object');
      expect(result).toBe(false);
    });
  });

  describe('execute', () => {
    it('should create client, call tool, and return output', async () => {
      mockCallTool.mockResolvedValue({ status: 'ok', data: 'test result' });

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'analyze',
        methodArgs: { input: 'test' },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          manual_call_templates: [
            expect.objectContaining({
              call_template_type: 'http',
              url: 'https://api.example.com/utcp',
              http_method: 'GET',
            }),
          ],
        })
      );
      // Tool name resolved via suffix match: 'analyze' -> 'test_manual.analyze'
      expect(mockCallTool).toHaveBeenCalledWith('test_manual.analyze', { input: 'test' });
      expect(result.issues).toEqual([]);
      expect((result as any).output).toEqual({ status: 'ok', data: 'test result' });
      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle inline manual', async () => {
      mockCallTool.mockResolvedValue('inline result');

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: {
          name: 'my_api',
          call_template_type: 'http',
          url: 'https://api.example.com/utcp',
          http_method: 'GET',
        },
        method: 'check',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          manual_call_templates: [
            expect.objectContaining({
              name: 'my_api',
              call_template_type: 'http',
            }),
          ],
        })
      );
      expect(result.issues).toEqual([]);
      expect((result as any).output).toBe('inline result');
    });

    it('should resolve variables through EnvironmentResolver', async () => {
      process.env.TEST_UTCP_KEY = 'resolved-key-123';

      await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'analyze',
        variables: {
          API_KEY: '${TEST_UTCP_KEY}',
        },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          variables: expect.objectContaining({
            API_KEY: 'resolved-key-123',
          }),
        })
      );

      delete process.env.TEST_UTCP_KEY;
    });

    it('should handle mock hook', async () => {
      const mockResult = { issues: [{ file: 'test', message: 'mock issue' }], output: 'mocked' };
      const sessionInfo = {
        hooks: {
          mockForStep: jest.fn().mockReturnValue(mockResult),
        },
      };

      const result = await provider.execute(
        mockPRInfo,
        { type: 'utcp', manual: 'https://example.com/utcp', method: 'test', checkName: 'my-step' },
        undefined,
        sessionInfo
      );

      expect(sessionInfo.hooks.mockForStep).toHaveBeenCalledWith('my-step');
      expect(result.issues).toEqual([{ file: 'test', message: 'mock issue' }]);
      expect((result as any).output).toBe('mocked');
      // Should NOT create a client
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('should extract issues from structured output', async () => {
      mockCallTool.mockResolvedValue({
        issues: [
          {
            file: 'src/index.ts',
            line: 10,
            message: 'Potential issue found',
            severity: 'warning',
            category: 'security',
            ruleId: 'sec-001',
          },
        ],
        summary: 'Analysis complete',
      });

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'scan',
      });

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({
        file: 'src/index.ts',
        line: 10,
        message: 'Potential issue found',
        severity: 'warning',
        category: 'security',
        ruleId: 'sec-001',
      });
      expect((result as any).output).toEqual({ summary: 'Analysis complete' });
    });

    it('should handle client creation errors', async () => {
      mockCreate.mockRejectedValue(new Error('SDK initialization failed'));

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'analyze',
      });

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({
        ruleId: 'utcp/execution_error',
        severity: 'error',
        message: expect.stringContaining('SDK initialization failed'),
      });
    });

    it('should handle tool call errors', async () => {
      mockCallTool.mockRejectedValue(new Error('Tool not found'));

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'nonexistent_tool',
      });

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({
        ruleId: 'utcp/execution_error',
        severity: 'error',
        message: expect.stringContaining('Tool not found'),
      });
      // Client should still be closed
      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle timeout errors', async () => {
      mockCallTool.mockRejectedValue(new Error('UTCP tool call timed out after 60s'));

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'slow_tool',
        timeout: 60,
      });

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({
        ruleId: 'utcp/timeout',
        severity: 'warning',
        message: expect.stringContaining('timed out'),
      });
    });

    it('should close client even on error', async () => {
      mockCallTool.mockRejectedValue(new Error('Some error'));

      await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'analyze',
      });

      expect(mockClose).toHaveBeenCalled();
    });

    it('should return empty issues for non-issue output', async () => {
      mockCallTool.mockResolvedValue('plain text result');

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'analyze',
      });

      expect(result.issues).toEqual([]);
      expect((result as any).output).toBe('plain text result');
    });

    it('should pass empty methodArgs when not provided', async () => {
      await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'simple_tool',
      });

      expect(mockCallTool).toHaveBeenCalledWith('simple_tool', {});
    });

    it('should derive manual name from URL', async () => {
      await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.weather.com/utcp',
        method: 'get_weather',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          manual_call_templates: [
            expect.objectContaining({
              name: 'api_weather_com',
            }),
          ],
        })
      );
    });
  });

  describe('issue extraction', () => {
    it('should extract issues from array output', async () => {
      mockCallTool.mockResolvedValue([
        {
          file: 'test.ts',
          line: 1,
          message: 'Issue 1',
          severity: 'error',
          category: 'logic',
        },
        {
          file: 'test.ts',
          line: 5,
          message: 'Issue 2',
          severity: 'warning',
          category: 'style',
        },
      ]);

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'scan',
      });

      expect(result.issues).toHaveLength(2);
      expect(result.issues![0].message).toBe('Issue 1');
      expect(result.issues![1].message).toBe('Issue 2');
    });

    it('should use default ruleId of utcp', async () => {
      mockCallTool.mockResolvedValue([{ file: 'test.ts', line: 1, message: 'No rule specified' }]);

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'scan',
      });

      expect(result.issues![0].ruleId).toBe('utcp');
    });

    it('should normalize severity aliases', async () => {
      mockCallTool.mockResolvedValue({
        issues: [{ message: 'Test', level: 'error', file: 'test.ts', line: 1 }],
      });

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'scan',
      });

      expect(result.issues![0].severity).toBe('error');
    });

    it('should normalize file aliases', async () => {
      mockCallTool.mockResolvedValue({
        issues: [{ message: 'Test', path: 'src/app.ts', lineNumber: 42 }],
      });

      const result = await provider.execute(mockPRInfo, {
        type: 'utcp',
        manual: 'https://api.example.com/utcp',
        method: 'scan',
      });

      expect(result.issues![0].file).toBe('src/app.ts');
      expect(result.issues![0].line).toBe(42);
    });
  });
});
