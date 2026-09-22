import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = join(__dirname, '../..');
const SOURCE_CLI = join(PROJECT, 'src/index.ts');

function createGitSubject(): string {
  const root = mkdtempSync(join(tmpdir(), 'visor-cli-terminal-failure-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'visor-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Visor test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

function runSourceCli(subject: string, config: string, output: string) {
  const env = {
    ...process.env,
    VISOR_NO_REMOTE_EXTENDS: 'true',
    NO_COLOR: '1',
    TS_NODE_PROJECT: join(PROJECT, 'tsconfig.json'),
    TS_NODE_TRANSPILE_ONLY: '1',
  };
  delete env.NODE_ENV;
  delete env.JEST_WORKER_ID;
  return spawnSync(
    process.execPath,
    [
      '-r',
      join(PROJECT, 'node_modules/ts-node/register/transpile-only'),
      SOURCE_CLI,
      '--config',
      config,
      '--check',
      'verifier',
      '--event',
      'manual',
      '--disable-code-context',
      '--output',
      'json',
      '--output-file',
      output,
      '--timeout',
      '10000',
    ],
    {
      cwd: subject,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
}

describe('standard source CLI terminal failure projection', () => {
  it('fails with dependency exception diagnostics when a requested verifier is skipped', () => {
    const subject = createGitSubject();
    const config = join(subject, 'visor.yaml');
    const output = join(subject, 'result.json');
    writeFileSync(
      config,
      [
        'version: "1.0"',
        'checks:',
        '  dependency:',
        '    type: script',
        '    content: throw new Error(\'dependency-boom-token\')',
        '  verifier:',
        '    type: command',
        '    depends_on: [dependency]',
        '    exec: echo verifier-should-not-run',
        '',
      ].join('\n'),
      'utf8'
    );

    try {
      const result = runSourceCli(subject, config, output);
      expect(existsSync(output)).toBe(true);
      const json = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
      const text = JSON.stringify(json);
      expect(result.status).toBe(1);
      expect(text).toContain('dependency');
      expect(text).toContain('dependency-boom-token');
      expect(text).toContain('dependency_failed');
      const projected = (json.__execution as Array<{ output?: { unresolvedFailures?: unknown[] } }>)[0];
      expect(projected.output?.unresolvedFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkName: 'dependency', kind: 'execution' }),
          expect.objectContaining({ checkName: 'verifier', kind: 'dependency', skipReason: 'dependency_failed' }),
        ])
      );
    } finally {
      rmSync(subject, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns success after a failed command is handled by on_fail.goto and passes', () => {
    const subject = createGitSubject();
    const config = join(subject, 'visor.yaml');
    const output = join(subject, 'result.json');
    const marker = join(subject, '.retry-once');
    writeFileSync(
      config,
      [
        'version: "1.0"',
        'routing:',
        '  max_loops: 1',
        'checks:',
        '  verifier:',
        '    type: command',
        `    exec: test -f ${marker} && echo retry-pass || (touch ${marker} && echo retry-fail >&2 && exit 1)`,
        '    on_fail:',
        '      goto: verifier',
        '',
      ].join('\n'),
      'utf8'
    );

    try {
      const result = runSourceCli(subject, config, output);
      expect(result.status).toBe(0);
      expect(existsSync(output)).toBe(true);
      const json = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
      expect(json.__execution).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain('unresolvedFailures');
      expect(JSON.stringify(json)).not.toContain('retry-fail');
    } finally {
      rmSync(subject, { recursive: true, force: true });
    }
  }, 30_000);
});
