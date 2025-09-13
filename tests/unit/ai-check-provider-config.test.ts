import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import { AIReviewService } from '../../src/ai-review-service';

// Mock the AI review service
jest.mock('../../src/ai-review-service');

describe('AI Check Provider - Enhanced Configuration', () => {
  let provider: AICheckProvider;
  let mockPRInfo: PRInfo;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    provider = new AICheckProvider();

    mockPRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test description',
      author: 'testuser',
      base: 'main',
      head: 'feature/test',
      files: [
        {
          filename: 'src/test.ts',
          additions: 10,
          deletions: 5,
          changes: 15,
          status: 'modified',
        },
      ],
      totalAdditions: 10,
      totalDeletions: 5,
      isIncremental: false,
    };

    // Reset environment
    process.env = { ...originalEnv };
    process.env.TEST_API_KEY = 'test-key';
    process.env.TEST_MODEL = 'gpt-4';
    process.env.TEST_PROVIDER = 'openai';

    // Mock the AI service
    (AIReviewService as jest.MockedClass<typeof AIReviewService>).mockClear();
    const mockAIService = {
      executeReview: jest.fn().mockResolvedValue({
        issues: [],
        suggestions: [],
        overallScore: 8.5,
        summary: 'Test review completed',
      }),
    };
    (AIReviewService as jest.MockedClass<typeof AIReviewService>).mockImplementation(
      () => mockAIService as any
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe('ai_model and ai_provider configuration', () => {
    test('should use check-level ai_model and ai_provider', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_model: 'gpt-4-turbo',
        ai_provider: 'openai' as const,
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalledWith({
        model: 'gpt-4-turbo',
        provider: 'openai',
      });
    });

    test('should prioritize ai_model over ai.model', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai: {
          model: 'gpt-3.5-turbo',
          provider: 'openai' as const,
        },
        ai_model: 'claude-3-opus',
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalledWith({
        model: 'claude-3-opus', // Should use ai_model, not ai.model
        provider: 'openai',
      });
    });

    test('should prioritize ai_provider over ai.provider', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai: {
          model: 'gpt-4',
          provider: 'openai' as const,
        },
        ai_provider: 'anthropic' as const,
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalledWith({
        model: 'gpt-4',
        provider: 'anthropic', // Should use ai_provider, not ai.provider
      });
    });

    test('should handle all AI providers', async () => {
      const providerTypes: Array<'google' | 'anthropic' | 'openai'> = [
        'google',
        'anthropic',
        'openai',
      ];

      for (const providerType of providerTypes) {
        const config = {
          type: 'ai',
          prompt: 'Test prompt',
          ai_provider: providerType,
          ai_model: `${providerType}-model`,
        };

        await provider.execute(mockPRInfo, config);

        expect(AIReviewService).toHaveBeenCalledWith({
          model: `${providerType}-model`,
          provider: providerType,
        });
      }
    });

    test('should work with only ai_model specified', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_model: 'custom-model-name',
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalledWith({
        model: 'custom-model-name',
      });
    });

    test('should work with only ai_provider specified', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_provider: 'anthropic' as const,
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalledWith({
        provider: 'anthropic',
      });
    });
  });

  describe('environment configuration', () => {
    test('should apply environment variables during check execution', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        env: {
          CUSTOM_API_KEY: '${{ env.TEST_API_KEY }}',
          CUSTOM_MODEL: '${TEST_MODEL}',
          STATIC_VAR: 'static-value',
          NUMERIC_VAR: 42,
        },
      };

      // Verify environment is not set initially
      expect(process.env.CUSTOM_API_KEY).toBeUndefined();
      expect(process.env.CUSTOM_MODEL).toBeUndefined();
      expect(process.env.STATIC_VAR).toBeUndefined();

      await provider.execute(mockPRInfo, config);

      // Environment should be restored after execution
      expect(process.env.CUSTOM_API_KEY).toBeUndefined();
      expect(process.env.CUSTOM_MODEL).toBeUndefined();
      expect(process.env.STATIC_VAR).toBeUndefined();
    });

    test('should resolve GitHub Actions style environment variables', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt with env: ${{ env.CUSTOM_API_KEY }}',
        env: {
          CUSTOM_API_KEY: '${{ env.TEST_API_KEY }}',
          COMPLEX_VAR: 'prefix-${{ env.TEST_PROVIDER }}-suffix',
        },
      };

      await provider.execute(mockPRInfo, config);

      // Execution should complete successfully with resolved variables
      expect(AIReviewService).toHaveBeenCalled();
    });

    test('should resolve shell style environment variables', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        env: {
          SHELL_VAR: '${TEST_MODEL}',
          SIMPLE_VAR: '$TEST_PROVIDER',
          MIXED_VAR: '${TEST_MODEL}/$TEST_PROVIDER',
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalled();
    });

    test('should handle environment variables in combination with ai_model and ai_provider', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_model: 'custom-model',
        ai_provider: 'anthropic' as const,
        env: {
          ANTHROPIC_API_KEY: '${{ env.TEST_API_KEY }}',
          MODEL_NAME: 'custom-model',
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalledWith({
        model: 'custom-model',
        provider: 'anthropic',
      });
    });

    test('should restore environment even if execution fails', async () => {
      const mockAIService = AIReviewService as jest.MockedClass<typeof AIReviewService>;
      mockAIService.mockImplementation(
        () =>
          ({
            executeReview: jest.fn().mockRejectedValue(new Error('AI service error')),
          }) as any
      );

      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        env: {
          TEMP_VAR: 'temporary-value',
        },
      };

      // Verify environment is not set initially
      expect(process.env.TEMP_VAR).toBeUndefined();

      await expect(provider.execute(mockPRInfo, config)).rejects.toThrow('AI service error');

      // Environment should be restored even after error
      expect(process.env.TEMP_VAR).toBeUndefined();
    });
  });

  describe('configuration validation', () => {
    test('should include new config keys in supported keys list', () => {
      const supportedKeys = provider.getSupportedConfigKeys();

      expect(supportedKeys).toContain('ai_model');
      expect(supportedKeys).toContain('ai_provider');
      expect(supportedKeys).toContain('env');
    });

    test('should validate ai_provider values', async () => {
      const validProviders = ['google', 'anthropic', 'openai'];

      for (const providerType of validProviders) {
        const config = {
          type: 'ai',
          prompt: 'Test prompt',
          ai_provider: providerType,
        };

        const isValid = await provider.validateConfig(config);
        expect(isValid).toBe(true);
      }
    });

    test('should validate configuration with all new fields', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_model: 'gpt-4',
        ai_provider: 'openai',
        env: {
          API_KEY: '${{ env.TEST_API_KEY }}',
          MODEL: 'test-model',
        },
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    test('should work with complex configuration combining all features', async () => {
      const config = {
        type: 'ai',
        prompt: {
          content:
            'Analyze this PR using model: ${{ env.CUSTOM_MODEL }}\n' +
            'Files: {{ files | size }}\n' +
            'Provider: {{ utils.provider }}',
        },
        ai_model: 'gpt-4-turbo',
        ai_provider: 'openai' as const,
        ai: {
          timeout: 60000,
          debug: true,
        },
        env: {
          CUSTOM_MODEL: '${TEST_MODEL}',
          OPENAI_API_KEY: '${{ env.TEST_API_KEY }}',
          PROVIDER_NAME: 'openai',
        },
        schema: 'code-review',
        group: 'security',
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(AIReviewService).toHaveBeenCalledWith({
        model: 'gpt-4-turbo',
        provider: 'openai',
        timeout: 60000,
        debug: true,
      });
    });

    test('should handle environment resolution in prompts', async () => {
      const config = {
        type: 'ai',
        prompt: {
          content: 'Use API key: ${{ env.RESOLVED_KEY }} for analysis',
        },
        env: {
          RESOLVED_KEY: '${{ env.TEST_API_KEY }}',
        },
      };

      await provider.execute(mockPRInfo, config);

      expect(AIReviewService).toHaveBeenCalled();
    });
  });
});
