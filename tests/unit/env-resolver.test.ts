import { EnvironmentResolver } from '../../src/utils/env-resolver';

describe('EnvironmentResolver', () => {
  // Store original environment variables
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment to original state
    process.env = { ...originalEnv };

    // Set up test environment variables
    process.env.TEST_API_KEY = 'test-api-key-123';
    process.env.TEST_MODEL = 'gpt-4';
    process.env.TEST_PROVIDER = 'openai';
    process.env.TEST_TIMEOUT = '30000';
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.MY_SECRET = 'super-secret-value';
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('resolveValue', () => {
    test('should resolve GitHub Actions style environment variables', () => {
      expect(EnvironmentResolver.resolveValue('${{ env.TEST_API_KEY }}')).toBe('test-api-key-123');
      expect(EnvironmentResolver.resolveValue('api-key-${{ env.TEST_API_KEY }}-suffix')).toBe(
        'api-key-test-api-key-123-suffix'
      );
      expect(EnvironmentResolver.resolveValue('${{ env.TEST_MODEL }}')).toBe('gpt-4');
    });

    test('should resolve shell style environment variables', () => {
      expect(EnvironmentResolver.resolveValue('${TEST_API_KEY}')).toBe('test-api-key-123');
      expect(EnvironmentResolver.resolveValue('prefix-${TEST_MODEL}-suffix')).toBe(
        'prefix-gpt-4-suffix'
      );
      expect(EnvironmentResolver.resolveValue('${GITHUB_TOKEN}')).toBe('ghp_test_token');
    });

    test('should resolve simple shell style environment variables', () => {
      expect(EnvironmentResolver.resolveValue('$TEST_API_KEY')).toBe('test-api-key-123');
      expect(EnvironmentResolver.resolveValue('$TEST_PROVIDER')).toBe('openai');
    });

    test('should handle non-string values unchanged', () => {
      expect(EnvironmentResolver.resolveValue(123)).toBe(123);
      expect(EnvironmentResolver.resolveValue(true)).toBe(true);
      expect(EnvironmentResolver.resolveValue(false)).toBe(false);
    });

    test('should leave unresolved variables as-is when environment variable is missing', () => {
      expect(EnvironmentResolver.resolveValue('${{ env.NONEXISTENT }}')).toBe(
        '${{ env.NONEXISTENT }}'
      );
      expect(EnvironmentResolver.resolveValue('${NONEXISTENT}')).toBe('${NONEXISTENT}');
      expect(EnvironmentResolver.resolveValue('$NONEXISTENT')).toBe('$NONEXISTENT');
    });

    test('should handle mixed syntaxes in the same string', () => {
      const result = EnvironmentResolver.resolveValue(
        '${{ env.TEST_API_KEY }}:${TEST_MODEL}:$TEST_PROVIDER'
      );
      expect(result).toBe('test-api-key-123:gpt-4:openai');
    });

    test('should handle whitespace in GitHub Actions syntax', () => {
      expect(EnvironmentResolver.resolveValue('${{env.TEST_API_KEY}}')).toBe('test-api-key-123');
      expect(EnvironmentResolver.resolveValue('${{ env.TEST_API_KEY }}')).toBe('test-api-key-123');
      expect(EnvironmentResolver.resolveValue('${{  env.TEST_MODEL  }}')).toBe('gpt-4');
    });
  });

  describe('resolveEnvConfig', () => {
    test('should resolve all values in an EnvConfig object', () => {
      const config = {
        API_KEY: '${{ env.TEST_API_KEY }}',
        MODEL_NAME: '${TEST_MODEL}',
        PROVIDER: '$TEST_PROVIDER',
        TIMEOUT: '${{ env.TEST_TIMEOUT }}',
        STATIC_VALUE: 'unchanged',
        NUMERIC_VALUE: 42,
        BOOLEAN_VALUE: true,
      };

      const resolved = EnvironmentResolver.resolveEnvConfig(config);

      expect(resolved).toEqual({
        API_KEY: 'test-api-key-123',
        MODEL_NAME: 'gpt-4',
        PROVIDER: 'openai',
        TIMEOUT: '30000',
        STATIC_VALUE: 'unchanged',
        NUMERIC_VALUE: 42,
        BOOLEAN_VALUE: true,
      });
    });

    test('should handle empty config', () => {
      const result = EnvironmentResolver.resolveEnvConfig({});
      expect(result).toEqual({});
    });

    test('should handle complex nested references', () => {
      const config = {
        COMBINED: '${{ env.TEST_PROVIDER }}/${TEST_MODEL}',
        PREFIX_SUFFIX: 'prefix-${{ env.TEST_API_KEY }}-suffix',
      };

      const resolved = EnvironmentResolver.resolveEnvConfig(config);

      expect(resolved).toEqual({
        COMBINED: 'openai/gpt-4',
        PREFIX_SUFFIX: 'prefix-test-api-key-123-suffix',
      });
    });
  });

  describe('withTemporaryEnv', () => {
    test('should apply temporary environment variables during callback execution', () => {
      const envConfig = {
        TEMP_VAR: 'temporary-value',
        OVERRIDDEN_VAR: 'new-value',
      };

      // Set up initial state
      process.env.OVERRIDDEN_VAR = 'original-value';

      const result = EnvironmentResolver.withTemporaryEnv(envConfig, () => {
        // During execution, temporary env vars should be active
        expect(process.env.TEMP_VAR).toBe('temporary-value');
        expect(process.env.OVERRIDDEN_VAR).toBe('new-value');
        return 'callback-result';
      });

      expect(result).toBe('callback-result');

      // After execution, environment should be restored
      expect(process.env.TEMP_VAR).toBeUndefined();
      expect(process.env.OVERRIDDEN_VAR).toBe('original-value');
    });

    test('should handle async callbacks', async () => {
      const envConfig = {
        ASYNC_VAR: '${{ env.TEST_API_KEY }}',
      };

      const result = await EnvironmentResolver.withTemporaryEnv(envConfig, async () => {
        expect(process.env.ASYNC_VAR).toBe('test-api-key-123');

        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(process.env.ASYNC_VAR).toBe('test-api-key-123');
        return 'async-result';
      });

      expect(result).toBe('async-result');
      expect(process.env.ASYNC_VAR).toBeUndefined();
    });

    test('should restore environment even if callback throws', () => {
      const envConfig = {
        ERROR_VAR: 'error-value',
      };

      expect(() => {
        EnvironmentResolver.withTemporaryEnv(envConfig, () => {
          expect(process.env.ERROR_VAR).toBe('error-value');
          throw new Error('Test error');
        });
      }).toThrow('Test error');

      expect(process.env.ERROR_VAR).toBeUndefined();
    });

    test('should restore environment even if async callback throws', async () => {
      const envConfig = {
        ASYNC_ERROR_VAR: 'async-error-value',
      };

      await expect(
        EnvironmentResolver.withTemporaryEnv(envConfig, async () => {
          expect(process.env.ASYNC_ERROR_VAR).toBe('async-error-value');
          throw new Error('Async test error');
        })
      ).rejects.toThrow('Async test error');

      expect(process.env.ASYNC_ERROR_VAR).toBeUndefined();
    });

    test('should resolve environment variables in config before applying', () => {
      const envConfig = {
        RESOLVED_VAR: '${{ env.TEST_API_KEY }}',
        COMPLEX_VAR: '${TEST_PROVIDER}/$TEST_MODEL',
      };

      EnvironmentResolver.withTemporaryEnv(envConfig, () => {
        expect(process.env.RESOLVED_VAR).toBe('test-api-key-123');
        expect(process.env.COMPLEX_VAR).toBe('openai/gpt-4');
      });
    });
  });

  describe('validateRequiredEnvVars', () => {
    test('should return empty array when all required variables are available', () => {
      const envConfig = {
        AVAILABLE_VAR: '${{ env.TEST_API_KEY }}',
      };

      const missing = EnvironmentResolver.validateRequiredEnvVars(envConfig, [
        'AVAILABLE_VAR',
        'TEST_MODEL',
      ]);

      expect(missing).toEqual([]);
    });

    test('should return missing variables', () => {
      const envConfig = {
        AVAILABLE_VAR: '${{ env.TEST_API_KEY }}',
      };

      const missing = EnvironmentResolver.validateRequiredEnvVars(envConfig, [
        'AVAILABLE_VAR',
        'MISSING_VAR',
        'ANOTHER_MISSING',
      ]);

      expect(missing).toEqual(['MISSING_VAR', 'ANOTHER_MISSING']);
    });

    test('should check process environment when variable not in config', () => {
      const envConfig = {};

      const missing = EnvironmentResolver.validateRequiredEnvVars(envConfig, [
        'TEST_API_KEY',
        'NONEXISTENT_VAR',
      ]);

      expect(missing).toEqual(['NONEXISTENT_VAR']);
    });

    test('should handle empty requirements', () => {
      const envConfig = { SOME_VAR: 'value' };

      const missing = EnvironmentResolver.validateRequiredEnvVars(envConfig, []);

      expect(missing).toEqual([]);
    });
  });
});
