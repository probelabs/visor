import { filterEnvForSandbox } from '../../src/sandbox/env-filter';

describe('EnvFilter', () => {
  describe('filterEnvForSandbox', () => {
    it('should pass through default env vars', () => {
      const hostEnv = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        USER: 'testuser',
        CI: 'true',
        NODE_ENV: 'test',
        LANG: 'en_US.UTF-8',
        SECRET_KEY: 'do-not-pass',
      };

      const result = filterEnvForSandbox(undefined, hostEnv);

      expect(result.PATH).toBe('/usr/bin');
      expect(result.HOME).toBe('/home/user');
      expect(result.USER).toBe('testuser');
      expect(result.CI).toBe('true');
      expect(result.NODE_ENV).toBe('test');
      expect(result.LANG).toBe('en_US.UTF-8');
      expect(result.SECRET_KEY).toBeUndefined();
    });

    it('should filter by passthrough glob patterns', () => {
      const hostEnv = {
        GITHUB_TOKEN: 'ghp_xxx',
        GITHUB_REPOSITORY: 'owner/repo',
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
        OPENAI_API_KEY: 'sk-xxx',
        SOME_OTHER_VAR: 'value',
      };

      const result = filterEnvForSandbox(undefined, hostEnv, [
        'GITHUB_*',
        'ANTHROPIC_*',
        'OPENAI_*',
      ]);

      expect(result.GITHUB_TOKEN).toBe('ghp_xxx');
      expect(result.GITHUB_REPOSITORY).toBe('owner/repo');
      expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
      expect(result.OPENAI_API_KEY).toBe('sk-xxx');
      expect(result.SOME_OTHER_VAR).toBeUndefined();
    });

    it('should always include check-level env overrides', () => {
      const hostEnv = { PATH: '/usr/bin' };
      const checkEnv = { MY_VAR: 'my-value', NUMERIC: 42, FLAG: true };

      const result = filterEnvForSandbox(
        checkEnv as Record<string, string | number | boolean>,
        hostEnv
      );

      expect(result.MY_VAR).toBe('my-value');
      expect(result.NUMERIC).toBe('42');
      expect(result.FLAG).toBe('true');
      expect(result.PATH).toBe('/usr/bin');
    });

    it('should let check env override host env', () => {
      const hostEnv = { NODE_ENV: 'production' };
      const checkEnv = { NODE_ENV: 'test' };

      const result = filterEnvForSandbox(checkEnv, hostEnv);

      expect(result.NODE_ENV).toBe('test');
    });

    it('should skip undefined host env values', () => {
      const hostEnv = { PATH: '/usr/bin', UNSET_VAR: undefined } as Record<
        string,
        string | undefined
      >;

      const result = filterEnvForSandbox(undefined, hostEnv);

      expect(result.PATH).toBe('/usr/bin');
      expect(result).not.toHaveProperty('UNSET_VAR');
    });

    it('should handle empty inputs', () => {
      const result = filterEnvForSandbox(undefined, {});
      expect(Object.keys(result).length).toBe(0);
    });

    it('should handle exact pattern match (no wildcard)', () => {
      const hostEnv = { CI: 'true', CI_BUILD_ID: '123' };

      const result = filterEnvForSandbox(undefined, hostEnv, ['CI']);

      expect(result.CI).toBe('true');
      // CI_BUILD_ID should NOT match pattern 'CI' (no wildcard)
      // But CI is a default, so CI_BUILD_ID should not be included
      expect(result.CI_BUILD_ID).toBeUndefined();
    });
  });
});
