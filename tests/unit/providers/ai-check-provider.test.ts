/* eslint-disable @typescript-eslint/no-explicit-any */
import { AICheckProvider } from '../../../src/providers/ai-check-provider';
import { PRInfo } from '../../../src/pr-analyzer';
import { CheckProviderConfig } from '../../../src/providers/check-provider.interface';
import * as AIReviewService from '../../../src/ai-review-service';

jest.mock('../../../src/ai-review-service');

describe('AICheckProvider', () => {
  let provider: AICheckProvider;
  let mockPRInfo: PRInfo;

  beforeEach(() => {
    provider = new AICheckProvider();
    mockPRInfo = {
      number: 1,
      title: 'Test PR',
      body: 'Test description',
      author: 'testuser',
      base: 'main',
      head: 'feature',
      files: [
        {
          filename: 'test.ts',
          status: 'modified',
          additions: 10,
          deletions: 5,
          changes: 15,
          patch: '+ added line',
        },
      ],
      totalAdditions: 10,
      totalDeletions: 5,
    };
  });

  describe('getName', () => {
    it('should return "ai"', () => {
      expect(provider.getName()).toBe('ai');
    });
  });

  describe('getDescription', () => {
    it('should return descriptive text', () => {
      expect(provider.getDescription()).toContain('AI-powered');
    });
  });

  describe('validateConfig', () => {
    it('should validate correct AI config', async () => {
      const config = {
        type: 'ai',
        prompt: 'security',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should reject invalid type', async () => {
      const config = {
        type: 'tool',
        prompt: 'security',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject missing prompt', async () => {
      const config = {
        type: 'ai',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should accept focus field', async () => {
      const config = {
        type: 'ai',
        focus: 'performance',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate AI provider config', async () => {
      const config = {
        type: 'ai',
        prompt: 'all',
        ai: {
          provider: 'google',
          model: 'gemini-2.0',
        },
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should reject invalid provider', async () => {
      const config = {
        type: 'ai',
        prompt: 'all',
        ai: {
          provider: 'invalid',
        },
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute AI review with default config', async () => {
      const mockReview = {
        overallScore: 85,
        totalIssues: 2,
        criticalIssues: 0,
        suggestions: ['Consider refactoring'],
        comments: [],
      };

      const mockService = {
        executeReview: jest.fn().mockResolvedValue(mockReview),
      };

      (AIReviewService as any).AIReviewService = jest.fn().mockImplementation(() => mockService);

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'all',
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toEqual(mockReview);
      expect(mockService.executeReview).toHaveBeenCalledWith(
        mockPRInfo,
        'all',
        undefined,
        undefined,
        undefined
      );
    });

    it('should map security prompt to security focus', async () => {
      const mockReview = {
        overallScore: 75,
        totalIssues: 3,
        criticalIssues: 1,
        suggestions: [],
        comments: [],
      };

      const mockService = {
        executeReview: jest.fn().mockResolvedValue(mockReview),
      };

      (AIReviewService as any).AIReviewService = jest.fn().mockImplementation(() => mockService);

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'security',
      };

      await provider.execute(mockPRInfo, config);

      expect(mockService.executeReview).toHaveBeenCalledWith(
        mockPRInfo,
        'security',
        undefined,
        undefined,
        undefined
      );
    });

    it('should pass AI config to service', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
        suggestions: [],
        comments: [],
      };

      const mockService = {
        executeReview: jest.fn().mockResolvedValue(mockReview),
      };

      let capturedConfig: any;
      (AIReviewService as any).AIReviewService = jest.fn().mockImplementation(config => {
        capturedConfig = config;
        return mockService;
      });

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'all',
        ai: {
          provider: 'google',
          model: 'gemini-2.0',
          apiKey: 'test-key',
          timeout: 60000,
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(capturedConfig).toEqual({
        provider: 'google',
        model: 'gemini-2.0',
        apiKey: 'test-key',
        timeout: 60000,
      });
    });
  });

  describe('getSupportedConfigKeys', () => {
    it('should return list of supported keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('type');
      expect(keys).toContain('prompt');
      expect(keys).toContain('focus');
      expect(keys).toContain('ai.provider');
      expect(keys).toContain('ai.model');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is available', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';
      expect(await provider.isAvailable()).toBe(true);
      delete process.env.GOOGLE_API_KEY;
    });

    it('should return false when no API key is available', async () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe('getRequirements', () => {
    it('should return list of requirements', () => {
      const requirements = provider.getRequirements();
      expect(requirements).toEqual(expect.arrayContaining([expect.stringContaining('API_KEY')]));
    });
  });
});
