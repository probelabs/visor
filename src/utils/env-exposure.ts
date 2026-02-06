export type EnvMap = Record<string, string>;

// Default: expose all env vars except a conservative denylist.
// If VISOR_ALLOW_ENV is set and not '*', restrict to that allowlist.
// VISOR_DENY_ENV can further mask exact keys or prefix* patterns.
export function buildSandboxEnv(input: NodeJS.ProcessEnv): EnvMap {
  const denyDefaults = [
    'GITHUB_TOKEN',
    'INPUT_GITHUB-TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AZURE_CLIENT_SECRET',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'HUGGINGFACE_API_KEY',
    'CLAUDE_CODE_API_KEY',
    'PROBE_API_KEY',
  ];

  const denyExtra = (input.VISOR_DENY_ENV || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const deny = Array.from(new Set([...denyDefaults, ...denyExtra]));
  const allowSpec = (input.VISOR_ALLOW_ENV || '*').trim();

  const denyMatch = (key: string): boolean => {
    for (const pat of deny) {
      if (!pat) continue;
      if (pat.endsWith('*')) {
        const prefix = pat.slice(0, -1);
        if (key.startsWith(prefix)) return true;
      } else if (key === pat) {
        return true;
      }
    }
    if (/(_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$/i.test(key)) return true;
    return false;
  };

  const out: EnvMap = {};
  if (allowSpec !== '*') {
    const allow = allowSpec
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const key of allow) {
      const val = input[key];
      if (key && val !== undefined && !denyMatch(key)) out[key] = String(val);
    }
    return out;
  }

  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (denyMatch(k)) continue;
    out[k] = String(v);
  }
  return out;
}
