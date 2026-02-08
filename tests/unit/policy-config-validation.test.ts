import { ConfigManager } from '../../src/config';

describe('Policy config validation', () => {
  const cm = new ConfigManager();

  it('accepts valid local policy config', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'local',
        rules: './policies/',
        fallback: 'deny',
        timeout: 5000,
        roles: {
          admin: { author_association: ['OWNER'] },
        },
      },
    };
    // Should not throw
    expect(() => cm.validateConfig(config)).not.toThrow();
  });

  it('accepts valid remote policy config', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'remote',
        url: 'http://opa:8181',
      },
    };
    expect(() => cm.validateConfig(config)).not.toThrow();
  });

  it('accepts disabled policy config', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'disabled',
      },
    };
    expect(() => cm.validateConfig(config)).not.toThrow();
  });

  it('rejects invalid engine value', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'invalid',
      },
    };
    expect(() => cm.validateConfig(config)).toThrow(/policy.engine/);
  });

  it('rejects local engine without rules', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'local',
      },
    };
    expect(() => cm.validateConfig(config)).toThrow(/policy.rules/);
  });

  it('rejects remote engine without url', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'remote',
      },
    };
    expect(() => cm.validateConfig(config)).toThrow(/policy.url/);
  });

  it('rejects invalid fallback value', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'disabled',
        fallback: 'maybe',
      },
    };
    expect(() => cm.validateConfig(config)).toThrow(/policy.fallback/);
  });

  it('rejects negative timeout', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'disabled',
        timeout: -1,
      },
    };
    expect(() => cm.validateConfig(config)).toThrow(/policy.timeout/);
  });
});
