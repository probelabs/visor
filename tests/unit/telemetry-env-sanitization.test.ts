import { sanitizeContextForTelemetry } from '../../src/telemetry/state-capture';

describe('sanitizeContextForTelemetry', () => {
  it('should redact sensitive env vars by pattern', () => {
    const context = {
      pr: { number: 1 },
      env: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        GOOGLE_API_KEY: 'AIzaSyBqWp9Ent9-31GQOI8oAUPW6eGY5PMQHQM',
        OPENAI_API_KEY: 'sk-abc123',
        JIRA_AUTH: 'base64token',
        ZENDESK_AUTH: 'base64token',
        MY_SECRET: 'supersecret',
        DB_PASSWORD: 'hunter2',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        PRIVATE_KEY: 'private-key-content',
        GITHUB_TOKEN: 'ghp_xxx',
        API_KEY: 'some-api-key',
        NODE_ENV: 'test',
      },
    };

    const sanitized = sanitizeContextForTelemetry(context);

    // Non-sensitive vars should be preserved
    expect((sanitized.env as any).PATH).toBe('/usr/bin');
    expect((sanitized.env as any).HOME).toBe('/home/user');
    expect((sanitized.env as any).NODE_ENV).toBe('test');

    // Sensitive vars should be redacted
    expect((sanitized.env as any).GOOGLE_API_KEY).toBe('[REDACTED]');
    expect((sanitized.env as any).OPENAI_API_KEY).toBe('[REDACTED]');
    expect((sanitized.env as any).JIRA_AUTH).toBe('[REDACTED]');
    expect((sanitized.env as any).ZENDESK_AUTH).toBe('[REDACTED]');
    expect((sanitized.env as any).MY_SECRET).toBe('[REDACTED]');
    expect((sanitized.env as any).DB_PASSWORD).toBe('[REDACTED]');
    expect((sanitized.env as any).AWS_SECRET_ACCESS_KEY).toBe('[REDACTED]');
    expect((sanitized.env as any).PRIVATE_KEY).toBe('[REDACTED]');
    expect((sanitized.env as any).GITHUB_TOKEN).toBe('[REDACTED]');
    expect((sanitized.env as any).API_KEY).toBe('[REDACTED]');
  });

  it('should preserve other context fields unchanged', () => {
    const context = {
      pr: { number: 123, title: 'Test PR' },
      files: [{ name: 'test.ts' }],
      outputs: { check1: 'result' },
      env: {
        PATH: '/usr/bin',
        API_KEY: 'secret',
      },
    };

    const sanitized = sanitizeContextForTelemetry(context);

    expect(sanitized.pr).toEqual({ number: 123, title: 'Test PR' });
    expect(sanitized.files).toEqual([{ name: 'test.ts' }]);
    expect(sanitized.outputs).toEqual({ check1: 'result' });
  });

  it('should handle context without env', () => {
    const context = {
      pr: { number: 1 },
    };

    const sanitized = sanitizeContextForTelemetry(context);

    expect(sanitized.pr).toEqual({ number: 1 });
    expect(sanitized.env).toBeUndefined();
  });

  it('should handle null/undefined context', () => {
    expect(sanitizeContextForTelemetry(null as any)).toBe(null);
    expect(sanitizeContextForTelemetry(undefined as any)).toBe(undefined);
  });

  it('should not mutate original context', () => {
    const context = {
      env: {
        API_KEY: 'secret',
        PATH: '/usr/bin',
      },
    };

    sanitizeContextForTelemetry(context);

    // Original should be unchanged
    expect(context.env.API_KEY).toBe('secret');
  });

  it('should detect case-insensitive patterns', () => {
    const context = {
      env: {
        api_key: 'lower',
        API_KEY: 'upper',
        Api_Key: 'mixed',
        apiKey: 'camel',
        APIKEY: 'no separator',
      },
    };

    const sanitized = sanitizeContextForTelemetry(context);

    expect((sanitized.env as any).api_key).toBe('[REDACTED]');
    expect((sanitized.env as any).API_KEY).toBe('[REDACTED]');
    expect((sanitized.env as any).Api_Key).toBe('[REDACTED]');
    expect((sanitized.env as any).apiKey).toBe('[REDACTED]');
    expect((sanitized.env as any).APIKEY).toBe('[REDACTED]');
  });
});
