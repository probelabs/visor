/**
 * Docker Sandbox Integration Tests
 *
 * These tests exercise real Docker containers via SandboxManager and
 * DockerImageSandbox. They are automatically skipped when Docker is
 * not available (CI without Docker, developer machines without Docker, etc.).
 *
 * Note on visor dist path: Under ts-jest, SandboxManager resolves
 * visorDistPath from __dirname (src/sandbox/) which is wrong for
 * --run-check tests that need dist/index.js. Tests that invoke
 * --run-check use DockerImageSandbox directly with the correct dist path.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Detect Docker availability
let hasDocker = false;
try {
  execSync('docker info', { stdio: 'ignore', timeout: 5000 });
  hasDocker = true;
} catch {}

const describeIfDocker = hasDocker ? describe : describe.skip;

jest.setTimeout(60000);

// Path to compiled visor dist (needed for --run-check tests)
const DIST_PATH = path.resolve(__dirname, '../../dist');
const HAS_DIST = fs.existsSync(path.join(DIST_PATH, 'index.js'));

describeIfDocker('Docker Sandbox Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-sandbox-'));

    // Init a minimal git repo so the engine can detect branch
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@visor.dev"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Visor Test"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n');
    execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    // Clean up any leftover visor containers from this test run
    try {
      const containers = execSync('docker ps -a --filter "name=visor-" --format "{{.Names}}"', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (containers) {
        execSync(`docker rm -f ${containers.split('\n').join(' ')}`, {
          stdio: 'ignore',
          timeout: 10000,
        });
      }
    } catch {}

    // Remove temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  function getSandboxManager(defs: Record<string, any>, repoPath: string, branch = 'main') {
    const { SandboxManager } = require('../../src/sandbox/sandbox-manager');
    return new SandboxManager(
      defs,
      repoPath,
      branch
    ) as import('../../src/sandbox/sandbox-manager').SandboxManager;
  }

  function getDockerImageSandbox(
    name: string,
    config: any,
    repoPath: string,
    visorDistPath: string,
    cacheVolumeMounts: string[] = []
  ) {
    const { DockerImageSandbox } = require('../../src/sandbox/docker-image-sandbox');
    return new DockerImageSandbox(
      name,
      config,
      repoPath,
      visorDistPath,
      cacheVolumeMounts
    ) as import('../../src/sandbox/docker-image-sandbox').DockerImageSandbox;
  }

  // ──────────────────────────────────────────────────────────────
  // 1. Image mode basic
  // ──────────────────────────────────────────────────────────────
  it('runs a command in a node:20-alpine container and returns stdout', async () => {
    const mgr = getSandboxManager({ 'node-env': { image: 'node:20-alpine' } }, tmpDir);

    try {
      const result = await mgr.exec('node-env', {
        command: 'node --version',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/v20/);
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 2. Workspace default sandbox — resolveSandbox returns workspace default
  // ──────────────────────────────────────────────────────────────
  it('applies workspace-level sandbox default to all checks', async () => {
    const mgr = getSandboxManager({ 'node-env': { image: 'node:20-alpine' } }, tmpDir);

    try {
      // resolveSandbox with no check-level override should use workspace default
      const resolved = mgr.resolveSandbox(undefined, 'node-env');
      expect(resolved).toBe('node-env');

      // Verify the resolved sandbox actually works
      const result = await mgr.exec(resolved!, {
        command: 'node -e "console.log(process.version)"',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/v20/);
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 3. Per-check sandbox override
  // ──────────────────────────────────────────────────────────────
  it('overrides workspace sandbox at the check level', async () => {
    const mgr = getSandboxManager(
      {
        'node-env': { image: 'node:20-alpine' },
        'alpine-env': { image: 'alpine:3.19' },
      },
      tmpDir
    );

    try {
      // Check-level override should take precedence
      const resolved = mgr.resolveSandbox('alpine-env', 'node-env');
      expect(resolved).toBe('alpine-env');

      // Verify node-env has node
      const nodeResult = await mgr.exec('node-env', {
        command: 'node --version',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });
      expect(nodeResult.exitCode).toBe(0);
      expect(nodeResult.stdout).toMatch(/v20/);

      // Verify alpine-env does NOT have node
      const alpineResult = await mgr.exec('alpine-env', {
        command: 'node --version 2>&1 || echo "no-node"',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });
      expect(alpineResult.stdout).toContain('no-node');
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 4. Env passthrough
  // ──────────────────────────────────────────────────────────────
  it('passes check-level env vars into the sandbox container', async () => {
    const mgr = getSandboxManager({ 'node-env': { image: 'node:20-alpine' } }, tmpDir);

    try {
      const result = await mgr.exec('node-env', {
        command: 'echo $MY_VAR',
        env: { MY_VAR: 'hello' },
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 5. Read-only mount
  // ──────────────────────────────────────────────────────────────
  it('prevents writes when read_only is true', async () => {
    const mgr = getSandboxManager(
      { 'secure-env': { image: 'node:20-alpine', read_only: true } },
      tmpDir
    );

    try {
      const result = await mgr.exec('secure-env', {
        command: 'touch /workspace/test-file 2>&1; echo "exit:$?"',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      // The touch should fail — exit code embedded in stdout
      expect(result.stdout).toContain('exit:1');
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 6. Network disabled
  // ──────────────────────────────────────────────────────────────
  it('blocks network access when network is false', async () => {
    const mgr = getSandboxManager(
      { 'isolated-env': { image: 'alpine:3.19', network: false } },
      tmpDir
    );

    try {
      const result = await mgr.exec('isolated-env', {
        command: 'wget -q --timeout=2 http://example.com -O /dev/null 2>&1; echo "exit:$?"',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      // wget should fail when network is disabled
      expect(result.stdout).not.toContain('exit:0');
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 7. Inline Dockerfile
  // ──────────────────────────────────────────────────────────────
  it('builds and runs from an inline Dockerfile', async () => {
    const mgr = getSandboxManager(
      {
        'jq-env': {
          dockerfile_inline: ['FROM alpine:3.19', 'RUN apk add --no-cache jq'].join('\n'),
        },
      },
      tmpDir
    );

    try {
      const result = await mgr.exec('jq-env', {
        command: 'echo \'{"name":"visor"}\' | jq -r .name',
        env: {},
        timeoutMs: 60000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('visor');
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 8. --run-check end-to-end via DockerImageSandbox
  //    Uses DockerImageSandbox directly to mount correct dist/ path
  // ──────────────────────────────────────────────────────────────
  (HAS_DIST ? it : it.skip)('executes --run-check payload inside a sandbox', async () => {
    const sandbox = getDockerImageSandbox(
      'node-env',
      { image: 'node:20-alpine' },
      tmpDir,
      DIST_PATH
    );

    try {
      await sandbox.start();

      const payload = {
        check: {
          type: 'command',
          exec: 'echo "sandbox-run-check-ok"',
        },
        prInfo: {
          number: 1,
          title: 'Test PR',
          body: '',
          author: 'test',
          base: 'main',
          head: 'feature',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        },
      };

      const payloadJson = JSON.stringify(payload).replace(/'/g, "'\\''");
      const command = `echo '${payloadJson}' | node /opt/visor/index.js --run-check -`;

      const result = await sandbox.exec({
        command,
        env: {},
        timeoutMs: 30000,
        maxBuffer: 5 * 1024 * 1024,
      });

      // The --run-check mode writes JSON to stdout.
      const allOutput = (result.stdout + '\n' + result.stderr).trim();
      const lines = allOutput.split('\n');

      // Find valid JSON output line (scanning from the end)
      let jsonLine: string | undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            JSON.parse(line);
            jsonLine = line;
            break;
          } catch {
            // Not valid JSON, keep looking
          }
        }
      }

      if (!jsonLine) {
        throw new Error(
          `--run-check produced no valid JSON.\n` +
            `exit: ${result.exitCode}\n` +
            `stdout: ${result.stdout.slice(0, 1000)}\n` +
            `stderr: ${result.stderr.slice(0, 1000)}`
        );
      }

      const parsed = JSON.parse(jsonLine);
      expect(parsed).toHaveProperty('issues');
      expect(Array.isArray(parsed.issues)).toBe(true);
    } finally {
      await sandbox.stop();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 9. Container reuse — getOrStart returns the same instance
  // ──────────────────────────────────────────────────────────────
  it('reuses the same container across multiple exec calls', async () => {
    const mgr = getSandboxManager({ 'node-env': { image: 'node:20-alpine' } }, tmpDir);

    try {
      // First exec starts the container
      const result1 = await mgr.exec('node-env', {
        command: 'echo "call-1"',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });
      expect(result1.stdout.trim()).toBe('call-1');

      // Second exec reuses the same container (no new "Starting sandbox" log)
      const result2 = await mgr.exec('node-env', {
        command: 'echo "call-2"',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });
      expect(result2.stdout.trim()).toBe('call-2');

      // Verify state persists: create a file in call 3, read it in call 4
      await mgr.exec('node-env', {
        command: 'echo "persist" > /tmp/state-test',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      const result4 = await mgr.exec('node-env', {
        command: 'cat /tmp/state-test',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });
      expect(result4.stdout.trim()).toBe('persist');
    } finally {
      await mgr.stopAll();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 10. Cache volumes
  // ──────────────────────────────────────────────────────────────
  it('creates Docker volumes for cache paths', async () => {
    const mgr = getSandboxManager(
      {
        'cached-env': {
          image: 'node:20-alpine',
          cache: {
            paths: ['/tmp/cache'],
            ttl: '7d',
            max_scopes: 5,
          },
        },
      },
      tmpDir,
      'test-branch'
    );

    try {
      // Running exec triggers getOrStart which resolves cache volumes
      const result = await mgr.exec('cached-env', {
        command:
          'mkdir -p /tmp/cache && echo "cached" > /tmp/cache/data.txt && cat /tmp/cache/data.txt',
        env: {},
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('cached');

      // Verify a visor-cache volume was created
      const volumes = execSync('docker volume ls --format "{{.Name}}"', {
        encoding: 'utf8',
        timeout: 5000,
      });
      const visorVolumes = volumes.split('\n').filter(v => v.startsWith('visor-cache'));

      expect(visorVolumes.length).toBeGreaterThan(0);
    } finally {
      await mgr.stopAll();

      // Clean up cache volumes created by this test
      try {
        const vols = execSync('docker volume ls --filter "name=visor-cache" --format "{{.Name}}"', {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
        if (vols) {
          execSync(`docker volume rm ${vols.split('\n').join(' ')}`, {
            stdio: 'ignore',
            timeout: 5000,
          });
        }
      } catch {}
    }
  });
});
