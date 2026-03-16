import { CLI } from '../../src/cli';

describe('CLI options consistency', () => {
  const cli = new CLI();

  // All boolean frontend flags that should appear in help and be parseable
  const frontendFlags = ['--slack', '--telegram', '--email', '--whatsapp', '--teams', '--a2a'];

  it('getHelpText() includes all frontend flags', () => {
    const help = cli.getHelpText();
    for (const flag of frontendFlags) {
      expect(help).toContain(flag);
    }
  });

  it('parseArgs() accepts all frontend flags without error', () => {
    for (const flag of frontendFlags) {
      const result = cli.parseArgs(['node', 'visor', flag]);
      // The flag name without dashes, camelCased
      const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      expect((result as any)[key]).toBe(true);
    }
  });

  it('parseArgs() returns email property', () => {
    const result = cli.parseArgs(['node', 'visor', '--email']);
    expect(result.email).toBe(true);
  });

  // Structural test: every option in getHelpText should also be parseable
  it('all options shown in help are accepted by parseArgs', () => {
    const help = cli.getHelpText();
    // Extract all --option-name patterns from help text (long options only)
    const optionPattern = /(?:^|\s)--([a-z][-a-z0-9]*)/g;
    const helpOptions = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = optionPattern.exec(help)) !== null) {
      helpOptions.add(match[1]);
    }

    // These options require values, so test with a dummy value
    const optionsWithValues: Record<string, string> = {
      check: 'all',
      output: 'json',
      'output-file': '/tmp/test',
      config: '/tmp/test.yaml',
      timeout: '1000',
      'max-parallelism': '2',
      tags: 'foo',
      'exclude-tags': 'bar',
      'allowed-remote-patterns': 'https://example.com',
      event: 'manual',
      mode: 'cli',
      'debug-port': '3456',
      message: 'hello',
      'workspace-path': '/tmp',
      'workspace-name': 'test',
      'workspace-project-name': 'test',
      'github-token': 'tok',
      'github-app-id': '123',
      'github-private-key': 'key',
      'github-installation-id': '456',
      'mcp-port': '8080',
      'mcp-auth-token': 'test-token',
    };

    // Skip negated options (--no-*) and version/help (handled by commander internally)
    const skip = new Set(['no-remote-extends', 'version', 'help']);

    for (const opt of helpOptions) {
      if (skip.has(opt)) continue;
      const args = ['node', 'visor'];
      if (optionsWithValues[opt]) {
        args.push(`--${opt}`, optionsWithValues[opt]);
      } else {
        args.push(`--${opt}`);
      }
      expect(() => cli.parseArgs(args)).not.toThrow();
    }
  });
});
