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

  it('accepts config with slack_users, emails, and slack_channels in roles', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'local',
        rules: './policies/',
        roles: {
          admin: {
            author_association: ['OWNER'],
            slack_users: ['U0123ADMIN'],
            emails: ['admin@company.com'],
          },
          'eng-channel': {
            slack_channels: ['C0123ENG'],
            slack_users: ['U0123ALICE'],
          },
        },
      },
    };
    expect(() => cm.validateConfig(config)).not.toThrow();
  });

  it('warns on slack_users not starting with U (strict mode)', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'disabled',
        roles: {
          admin: {
            slack_users: ['BADID123'],
          },
        },
      },
    };
    // In strict mode, warnings become errors
    expect(() => cm.validateConfig(config, true)).toThrow(/does not start with 'U'/);
  });

  it('warns on emails without @ (strict mode)', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'disabled',
        roles: {
          admin: {
            emails: ['not-an-email'],
          },
        },
      },
    };
    expect(() => cm.validateConfig(config, true)).toThrow(/does not contain '@'/);
  });

  it('warns on slack_channels not starting with C (strict mode)', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'disabled',
        roles: {
          admin: {
            slack_channels: ['XBADCHAN'],
          },
        },
      },
    };
    expect(() => cm.validateConfig(config, true)).toThrow(/does not start with 'C'/);
  });

  it('warns when emails are used about users:read.email scope (strict mode)', () => {
    const config: any = {
      version: '1.0',
      checks: {
        test: { type: 'noop' },
      },
      policy: {
        engine: 'disabled',
        roles: {
          admin: {
            emails: ['valid@email.com'],
          },
        },
      },
    };
    expect(() => cm.validateConfig(config, true)).toThrow(/users:read\.email/);
  });
});
