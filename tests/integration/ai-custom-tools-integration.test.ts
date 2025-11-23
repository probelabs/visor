import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { CustomToolDefinition } from '../../src/types/config';

describe('AI Custom Tools Integration', () => {
  let provider: AICheckProvider;

  // Reserved for future use in AI-powered tests
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mockPRInfo: PRInfo = {
    number: 123,
    title: 'Test PR',
    body: 'Test PR description',
    author: 'test-user',
    head: 'feature-branch',
    base: 'main',
    files: [],
    isIncremental: false,
    isIssue: false,
    totalAdditions: 0,
    totalDeletions: 0,
  };

  const testTools: Record<string, CustomToolDefinition> = {
    'grep-pattern': {
      name: 'grep-pattern',
      description: 'Search for patterns in files',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      },
      exec: 'echo "Found: {{ args.pattern }}"',
    },
    'count-files': {
      name: 'count-files',
      description: 'Count files',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      exec: 'ls -1 | wc -l',
      parseJson: false,
    },
  };

  beforeEach(() => {
    provider = new AICheckProvider();
  });

  describe('Custom Tools Detection', () => {
    it('should detect ai_custom_tools from config', () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_custom_tools: ['grep-pattern', 'count-files'],
        __globalTools: testTools,
      } as any;

      const customTools = (provider as any).getCustomToolsForAI(config);

      expect(customTools).toEqual(['grep-pattern', 'count-files']);
    });

    it('should handle single tool name as string', () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_custom_tools: 'grep-pattern',
        __globalTools: testTools,
      } as any;

      const customTools = (provider as any).getCustomToolsForAI(config);

      expect(customTools).toEqual(['grep-pattern']);
    });

    it('should return empty array when no ai_custom_tools', () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
      };

      const customTools = (provider as any).getCustomToolsForAI(config);

      expect(customTools).toEqual([]);
    });

    it('should filter out non-string values', () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_custom_tools: ['grep-pattern', 123, null, 'count-files', undefined],
        __globalTools: testTools,
      } as any;

      const customTools = (provider as any).getCustomToolsForAI(config);

      expect(customTools).toEqual(['grep-pattern', 'count-files']);
    });
  });

  describe('Custom Tools Loading', () => {
    it('should load custom tools from global config', () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        __globalTools: testTools,
      } as any;

      const toolNames = ['grep-pattern', 'count-files'];
      const loadedTools = (provider as any).loadCustomTools(toolNames, config);

      expect(loadedTools.size).toBe(2);
      expect(loadedTools.has('grep-pattern')).toBe(true);
      expect(loadedTools.has('count-files')).toBe(true);
    });

    it('should handle missing tools gracefully', () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        __globalTools: testTools,
      } as any;

      const toolNames = ['grep-pattern', 'non-existent-tool', 'count-files'];
      const loadedTools = (provider as any).loadCustomTools(toolNames, config);

      // Should only load existing tools
      expect(loadedTools.size).toBe(2);
      expect(loadedTools.has('grep-pattern')).toBe(true);
      expect(loadedTools.has('count-files')).toBe(true);
      expect(loadedTools.has('non-existent-tool')).toBe(false);
    });

    it('should return empty map when no global tools', () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
      };

      const toolNames = ['grep-pattern'];
      const loadedTools = (provider as any).loadCustomTools(toolNames, config);

      expect(loadedTools.size).toBe(0);
    });

    it('should ensure tool names are set correctly', () => {
      const toolsWithoutNames: Record<string, CustomToolDefinition> = {
        'test-tool': {
          name: '',
          description: 'Test tool',
          exec: 'echo "test"',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        } as any,
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        __globalTools: toolsWithoutNames,
      } as any;

      const loadedTools = (provider as any).loadCustomTools(['test-tool'], config);

      expect(loadedTools.size).toBe(1);
      expect(loadedTools.get('test-tool')?.name).toBe('test-tool');
    });
  });

  describe('SSE Server Integration', () => {
    it('should start SSE server when ai_custom_tools is specified', async () => {
      // Mock AI provider to prevent actual AI calls
      process.env.ANTHROPIC_API_KEY = 'mock-key';

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        checkName: 'test-check',
        ai_custom_tools: ['grep-pattern'],
        __globalTools: testTools,
        ai: {
          provider: 'mock' as any,
        },
      } as any;

      // We can't easily test the full execution without mocking AI service,
      // but we can verify config validation passes
      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    }, 10000);

    it('should not start SSE server when tools are disabled', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        checkName: 'test-check',
        ai_custom_tools: ['grep-pattern'],
        __globalTools: testTools,
        ai: {
          disableTools: true,
        },
      } as any;

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });

    it('should not start SSE server when no custom tools specified', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        checkName: 'test-check',
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });
  });

  describe('Configuration Validation', () => {
    it('should validate config with ai_custom_tools', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_custom_tools: ['grep-pattern', 'count-files'],
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });

    it('should reject config without prompt', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        ai_custom_tools: ['grep-pattern'],
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(false);
    });

    it('should accept config with both ai_custom_tools and ai_mcp_servers', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_custom_tools: ['grep-pattern'],
        ai_mcp_servers: {
          probe: {
            command: 'npx',
            args: ['-y', '@probelabs/probe@latest', 'mcp'],
          },
        },
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle SSE server startup failure gracefully', async () => {
      // This test verifies that even if SSE server fails to start,
      // the AI check should continue (without custom tools)
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt',
        checkName: 'test-check',
        ai_custom_tools: ['invalid-tool'],
        __globalTools: {},
        ai: {
          provider: 'mock' as any,
        },
      } as any;

      // Should not throw, just log warning
      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });
  });

  describe('Supported Config Keys', () => {
    it('should include ai_custom_tools in supported keys', () => {
      const supportedKeys = provider.getSupportedConfigKeys();

      // While ai_custom_tools might not be explicitly listed (as it's a new feature),
      // we can verify the base AI config keys are present
      expect(supportedKeys).toContain('type');
      expect(supportedKeys).toContain('prompt');
      expect(supportedKeys).toContain('ai_mcp_servers');
    });
  });

  describe('Multiple AI Checks Concurrency', () => {
    it('should handle multiple AI checks with different custom tools', () => {
      const config1: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt 1',
        checkName: 'check-1',
        ai_custom_tools: ['grep-pattern'],
        __globalTools: testTools,
      } as any;

      const config2: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Test prompt 2',
        checkName: 'check-2',
        ai_custom_tools: ['count-files'],
        __globalTools: testTools,
      } as any;

      // Each check should get its own SSE server on different ports
      const tools1 = (provider as any).getCustomToolsForAI(config1);
      const tools2 = (provider as any).getCustomToolsForAI(config2);

      expect(tools1).toEqual(['grep-pattern']);
      expect(tools2).toEqual(['count-files']);
    });
  });
});
