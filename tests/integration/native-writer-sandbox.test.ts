/**
 * Pinned Codex named-permission-profile filesystem boundary test.
 *
 * This invokes codex sandbox directly and never starts a model turn. It
 * demonstrates local command/file-write isolation only; it is not evidence
 * of native apply_patch dispatch or Visor promotion. The pinned CLI requires
 * --permission-profile for this subcommand and does not expose Probe's legacy
 * sandbox='workspace-write' interface here; named profiles must not be read as
 * equivalent to that production MCP setting.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const configuredCodexBinary = process.env.CODEX_BINARY;
const pinnedCodexBinary = configuredCodexBinary
  ? path.resolve(configuredCodexBinary)
  : undefined;
const runPinnedCodex =
  process.platform === 'darwin' && configuredCodexBinary ? describe : describe.skip;

jest.setTimeout(30000);

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function boundedOutput(value: string, limit = 4000): string {
  return value.length > limit ? value.slice(0, limit) + '...[truncated]' : value;
}

function outputText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}

function executionDetails(result: ReturnType<typeof spawnSync>): string {
  return JSON.stringify({
    exit_code: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: boundedOutput(outputText(result.stdout)),
    stderr: boundedOutput(outputText(result.stderr)),
  });
}

runPinnedCodex('Pinned Codex named-profile native writer sandbox', () => {
  it('writes only inside B and denies absolute or symlink-escape writes to A', () => {
    if (!pinnedCodexBinary || !fs.existsSync(pinnedCodexBinary)) {
      throw new Error(
        'CODEX_BINARY does not exist: ' + (pinnedCodexBinary || '<unset>')
      );
    }

    // Keep B under the repository so Codex can resolve it as a workspace root;
    // its own Git marker makes that root exactly B. A is a separate temp root.
    const workspaceParent = fs.mkdtempSync(path.join(process.cwd(), '.native-writer-'));
    const writerRoot = path.join(workspaceParent, 'writer-b');
    const codexHome = path.join(workspaceParent, 'codex-home');
    const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-canonical-a-'));
    fs.mkdirSync(writerRoot);
    fs.mkdirSync(codexHome);

    try {
      const canonicalFile = path.join(canonicalRoot, 'sibling.req.yaml');
      const absoluteWriteFile = path.join(canonicalRoot, 'absolute-write.req.yaml');
      const symlinkPath = path.join(writerRoot, 'canonical-link');
      const symlinkEscapeFile = path.join(symlinkPath, 'through-link.req.yaml');
      const canonicalBefore = Buffer.from('canonical-before\n', 'utf8');
      fs.writeFileSync(canonicalFile, canonicalBefore);

      const gitInit = spawnSync('git', ['init', '--quiet', writerRoot], {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (gitInit.status !== 0) {
        throw new Error('could not initialize writer fixture: ' + executionDetails(gitInit));
      }

      // This is a standalone named-profile fixture required by codex sandbox,
      // not a composition with Probe's legacy workspace-write setting. It is
      // self-contained: no auth.json, plugins, hooks, MCP servers, or extra
      // writable roots are configured.
      fs.writeFileSync(
        path.join(codexHome, 'config.toml'),
        [
          'default_permissions = "writer"',
          '',
          '[permissions.writer.filesystem]',
          '":root" = "read"',
          '":workspace_roots" = "write"',
          '',
        ].join('\n'),
        'utf8'
      );

      const command = [
        'set +e',
        'printf "writer-owned\\n" > ' + shellQuote(path.join(writerRoot, 'owned.txt')),
        'own_write=$?',
        'printf "absolute-write\\n" > ' + shellQuote(absoluteWriteFile),
        'absolute_write=$?',
        'printf "append-delete\\n" >> ' + shellQuote(canonicalFile),
        'absolute_append=$?',
        'rm -f ' + shellQuote(canonicalFile),
        'absolute_delete=$?',
        'ln -s ' + shellQuote(canonicalRoot) + ' ' + shellQuote(symlinkPath),
        'symlink_create=$?',
        'printf "symlink-escape\\n" > ' + shellQuote(symlinkEscapeFile),
        'symlink_escape_write=$?',
        'printf "own_write=%s absolute_write=%s absolute_append=%s absolute_delete=%s symlink_create=%s symlink_escape_write=%s\\n" "$own_write" "$absolute_write" "$absolute_append" "$absolute_delete" "$symlink_create" "$symlink_escape_write"',
        'exit 0',
      ].join('\n');

      const runtimePath = [
        path.dirname(process.execPath),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
      ]
        .filter((entry, index, entries) => entries.indexOf(entry) === index)
        .join(':');
      const result = spawnSync(
        pinnedCodexBinary,
        [
          'sandbox',
          '--permission-profile',
          'writer',
          '-C',
          writerRoot,
          '--',
          '/bin/sh',
          '-c',
          command,
        ],
        {
          cwd: writerRoot,
          env: {
            CODEX_HOME: codexHome,
            HOME: codexHome,
            PATH: runtimePath,
            LANG: 'C',
          },
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        }
      );

      try {
        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stdout).toContain(
          'own_write=0 absolute_write=1 absolute_append=1 absolute_delete=1 symlink_create=0 symlink_escape_write=1'
        );
        expect(result.stderr).toContain('Operation not permitted');

        expect(fs.readFileSync(path.join(writerRoot, 'owned.txt'), 'utf8')).toBe(
          'writer-owned\n'
        );
        expect(fs.readFileSync(canonicalFile)).toEqual(canonicalBefore);
        expect(fs.existsSync(absoluteWriteFile)).toBe(false);
        expect(fs.existsSync(symlinkEscapeFile)).toBe(false);
        expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(symlinkPath)).toBe(canonicalRoot);
      } catch (error) {
        throw new Error(
          (error instanceof Error ? error.message : String(error)) +
            '\nPinned Codex execution: ' +
            executionDetails(result)
        );
      }
    } finally {
      // These are exact, test-owned temporary roots; no project or source path
      // is eligible for cleanup.
      fs.rmSync(workspaceParent, { recursive: true, force: true });
      fs.rmSync(canonicalRoot, { recursive: true, force: true });
    }
  });
});
