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
        type: 'command',
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

        comments: [],
        issues: [],
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

    it('should pass enableDelegate and allowEdit flags to service', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
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
        prompt: 'security review',
        ai: {
          provider: 'anthropic',
          model: 'claude-3-opus',
          enableDelegate: true,
          allowEdit: true,
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(capturedConfig).toMatchObject({
        provider: 'anthropic',
        model: 'claude-3-opus',
        enableDelegate: true,
        allowEdit: true,
      });
    });

    it('should pass allowedTools and disableTools flags to service', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
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
        prompt: 'analyze code structure',
        ai: {
          provider: 'anthropic',
          model: 'claude-3-opus',
          allowedTools: ['Read', 'Grep', 'Glob'],
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(capturedConfig).toMatchObject({
        provider: 'anthropic',
        model: 'claude-3-opus',
        allowedTools: ['Read', 'Grep', 'Glob'],
      });
    });

    it('should pass disableTools flag to service', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
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
        prompt: 'explain architecture',
        ai: {
          provider: 'openai',
          model: 'gpt-4',
          disableTools: true,
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(capturedConfig).toMatchObject({
        provider: 'openai',
        model: 'gpt-4',
        disableTools: true,
      });
    });

    it('should pass allowBash to service', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
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
        prompt: 'analyze git status',
        ai: {
          provider: 'anthropic',
          model: 'claude-3-opus',
          allowBash: true,
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(capturedConfig).toMatchObject({
        provider: 'anthropic',
        model: 'claude-3-opus',
        allowBash: true,
      });
    });

    it('should pass bashConfig with allowBash to service', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
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
        prompt: 'analyze git status with custom config',
        ai: {
          provider: 'anthropic',
          model: 'claude-3-opus',
          allowBash: true,
          bashConfig: {
            allow: ['git status', 'ls'],
            timeout: 30000,
          },
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(capturedConfig).toMatchObject({
        provider: 'anthropic',
        model: 'claude-3-opus',
        allowBash: true,
        bashConfig: {
          allow: ['git status', 'ls'],
          timeout: 30000,
        },
      });
    });

    it('derives allowedFolders and path from workspace when present on parent context', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
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

      const workspace = {
        isEnabled: () => true,
        getWorkspaceInfo: () => ({
          workspacePath: '/tmp/ws-123',
          mainProjectPath: '/tmp/ws-123/main-project',
        }),
        listProjects: () => [
          { name: 'tyk', path: '/tmp/ws-123/tyk' },
          { name: 'tyk-docs', path: '/tmp/ws-123/tyk-docs' },
        ],
      };

      const execContext: any = {
        _parentContext: {
          workspace,
        },
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'code_help',
        ai: {
          provider: 'google',
          model: 'gemini-2.5-pro',
        },
      };

      await provider.execute(mockPRInfo, config, undefined, execContext);

      expect(capturedConfig).toMatchObject({
        provider: 'google',
        model: 'gemini-2.5-pro',
        // Main project path should be used as primary working directory for tools
        path: '/tmp/ws-123/main-project',
      });

      // allowedFolders should contain the workspace plus all project paths, de-duped
      expect(capturedConfig.allowedFolders).toEqual(
        expect.arrayContaining([
          '/tmp/ws-123/main-project',
          '/tmp/ws-123',
          '/tmp/ws-123/tyk',
          '/tmp/ws-123/tyk-docs',
        ])
      );
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
      expect(keys).toContain('ai.enableDelegate');
      expect(keys).toContain('ai.allowEdit');
      expect(keys).toContain('ai.allowedTools');
      expect(keys).toContain('ai.disableTools');
      expect(keys).toContain('ai.allowBash');
      expect(keys).toContain('ai.bashConfig');
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
