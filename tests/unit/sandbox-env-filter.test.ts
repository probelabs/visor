import { filterEnvForSandbox, BUILTIN_PASSTHROUGH } from '../../src/sandbox/env-filter';

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

  describe('custom defaultPatterns (workspace-level sandbox_defaults)', () => {
    it('should replace builtins when defaultPatterns is provided', () => {
      const hostEnv = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        USER: 'testuser',
        CI: 'true',
        NODE_ENV: 'test',
        LANG: 'en_US.UTF-8',
      };

      // Only PATH allowed as default — HOME, USER, CI etc. should be blocked
      const result = filterEnvForSandbox(undefined, hostEnv, undefined, ['PATH']);

      expect(result.PATH).toBe('/usr/bin');
      expect(result.HOME).toBeUndefined();
      expect(result.USER).toBeUndefined();
      expect(result.CI).toBeUndefined();
      expect(result.NODE_ENV).toBeUndefined();
      expect(result.LANG).toBeUndefined();
    });

    it('should block all host env when defaultPatterns is empty array', () => {
      const hostEnv = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        CI: 'true',
      };

      // Empty defaults + no passthrough = nothing from host
      const result = filterEnvForSandbox(undefined, hostEnv, undefined, []);

      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should still allow check-level env when defaultPatterns is empty', () => {
      const hostEnv = { PATH: '/usr/bin', SECRET: 'x' };
      const checkEnv = { MY_VAR: 'val' };

      const result = filterEnvForSandbox(checkEnv, hostEnv, undefined, []);

      expect(result.MY_VAR).toBe('val');
      expect(result.PATH).toBeUndefined();
      expect(result.SECRET).toBeUndefined();
    });

    it('should merge per-sandbox passthrough with custom defaults', () => {
      const hostEnv = {
        PATH: '/usr/bin',
        CI: 'true',
        GITHUB_TOKEN: 'ghp_xxx',
        HOME: '/home/user',
      };

      // workspace defaults: PATH, CI only
      // per-sandbox passthrough adds GITHUB_*
      const result = filterEnvForSandbox(undefined, hostEnv, ['GITHUB_*'], ['PATH', 'CI']);

      expect(result.PATH).toBe('/usr/bin');
      expect(result.CI).toBe('true');
      expect(result.GITHUB_TOKEN).toBe('ghp_xxx');
      expect(result.HOME).toBeUndefined();
    });

    it('should forward OTel env vars when included in patterns', () => {
      const hostEnv = {
        PATH: '/usr/bin',
        VISOR_TELEMETRY_ENABLED: 'true',
        VISOR_TELEMETRY_SINK: 'file',
        VISOR_FALLBACK_TRACE_FILE: '/tmp/trace.ndjson',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_SERVICE_NAME: 'visor',
      };

      const result = filterEnvForSandbox(undefined, hostEnv, undefined, [
        'PATH',
        'VISOR_TELEMETRY_*',
        'VISOR_FALLBACK_TRACE_FILE',
        'OTEL_*',
      ]);

      expect(result.VISOR_TELEMETRY_ENABLED).toBe('true');
      expect(result.VISOR_TELEMETRY_SINK).toBe('file');
      expect(result.VISOR_FALLBACK_TRACE_FILE).toBe('/tmp/trace.ndjson');
      expect(result.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
      expect(result.OTEL_SERVICE_NAME).toBe('visor');
    });

    it('should export BUILTIN_PASSTHROUGH for reference', () => {
      expect(BUILTIN_PASSTHROUGH).toEqual(['PATH', 'HOME', 'USER', 'CI', 'NODE_ENV', 'LANG']);
    });
  });
});
