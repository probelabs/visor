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
        // Workspace root should be used as primary working directory for tools
        path: '/tmp/ws-123',
      });

      // allowedFolders should contain the workspace root plus all project paths, de-duped
      expect(capturedConfig.allowedFolders).toEqual(
        expect.arrayContaining(['/tmp/ws-123', '/tmp/ws-123/tyk', '/tmp/ws-123/tyk-docs'])
      );
    });

    it('excludes main project by default when include_main_project is not set', async () => {
      const mockReview = { overallScore: 90, totalIssues: 0, criticalIssues: 0, comments: [] };
      const mockService = { executeReview: jest.fn().mockResolvedValue(mockReview) };

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
        listProjects: () => [{ name: 'tyk', path: '/tmp/ws-123/tyk' }],
      };

      const execContext: any = {
        _parentContext: {
          workspace,
          config: {},
        },
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'code_help',
        ai: { provider: 'google', model: 'gemini-2.5-pro' },
      };

      await provider.execute(mockPRInfo, config, undefined, execContext);

      expect(capturedConfig.allowedFolders).toEqual(
        expect.arrayContaining(['/tmp/ws-123', '/tmp/ws-123/tyk'])
      );
      expect(capturedConfig.allowedFolders).not.toEqual(
        expect.arrayContaining(['/tmp/ws-123/main-project'])
      );
    });

    it('includes main project when workspace.include_main_project is true', async () => {
      const mockReview = { overallScore: 90, totalIssues: 0, criticalIssues: 0, comments: [] };
      const mockService = { executeReview: jest.fn().mockResolvedValue(mockReview) };

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
        listProjects: () => [{ name: 'tyk', path: '/tmp/ws-123/tyk' }],
      };

      const execContext: any = {
        _parentContext: {
          workspace,
          config: { workspace: { include_main_project: true } },
        },
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'code_help',
        ai: { provider: 'google', model: 'gemini-2.5-pro' },
      };

      await provider.execute(mockPRInfo, config, undefined, execContext);

      expect(capturedConfig.allowedFolders).toEqual(
        expect.arrayContaining(['/tmp/ws-123', '/tmp/ws-123/main-project', '/tmp/ws-123/tyk'])
      );
    });

    it('includes main project when VISOR_WORKSPACE_INCLUDE_MAIN_PROJECT is true', async () => {
      const mockReview = { overallScore: 90, totalIssues: 0, criticalIssues: 0, comments: [] };
      const mockService = { executeReview: jest.fn().mockResolvedValue(mockReview) };

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
        listProjects: () => [{ name: 'tyk', path: '/tmp/ws-123/tyk' }],
      };

      const execContext: any = {
        _parentContext: {
          workspace,
          config: { workspace: { include_main_project: false } },
        },
      };

      process.env.VISOR_WORKSPACE_INCLUDE_MAIN_PROJECT = 'true';

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'code_help',
        ai: { provider: 'google', model: 'gemini-2.5-pro' },
      };

      await provider.execute(mockPRInfo, config, undefined, execContext);

      expect(capturedConfig.allowedFolders).toEqual(
        expect.arrayContaining(['/tmp/ws-123', '/tmp/ws-123/main-project', '/tmp/ws-123/tyk'])
      );

      delete process.env.VISOR_WORKSPACE_INCLUDE_MAIN_PROJECT;
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

  describe('getSupportedConfigKeys for ai_custom_tools_js', () => {
    it('should include ai_custom_tools and ai_custom_tools_js in supported keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('ai_custom_tools');
      expect(keys).toContain('ai_custom_tools_js');
    });
  });

  describe('evaluateCustomToolsJs', () => {
    // Access the private method for testing via type assertion
    const getEvaluator = (p: AICheckProvider) => (p as any).evaluateCustomToolsJs.bind(p);

    it('should return empty array when expression returns non-array', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('"not an array"', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual([]);
    });

    it('should return tool names from simple expression', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('["tool1", "tool2"]', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual(['tool1', 'tool2']);
    });

    it('should filter out invalid items from result array', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        '["valid-tool", 123, null, { workflow: "my-workflow" }, { invalid: true }]',
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      // Should only include string and valid workflow reference
      expect(result).toEqual(['valid-tool', { workflow: 'my-workflow' }]);
    });

    it('should access outputs from dependency results', () => {
      const evaluator = getEvaluator(provider);
      const depResults = new Map<string, any>([
        ['route-intent', { output: { intent: 'engineer', tags: ['jira'] } }],
      ]);

      const result = evaluator(
        `
        const tools = [];
        if (outputs['route-intent']?.intent === 'engineer') {
          tools.push('engineer-tool');
        }
        if (outputs['route-intent']?.tags?.includes('jira')) {
          tools.push('jira-tool');
        }
        return tools;
        `,
        mockPRInfo,
        depResults,
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual(['engineer-tool', 'jira-tool']);
    });

    it('should access pr context in expression', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        `
        const tools = [];
        if (pr.author === 'testuser') {
          tools.push('user-specific-tool');
        }
        if (pr.branch === 'feature') {
          tools.push('feature-tool');
        }
        return tools;
        `,
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual(['user-specific-tool', 'feature-tool']);
    });

    it('should access inputs from config', () => {
      const evaluator = getEvaluator(provider);
      const config = {
        type: 'ai',
        prompt: 'test',
        inputs: { feature_flag: true, project: 'tyk' },
      };

      const result = evaluator(
        `
        const tools = [];
        if (inputs.feature_flag) {
          tools.push({ workflow: 'feature-workflow', args: { project: inputs.project } });
        }
        return tools;
        `,
        mockPRInfo,
        new Map(),
        config
      );
      expect(result).toEqual([{ workflow: 'feature-workflow', args: { project: 'tyk' } }]);
    });

    it('should handle files context', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        `
        const tools = [];
        if (files.some(f => f.filename.endsWith('.ts'))) {
          tools.push('typescript-tool');
        }
        return tools;
        `,
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual(['typescript-tool']);
    });

    it('should return empty array on syntax error', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('this is not valid javascript {{}}', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual([]);
    });

    it('should return empty array on runtime error', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('throw new Error("runtime error")', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual([]);
    });

    it('should support log() helper for debugging', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const evaluator = getEvaluator(provider);

      evaluator(
        `
        log("Debug: checking outputs");
        return ["debug-tool"];
        `,
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );

      expect(consoleSpy).toHaveBeenCalledWith('[ai_custom_tools_js]', 'Debug: checking outputs');
      consoleSpy.mockRestore();
    });
  });

  describe('evaluateBashConfigJs', () => {
    const getEvaluator = (p: AICheckProvider) => (p as any).evaluateBashConfigJs.bind(p);

    it('should return empty object when expression returns non-object', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('"not an object"', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual({});
    });

    it('should return empty object when expression returns array', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('["git:*"]', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual({});
    });

    it('should return empty object when expression returns null', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('null', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual({});
    });

    it('should return allow array from expression', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('({ allow: ["git:log:*", "npm:test"] })', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual({ allow: ['git:log:*', 'npm:test'] });
    });

    it('should return deny array from expression', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        '({ deny: ["git:push:--force", "rm:-rf"] })',
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual({ deny: ['git:push:--force', 'rm:-rf'] });
    });

    it('should return both allow and deny arrays', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        '({ allow: ["git:*", "npm:*"], deny: ["git:push:--force"] })',
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual({
        allow: ['git:*', 'npm:*'],
        deny: ['git:push:--force'],
      });
    });

    it('should ignore allow if not a string array', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        '({ allow: [1, 2, 3], deny: ["valid:cmd"] })',
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual({ deny: ['valid:cmd'] });
      expect(result.allow).toBeUndefined();
    });

    it('should ignore deny if not a string array', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        '({ allow: ["valid:cmd"], deny: "not-an-array" })',
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual({ allow: ['valid:cmd'] });
      expect(result.deny).toBeUndefined();
    });

    it('should access outputs from dependency results', () => {
      const evaluator = getEvaluator(provider);
      const depResults = new Map<string, any>([
        ['build-config', { output: { bash_config: { allow: ['git:status:*'], deny: ['rm:*'] } } }],
      ]);

      const result = evaluator(
        "return outputs['build-config']?.bash_config ?? {};",
        mockPRInfo,
        depResults,
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual({ allow: ['git:status:*'], deny: ['rm:*'] });
    });

    it('should access pr context in expression', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        `
        const config = { allow: [] };
        if (pr.branch.startsWith('feature')) {
          config.allow.push('git:*');
        }
        return config;
        `,
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual({ allow: ['git:*'] });
    });

    it('should access inputs from config', () => {
      const evaluator = getEvaluator(provider);
      const config = {
        type: 'ai',
        prompt: 'test',
        inputs: { enable_docker: true },
      };

      const result = evaluator(
        `
        const cfg = { allow: ['git:*'] };
        if (inputs.enable_docker) {
          cfg.allow.push('docker:*');
        }
        return cfg;
        `,
        mockPRInfo,
        new Map(),
        config
      );
      expect(result).toEqual({ allow: ['git:*', 'docker:*'] });
    });

    it('should access files context in expression', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator(
        `
        const cfg = { allow: [] };
        if (files.some(f => f.filename.endsWith('.ts'))) {
          cfg.allow.push('npm:test');
        }
        return cfg;
        `,
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );
      expect(result).toEqual({ allow: ['npm:test'] });
    });

    it('should return empty object on syntax error', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('this is not valid javascript {{}}', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual({});
    });

    it('should return empty object on runtime error', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('throw new Error("runtime error")', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual({});
    });

    it('should return empty object for empty allow/deny', () => {
      const evaluator = getEvaluator(provider);
      const result = evaluator('({ allow: [], deny: [] })', mockPRInfo, new Map(), {
        type: 'ai',
        prompt: 'test',
      });
      expect(result).toEqual({ allow: [], deny: [] });
    });

    it('should support log() helper for debugging', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const evaluator = getEvaluator(provider);

      evaluator(
        `
        log("Debug: computing bash config");
        return { allow: ["git:*"] };
        `,
        mockPRInfo,
        new Map(),
        { type: 'ai', prompt: 'test' }
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        '[ai_bash_config_js]',
        'Debug: computing bash config'
      );
      consoleSpy.mockRestore();
    });
  });
});
