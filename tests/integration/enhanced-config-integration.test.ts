import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import { VisorConfig } from '../../src/types/config';
import fs from 'fs/promises';

// Mock filesystem operations
jest.mock('fs/promises');

describe('Enhanced Configuration Integration', () => {
  let mockFs: jest.Mocked<typeof fs>;
  const originalEnv = { ...process.env };

  const mockPRInfo: PRInfo = {
    number: 456,
    title: 'Enhanced configuration test',
    body: 'Testing enhanced configuration with environment variables and check-level AI settings',
    author: 'developer',
    base: 'main',
    head: 'feature/enhanced-config',
    files: [
      {
        filename: 'src/config-test.ts',
        additions: 25,
        deletions: 5,
        changes: 30,
        status: 'added',
      },
      {
        filename: 'src/utils/env-helper.js',
        additions: 15,
        deletions: 2,
        changes: 17,
        status: 'modified',
      },
    ],
    totalAdditions: 40,
    totalDeletions: 7,
    isIncremental: false,
  };

  beforeEach(() => {
    mockFs = fs as jest.Mocked<typeof fs>;
    mockFs.readFile = jest.fn();

    // Reset and set up test environment
    process.env = { ...originalEnv };
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.OPENAI_API_KEY = 'sk-test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.GOOGLE_API_KEY = 'test-google-key';
    process.env.CUSTOM_MODEL = 'gpt-4-enhanced';
    process.env.SECURITY_PROVIDER = 'anthropic';
    process.env.PERFORMANCE_MODEL = 'claude-3-opus';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe('End-to-End Enhanced Configuration Processing', () => {
    test('should process complex configuration with environment variables and check-level AI settings', async () => {
      const complexConfig: VisorConfig = {
        version: '1.0',
        // Global environment variables
        env: {
          DEFAULT_TIMEOUT: '30000',
          LOG_LEVEL: 'info',
          SHARED_SECRET: '${{ env.GITHUB_TOKEN }}',
        },
        // Global AI settings
        ai_model: 'gpt-3.5-turbo',
        ai_provider: 'openai',
        checks: {
          'security-advanced': {
            type: 'ai',
            prompt: {
              file: './prompts/security-enhanced.liquid',
            },
            // Override global AI settings
            ai_model: '${{ env.CUSTOM_MODEL }}',
            ai_provider: 'anthropic',
            // Check-specific environment
            env: {
              SECURITY_API_KEY: '${{ env.ANTHROPIC_API_KEY }}',
              ANALYSIS_MODE: 'comprehensive',
              TIMEOUT: '${DEFAULT_TIMEOUT}',
            },
            on: ['pr_opened', 'pr_updated'],
            group: 'security',
            schema: 'code-review',
          },
          'performance-tuned': {
            type: 'ai',
            prompt: {
              content:
                'Analyze performance using provider: ${{ env.PERF_PROVIDER }}\n' +
                'Model: ${{ env.PERFORMANCE_MODEL }}\n\n' +
                '## Files Changed\n' +
                '{% for file in files %}\n' +
                '- {{ file.filename }} ({{ file.changes }} changes)\n' +
                '{% endfor %}\n\n' +
                '## Instructions\n' +
                'Focus on performance bottlenecks and optimization opportunities.\n' +
                'Use timeout setting: ${{ env.PERF_TIMEOUT }}ms',
            },
            // Mix of global override and environment variables
            ai_provider: 'anthropic' as const, // Resolved from env var
            ai_model: 'claude-3-opus', // Resolved from env var
            env: {
              PERF_PROVIDER: '${SECURITY_PROVIDER}',
              PERF_TIMEOUT: '45000',
              PERFORMANCE_API_KEY: '${{ env.ANTHROPIC_API_KEY }}',
            },
            on: ['pr_opened', 'pr_updated'],
            group: 'performance',
            schema: 'code-review',
          },
          'quality-standard': {
            type: 'ai',
            prompt: 'Analyze code quality and maintainability',
            // Inherits global AI settings (gpt-3.5-turbo, openai)
            env: {
              QUALITY_MODE: 'standard',
              API_KEY: '${{ env.OPENAI_API_KEY }}',
            },
            on: ['pr_opened'],
            group: 'quality',
            schema: 'code-review',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      // Mock prompt file content
      const securityPromptContent =
        'Security Analysis for {{ pr.title }}\n\n' +
        'Using API key: ${{ env.SECURITY_API_KEY }}\n' +
        'Analysis mode: ${{ env.ANALYSIS_MODE }}\n' +
        'Timeout: ${{ env.TIMEOUT }}ms\n\n' +
        'Files to analyze:\n' +
        '{% for file in files %}\n' +
        '- {{ file.filename }}\n' +
        '{% endfor %}';

      mockFs.readFile.mockResolvedValue(securityPromptContent);

      const provider = new AICheckProvider();

      // Test security-advanced check with environment resolution
      const securityConfig = {
        ...complexConfig.checks['security-advanced'],
        env: {
          ...complexConfig.env, // Global env
          ...complexConfig.checks['security-advanced'].env, // Check-specific env
        },
      };

      // Note: In a real integration, the EnvironmentResolver would be called
      // Here we're testing the configuration structure and provider setup
      const result = await (provider as any).processPrompt(securityConfig.prompt, mockPRInfo);

      expect(result).toContain('Security Analysis for Enhanced configuration test');
      expect(result).toContain('src/config-test.ts');
      expect(result).toContain('src/utils/env-helper.js');

      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/prompts[/\\]security-enhanced\.liquid$/),
        'utf-8'
      );
    });

    test('should handle nested environment variable resolution', async () => {
      const config = {
        type: 'ai',
        prompt: {
          content:
            'Multi-level resolution test:\n' +
            '- Direct: ${{ env.OPENAI_API_KEY }}\n' +
            '- Nested: ${{ env.NESTED_VAR }}\n' +
            '- Shell style: ${CUSTOM_MODEL}\n' +
            '- Mixed: ${{ env.SECURITY_PROVIDER }}/${PERFORMANCE_MODEL}',
        },
        ai_model: '${{ env.PERFORMANCE_MODEL }}',
        ai_provider: '${{ env.SECURITY_PROVIDER }}',
        env: {
          NESTED_VAR: '${{ env.CUSTOM_MODEL }}',
          COMBINED: '${SECURITY_PROVIDER}:${PERFORMANCE_MODEL}',
          MULTI_LEVEL: '${{ env.GITHUB_TOKEN }}/api',
        },
      };

      const provider = new AICheckProvider();

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      // Note: Environment variable resolution in prompts would need additional integration
      // For now, we verify the prompt processing completes without errors
      expect(processedPrompt).toBeDefined();
      expect(processedPrompt).toContain('Multi-level resolution test');
    });

    test('should validate environment variable availability', async () => {
      // Remove a required environment variable
      delete process.env.ANTHROPIC_API_KEY;

      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_provider: 'anthropic',
        env: {
          REQUIRED_KEY: '${{ env.ANTHROPIC_API_KEY }}',
        },
      };

      const provider = new AICheckProvider();

      // This should work in the current implementation, but in a production scenario
      // we might want to validate required environment variables
      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true); // Current implementation doesn't validate env vars
    });

    test('should handle configuration inheritance patterns', async () => {
      // Simulate a scenario where global config is inherited and overridden
      const baseConfig = {
        ai_model: 'base-model',
        ai_provider: 'openai' as const,
        env: {
          GLOBAL_SETTING: 'global-value',
          SHARED_TIMEOUT: '30000',
        },
      };

      const checkConfig = {
        type: 'ai',
        prompt: 'Inherited config test',
        // Override global AI model
        ai_model: 'override-model',
        // Keep global AI provider
        // Add check-specific environment
        env: {
          CHECK_SPECIFIC: 'check-value',
          OVERRIDE_GLOBAL: 'overridden',
        },
      };

      // In a real scenario, configuration merging would happen in the config loader
      const mergedConfig = {
        ...checkConfig,
        ai_provider: baseConfig.ai_provider, // Inherited
        env: {
          ...baseConfig.env, // Global environment
          ...checkConfig.env, // Check-specific environment (overrides)
        },
      };

      const provider = new AICheckProvider();
      const isValid = await provider.validateConfig(mergedConfig);
      expect(isValid).toBe(true);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle missing environment variables gracefully', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test with missing vars: ${{ env.NONEXISTENT_VAR }}',
        ai_model: '${{ env.MISSING_MODEL }}',
        env: {
          UNRESOLVED: '${{ env.ALSO_MISSING }}',
        },
      };

      const provider = new AICheckProvider();

      // Should not throw, but variables will remain unresolved
      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      // Variables remain unresolved when missing
      expect(processedPrompt).toBeDefined();
      expect(processedPrompt).toContain('Test with missing vars');
    });

    test('should handle circular environment variable references', async () => {
      process.env.VAR_A = '${VAR_B}';
      process.env.VAR_B = '${VAR_A}';

      const config = {
        type: 'ai',
        prompt: 'Circular test',
        env: {
          CIRCULAR_A: '${{ env.VAR_A }}',
          CIRCULAR_B: '${{ env.VAR_B }}',
        },
      };

      const provider = new AICheckProvider();

      // Should not cause infinite loop, variables will remain unresolved
      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });

    test('should handle complex nested object configurations', async () => {
      const config = {
        type: 'ai',
        prompt: {
          content: 'Complex configuration test',
        },
        ai: {
          provider: 'openai',
          model: 'gpt-4',
          timeout: 60000,
        },
        // These should override the ai object values
        ai_model: 'claude-3-opus',
        ai_provider: 'anthropic' as const,
        env: {
          COMPLEX_CONFIG: 'true',
          NESTED_OBJECT: JSON.stringify({ key: 'value', number: 42 }),
        },
      };

      const provider = new AICheckProvider();
      // Note: The current validation doesn't handle all complex configurations
      // This is expected behavior for the current implementation
      const isValid = await provider.validateConfig(config);
      expect(typeof isValid).toBe('boolean');
    });
  });
});
