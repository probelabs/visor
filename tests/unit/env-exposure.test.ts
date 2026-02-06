import { buildSandboxEnv } from '../../src/utils/env-exposure';

describe('env-exposure', () => {
  const base = {
    CI: 'true',
    FOO: '1',
    BAR: '2',
    AWS_SECRET_ACCESS_KEY: 'redactme',
    MY_TOKEN: 'redact',
    SAFE: 'ok',
  } as any as NodeJS.ProcessEnv;

  it('default denylist: exposes all except denylist and sensitive suffixes', () => {
    const out = buildSandboxEnv(base);
    expect(out.CI).toBe('true');
    expect(out.FOO).toBe('1');
    expect(out.BAR).toBe('2');
    expect(out.SAFE).toBe('ok');
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.MY_TOKEN).toBeUndefined();
  });

  it('VISOR_ALLOW_ENV allowlist mode restricts keys', () => {
    const env = { ...base, VISOR_ALLOW_ENV: 'FOO,SAFE' } as any;
    const out = buildSandboxEnv(env);
    expect(out.FOO).toBe('1');
    expect(out.SAFE).toBe('ok');
    expect(out.BAR).toBeUndefined();
    expect(out.CI).toBeUndefined();
  });

  it('VISOR_DENY_ENV masks additional keys and prefixes', () => {
    const env = { ...base, VISOR_DENY_ENV: 'FOO,MY_*' } as any;
    const out = buildSandboxEnv(env);
    expect(out.FOO).toBeUndefined();
    expect(out['MY_TOKEN']).toBeUndefined();
  });

  it('prefix * deny works in allowlist mode too', () => {
    const env = { ...base, VISOR_ALLOW_ENV: 'FOO,MY_TOKEN,SAFE', VISOR_DENY_ENV: 'MY_*' } as any;
    const out = buildSandboxEnv(env);
    expect(out.FOO).toBe('1');
    expect(out.SAFE).toBe('ok');
    expect(out['MY_TOKEN']).toBeUndefined();
  });

  it('ignores undefined/empty values', () => {
    const env = { ...base, EMPTY: undefined } as any;
    const out = buildSandboxEnv(env);
    expect(out.EMPTY).toBeUndefined();
  });
});
