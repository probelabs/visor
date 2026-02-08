/**
 * Enterprise E2E tests: OPA Policy Engine enforcement.
 *
 * These tests exercise the full policy enforcement pipeline end-to-end:
 *   1. Config with a `policy` block (engine: local, roles, rego rules)
 *   2. Enterprise loader validates the VISOR_LICENSE JWT (Ed25519)
 *   3. OpaPolicyEngine compiles .rego files to WASM via `opa build`
 *   4. execution-invoker.ts calls policyEngine.evaluateCheckExecution()
 *   5. Denied checks are skipped with skipReason='policy_denied'
 *
 * The suite is split into two sections:
 *
 *   A) CLI-based tests: exercise fallback/degradation paths that do NOT
 *      require OPA WASM evaluation (no license, disabled engine, expired
 *      license, invalid signature, nonexistent rules dir). These run the
 *      built dist/index.js subprocess.
 *
 *   B) Direct-import tests: exercise the real OPA WASM policy evaluation
 *      using Jest imports with the globalThis.require trick (same pattern
 *      as license-and-wasm-e2e.test.ts). This avoids the ncc bundle
 *      limitation where `new Function('id','return require(id)')` cannot
 *      find `require` in the IIFE scope.
 *
 * Requires:
 *   - `opa` CLI on PATH (tests skip if not available)
 *   - `@open-policy-agent/opa-wasm` npm package
 *   - Built dist/index.js (npm run build) -- for CLI tests only
 *   - visor-private.pem (Ed25519 test key)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// OPA + WASM availability gates
// ---------------------------------------------------------------------------

let opaAvailable = false;
let opaWasmCapable = false;
try {
  const opaOutput = execSync('opa version', { stdio: 'pipe', encoding: 'utf-8' });
  opaAvailable = true;
  opaWasmCapable = opaOutput.includes('WebAssembly: available');
} catch {
  // opa CLI not on PATH
}

let opaWasmNpmAvailable = false;
try {
  require('@open-policy-agent/opa-wasm');
  opaWasmNpmAvailable = true;
} catch {
  // npm package not installed
}

const canRunWasmTests = opaAvailable && opaWasmCapable && opaWasmNpmAvailable;
const describeOpa = opaAvailable ? describe : describe.skip;
const describeWasm = canRunWasmTests ? describe : describe.skip;

if (!opaAvailable) {
  // eslint-disable-next-line no-console
  console.log('OPA CLI not found. Skipping all policy enforcement tests.');
}
if (opaAvailable && !opaWasmCapable) {
  // eslint-disable-next-line no-console
  console.log('OPA CLI does not support WASM. Skipping WASM-based tests.');
}
if (opaWasmCapable && !opaWasmNpmAvailable) {
  // eslint-disable-next-line no-console
  console.log('@open-policy-agent/opa-wasm not installed. Skipping WASM-based tests.');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PRIVATE_KEY_PATH = path.join(PROJECT_ROOT, 'visor-private.pem');
const DIST_CLI = path.join(PROJECT_ROOT, 'dist/index.js');

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

function createLicenseJWT(overrides: Record<string, unknown> = {}): string {
  const privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8');
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      org: 'test-org',
      tier: 'enterprise',
      features: ['policy'],
      exp: now + 3600,
      iat: now,
      sub: 'test-e2e',
      ...overrides,
    })
  ).toString('base64url');

  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`), privateKey);

  return `${header}.${payload}.${signature.toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// CLI executor (for fallback/degradation tests)
// ---------------------------------------------------------------------------

function execCLI(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): string {
  // Build a clean env: strip Jest/GitHub vars that can interfere
  const cleanEnv = { ...process.env } as Record<string, string | undefined>;
  delete cleanEnv.JEST_WORKER_ID;
  delete cleanEnv.NODE_ENV;
  delete cleanEnv.GITHUB_ACTIONS;
  delete cleanEnv.GIT_DIR;
  delete cleanEnv.GIT_WORK_TREE;
  delete cleanEnv.GIT_INDEX_FILE;
  delete cleanEnv.GIT_PREFIX;
  delete cleanEnv.GIT_COMMON_DIR;

  // Merge caller overrides
  const mergedEnv: Record<string, string | undefined> = {
    ...cleanEnv,
    VISOR_DEBUG: 'true',
    ...(options.env || {}),
  };

  const shellCmd = `node ${DIST_CLI} --cli ${args.join(' ')} 2>&1`;

  try {
    const out = execSync(shellCmd, {
      cwd: options.cwd,
      env: mergedEnv as NodeJS.ProcessEnv,
      encoding: 'utf-8',
      shell: true,
      timeout: 45_000,
    }) as unknown as string;
    return typeof out === 'string' ? out : String(out);
  } catch (error: any) {
    // The CLI may exit non-zero; capture stdout/stderr anyway
    const output = error?.stdout || error?.output;
    if (output) {
      return Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rego policy files
// ---------------------------------------------------------------------------

const CHECK_EXECUTE_REGO = `package visor.check.execute

default allowed = false

# Allow checks that have no policy requirement when running locally
allowed {
  input.actor.isLocalMode == true
  not input.check.policy
}

# Allow if actor has the admin role
allowed {
  input.actor.roles[_] == "admin"
}

# Allow if actor has the specific required role (string)
allowed {
  required := input.check.policy.require
  is_string(required)
  input.actor.roles[_] == required
}

# Allow if actor has the specific required role (array)
allowed {
  required := input.check.policy.require
  is_array(required)
  required[_] == input.actor.roles[_]
}

reason = "policy denied: actor lacks required role" {
  not allowed
}
`;

const TOOL_INVOKE_REGO = `package visor.tool.invoke

default allowed = true
`;

const CAPABILITY_RESOLVE_REGO = `package visor.capability.resolve
`;

// ---------------------------------------------------------------------------
// Config builders (for CLI-based tests)
// ---------------------------------------------------------------------------

function buildPolicyConfig(policiesDir: string): string {
  return `version: "1.0"

policy:
  engine: local
  rules: ${policiesDir}
  fallback: deny
  roles:
    admin:
      author_association: [OWNER]
    external:
      author_association: [NONE]

checks:
  allowed-check:
    type: log
    message: "ALLOWED_CHECK_RAN"
  denied-check:
    type: log
    message: "DENIED_CHECK_SHOULD_NOT_RUN"
    policy:
      require: admin

output:
  pr_comment:
    format: table
`;
}

// ---------------------------------------------------------------------------
// Shared temp directory setup
// ---------------------------------------------------------------------------

function createTestDir(): string {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-policy-'));
  // Initialize git repo (CLI needs it for PRInfo generation)
  execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', {
    cwd: testDir,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(testDir, 'placeholder.txt'), 'init');
  execSync('git add . && git -c core.hooksPath=/dev/null commit -m "init"', {
    cwd: testDir,
    stdio: 'pipe',
  });
  return testDir;
}

function createPoliciesDir(parentDir: string): string {
  const policiesDir = path.join(parentDir, 'policies');
  fs.mkdirSync(policiesDir, { recursive: true });
  fs.writeFileSync(path.join(policiesDir, 'check_execute.rego'), CHECK_EXECUTE_REGO);
  fs.writeFileSync(path.join(policiesDir, 'tool_invoke.rego'), TOOL_INVOKE_REGO);
  fs.writeFileSync(path.join(policiesDir, 'capability_resolve.rego'), CAPABILITY_RESOLVE_REGO);
  return policiesDir;
}

// ===========================================================================
// SECTION A: CLI-based tests (fallback/degradation paths, no WASM needed)
// ===========================================================================

describeOpa('Policy enforcement E2E - CLI fallback paths', () => {
  let testDir: string;
  let licenseToken: string;

  beforeAll(() => {
    testDir = createTestDir();
    createPoliciesDir(testDir);
    licenseToken = createLicenseJWT();
  }, 30_000);

  afterAll(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // =========================================================================
  // 1. Policy allows check when actor has the required role
  //    (In CLI mode, the ncc bundle fails to load WASM, so the enterprise
  //     loader catches the error and falls back to DefaultPolicyEngine,
  //     which allows everything. This verifies the graceful degradation.)
  // =========================================================================

  it('allows all checks via CLI when actor has required role (graceful degradation)', () => {
    const configPath = path.join(testDir, '.visor-allow.yaml');
    fs.writeFileSync(configPath, buildPolicyConfig('./policies/'));

    // Run as OWNER association -- maps to admin role.
    const output = execCLI(['--config', configPath, '--event', 'manual'], {
      cwd: testDir,
      env: {
        VISOR_LICENSE: licenseToken,
        VISOR_AUTHOR_ASSOCIATION: 'OWNER',
      },
    });

    // Both checks should run (either because policy allows or because
    // the engine fell back to DefaultPolicyEngine)
    expect(output).toContain('ALLOWED_CHECK_RAN');
    expect(output).toContain('DENIED_CHECK_SHOULD_NOT_RUN');
  }, 60_000);

  // =========================================================================
  // 2. Fallback to DefaultPolicyEngine when rules dir is nonexistent
  // =========================================================================

  it('falls back to DefaultPolicyEngine when rules directory does not exist', () => {
    const configPath = path.join(testDir, '.visor-fallback-nodir.yaml');
    const configContent = `version: "1.0"

policy:
  engine: local
  rules: ./does-not-exist-at-all/
  fallback: deny
  roles:
    admin:
      author_association: [OWNER]

checks:
  survivor-check:
    type: log
    message: "SURVIVOR_CHECK_RAN"
    policy:
      require: admin

output:
  pr_comment:
    format: table
`;
    fs.writeFileSync(configPath, configContent);

    // Even though fallback is 'deny' and actor is NONE,
    // the loader falls back to DefaultPolicyEngine (always allow)
    // because the rules directory does not exist.
    const output = execCLI(['--config', configPath, '--event', 'manual'], {
      cwd: testDir,
      env: {
        VISOR_LICENSE: licenseToken,
        VISOR_AUTHOR_ASSOCIATION: 'NONE',
      },
    });

    // DefaultPolicyEngine allows everything
    expect(output).toContain('SURVIVOR_CHECK_RAN');
  }, 60_000);

  // =========================================================================
  // 3. No license -- policy engine disabled, all checks run
  // =========================================================================

  it('runs all checks when no VISOR_LICENSE is set (DefaultPolicyEngine)', () => {
    const configPath = path.join(testDir, '.visor-nolicense.yaml');
    fs.writeFileSync(configPath, buildPolicyConfig('./policies/'));

    // Do NOT set VISOR_LICENSE. Also explicitly unset it.
    const output = execCLI(['--config', configPath, '--event', 'manual'], {
      cwd: testDir,
      env: {
        VISOR_LICENSE: undefined,
        VISOR_AUTHOR_ASSOCIATION: 'NONE',
      },
    });

    // Without a license, DefaultPolicyEngine is used: everything passes
    expect(output).toContain('ALLOWED_CHECK_RAN');
    expect(output).toContain('DENIED_CHECK_SHOULD_NOT_RUN');

    // No policy_denied should appear in skip reasons
    expect(output).not.toMatch(/skipReason=policy_denied/);
  }, 60_000);

  // =========================================================================
  // 4. Expired license falls back to DefaultPolicyEngine
  // =========================================================================

  it('falls back to DefaultPolicyEngine when license is expired beyond grace period', () => {
    const configPath = path.join(testDir, '.visor-expired.yaml');
    fs.writeFileSync(configPath, buildPolicyConfig('./policies/'));

    // Create an expired license (expired 100 days ago, well beyond 72h grace)
    const expiredToken = createLicenseJWT({
      exp: Math.floor(Date.now() / 1000) - 100 * 86400,
      iat: Math.floor(Date.now() / 1000) - 101 * 86400,
    });

    const output = execCLI(['--config', configPath, '--event', 'manual'], {
      cwd: testDir,
      env: {
        VISOR_LICENSE: expiredToken,
        VISOR_AUTHOR_ASSOCIATION: 'NONE',
      },
    });

    // Expired license -> LicenseValidator returns null -> DefaultPolicyEngine
    // Both checks should run regardless of policy.require
    expect(output).toContain('ALLOWED_CHECK_RAN');
    expect(output).toContain('DENIED_CHECK_SHOULD_NOT_RUN');
  }, 60_000);

  // =========================================================================
  // 5. Policy engine disabled when policy.engine is 'disabled'
  // =========================================================================

  it('does not enforce policy when engine is set to disabled', () => {
    const configPath = path.join(testDir, '.visor-disabled.yaml');
    const configContent = `version: "1.0"

policy:
  engine: disabled
  roles:
    admin:
      author_association: [OWNER]

checks:
  disabled-policy-check:
    type: log
    message: "DISABLED_POLICY_CHECK_RAN"
    policy:
      require: admin

output:
  pr_comment:
    format: table
`;
    fs.writeFileSync(configPath, configContent);

    const output = execCLI(['--config', configPath, '--event', 'manual'], {
      cwd: testDir,
      env: {
        VISOR_LICENSE: licenseToken,
        VISOR_AUTHOR_ASSOCIATION: 'NONE',
      },
    });

    // engine=disabled means no policy engine is loaded, all checks run
    expect(output).toContain('DISABLED_POLICY_CHECK_RAN');
  }, 60_000);

  // =========================================================================
  // 6. Invalid license signature falls back to DefaultPolicyEngine
  // =========================================================================

  it('falls back to DefaultPolicyEngine when license JWT has invalid signature', () => {
    const configPath = path.join(testDir, '.visor-badsig.yaml');
    fs.writeFileSync(configPath, buildPolicyConfig('./policies/'));

    // Tamper with the signature to make it invalid
    const validToken = createLicenseJWT();
    const parts = validToken.split('.');
    // Flip some bytes in the signature
    const tamperedSig = parts[2].split('').reverse().join('');
    const invalidToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

    const output = execCLI(['--config', configPath, '--event', 'manual'], {
      cwd: testDir,
      env: {
        VISOR_LICENSE: invalidToken,
        VISOR_AUTHOR_ASSOCIATION: 'NONE',
      },
    });

    // Invalid signature -> LicenseValidator returns null -> DefaultPolicyEngine
    // All checks run
    expect(output).toContain('ALLOWED_CHECK_RAN');
    expect(output).toContain('DENIED_CHECK_SHOULD_NOT_RUN');
  }, 60_000);
});

// ===========================================================================
// SECTION B: Direct-import tests (real OPA WASM policy enforcement)
//
// These tests use the OpaPolicyEngine directly via Jest imports, bypassing
// the ncc bundle limitation. The `globalThis.require` trick allows
// OpaWasmEvaluator's `new Function('id','return require(id)')` to work.
// ===========================================================================

describeWasm('Policy enforcement E2E - OPA WASM evaluation (direct import)', () => {
  let OpaPolicyEngine: typeof import('../../src/enterprise/policy/opa-policy-engine').OpaPolicyEngine;
  let engine: InstanceType<typeof OpaPolicyEngine> | null = null;
  let testPoliciesDir: string;
  let savedGlobalRequire: any;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    // Expose `require` globally so OpaWasmEvaluator's dynamic require works in Jest
    savedGlobalRequire = (globalThis as any).require;
    (globalThis as any).require = require;

    const mod = await import('../../src/enterprise/policy/opa-policy-engine');
    OpaPolicyEngine = mod.OpaPolicyEngine;

    // Create rego files in a temp directory
    testPoliciesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-policy-wasm-'));
    fs.writeFileSync(path.join(testPoliciesDir, 'check_execute.rego'), CHECK_EXECUTE_REGO);
    fs.writeFileSync(path.join(testPoliciesDir, 'tool_invoke.rego'), TOOL_INVOKE_REGO);
    fs.writeFileSync(
      path.join(testPoliciesDir, 'capability_resolve.rego'),
      CAPABILITY_RESOLVE_REGO
    );
  }, 30_000);

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear env vars that OpaPolicyEngine reads
    delete process.env.VISOR_LICENSE;
    delete process.env.VISOR_LICENSE_FILE;
    delete process.env.VISOR_AUTHOR_ASSOCIATION;
    delete process.env.VISOR_AUTHOR_LOGIN;
    delete process.env.GITHUB_ACTOR;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_REPOSITORY_OWNER;
    delete process.env.GITHUB_REPOSITORY;
  });

  afterEach(async () => {
    // Shutdown engine if still active
    if (engine) {
      await engine.shutdown();
      engine = null;
    }
    // Restore original environment exactly
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      process.env[key] = value;
    }
  });

  afterAll(() => {
    // Restore globalThis.require
    if (savedGlobalRequire !== undefined) {
      (globalThis as any).require = savedGlobalRequire;
    } else {
      delete (globalThis as any).require;
    }

    // Clean up temp directory
    if (testPoliciesDir) {
      try {
        fs.rmSync(testPoliciesDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  /**
   * Helper: create and initialize an OpaPolicyEngine with specific actor context.
   */
  async function createEngine(
    actorLogin: string,
    authorAssociation: string,
    opts: { fallback?: 'allow' | 'deny'; localMode?: boolean } = {}
  ): Promise<void> {
    const config = {
      engine: 'local' as const,
      rules: testPoliciesDir,
      fallback: (opts.fallback ?? 'deny') as 'allow' | 'deny',
      timeout: 10000,
      roles: {
        admin: { author_association: ['OWNER'] },
        external: { author_association: ['NONE'] },
        reviewer: { author_association: ['COLLABORATOR'] },
      },
    };

    engine = new OpaPolicyEngine(config);

    // Set environment for actor context resolution during initialize
    process.env.VISOR_AUTHOR_LOGIN = actorLogin;
    process.env.VISOR_AUTHOR_ASSOCIATION = authorAssociation;

    if (opts.localMode === false) {
      // Force non-local mode so isLocalMode does not grant blanket access
      process.env.GITHUB_ACTIONS = 'true';
    }
    // By default, GITHUB_ACTIONS is unset (local mode), which means
    // isLocalMode=true in the rego. We override this per test as needed.

    await engine.initialize(config);
  }

  // =========================================================================
  // 7. Policy denies check when actor lacks the required role
  // =========================================================================

  it('denies check execution when actor lacks required role (OPA WASM)', async () => {
    // Actor is NONE (external), not admin. Non-local mode so isLocalMode=false.
    await createEngine('external-user', 'NONE', { localMode: false });

    // Check with policy.require: admin -- should be denied for external
    const decision = await engine!.evaluateCheckExecution('denied-check', {
      type: 'log',
      policy: { require: 'admin' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('policy denied');
  }, 30_000);

  // =========================================================================
  // 8. Policy allows check when actor has the required role (WASM confirms)
  // =========================================================================

  it('allows check execution when actor has the required role (OPA WASM)', async () => {
    // Actor is OWNER -> maps to admin role. Non-local mode.
    await createEngine('admin-user', 'OWNER', { localMode: false });

    // denied-check requires admin -- OWNER has admin, so should be allowed
    const decision = await engine!.evaluateCheckExecution('denied-check', {
      type: 'log',
      policy: { require: 'admin' },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  }, 30_000);

  // =========================================================================
  // 9. Selective denial: only policy-gated checks are denied
  // =========================================================================

  it('selectively denies only policy-gated checks while allowing others', async () => {
    // Actor is COLLABORATOR -> maps to reviewer role. Non-local mode.
    await createEngine('reviewer-user', 'COLLABORATOR', { localMode: false });

    // Check without policy.require -- the rego has `default allowed = false`
    // and no rule for checks without policy.require in non-local mode.
    // Actually, the rego does NOT have a rule for "no policy requirement
    // in non-local mode" -- so checks without policy.require will be denied
    // unless the actor has admin or other matching role. Let's test with a
    // check that has policy.require: reviewer (which the actor has)
    // vs one that has policy.require: admin (which the actor does not have).

    const allowedDecision = await engine!.evaluateCheckExecution('reviewer-check', {
      type: 'log',
      policy: { require: 'reviewer' },
    });

    const deniedDecision = await engine!.evaluateCheckExecution('admin-only-check', {
      type: 'log',
      policy: { require: 'admin' },
    });

    expect(allowedDecision.allowed).toBe(true);
    expect(deniedDecision.allowed).toBe(false);
    expect(deniedDecision.reason).toContain('policy denied');
  }, 30_000);

  // =========================================================================
  // 10. Policy with fallback=allow still enforces rego deny decision
  // =========================================================================

  it('respects rego deny decision even when fallback is allow', async () => {
    // Use fallback=allow, but the rego explicitly denies when role is missing.
    // The fallback only applies when evaluation errors occur, not when
    // evaluation succeeds with allowed=false.
    await createEngine('external-user', 'NONE', {
      fallback: 'allow',
      localMode: false,
    });

    // Check with policy.require: admin -- external user should be denied
    const decision = await engine!.evaluateCheckExecution('gated-check', {
      type: 'log',
      policy: { require: 'admin' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('policy denied');
  }, 30_000);

  // =========================================================================
  // 11. Local mode (isLocalMode=true) allows checks without policy.require
  // =========================================================================

  it('allows checks without policy.require in local mode', async () => {
    // GITHUB_ACTIONS is NOT set, so isLocalMode=true.
    await createEngine('random-user', 'NONE');

    // Check WITHOUT policy.require -- the rego allows this in local mode
    const decision = await engine!.evaluateCheckExecution('unrestricted-check', {
      type: 'log',
      // no policy field
    });

    expect(decision.allowed).toBe(true);
  }, 30_000);

  // =========================================================================
  // 12. Local mode does NOT bypass explicit policy.require
  //     (The rego only grants local mode access for checks without
  //      a policy.require field. Checks with policy.require must still
  //      match the actor's roles.)
  // =========================================================================

  it('local mode does not bypass explicit policy.require when role mismatches', async () => {
    // GITHUB_ACTIONS is NOT set, so isLocalMode=true.
    // But the check has policy.require: admin, and actor is NONE (external).
    await createEngine('local-user', 'NONE');

    const decision = await engine!.evaluateCheckExecution('admin-gated', {
      type: 'log',
      policy: { require: 'admin' },
    });

    // The rego rule for local mode requires `not input.check.policy`,
    // which fails here because check.policy exists. So the check is denied
    // unless the actor has admin role (which NONE does not).
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('policy denied');
  }, 30_000);

  // =========================================================================
  // 13. Array-form policy.require matches any matching role
  // =========================================================================

  it('allows check when policy.require is an array and actor has one of the roles', async () => {
    // Actor is COLLABORATOR -> maps to reviewer role. Non-local mode.
    await createEngine('reviewer-user', 'COLLABORATOR', { localMode: false });

    // policy.require: ['admin', 'reviewer'] -- actor has reviewer
    const decision = await engine!.evaluateCheckExecution('multi-role-check', {
      type: 'log',
      policy: { require: ['admin', 'reviewer'] },
    });

    expect(decision.allowed).toBe(true);
  }, 30_000);

  // =========================================================================
  // 14. Multiple evaluations on the same engine instance are stable
  // =========================================================================

  it('multiple evaluations on the same engine are stable and consistent', async () => {
    await createEngine('admin-user', 'OWNER', { localMode: false });

    const decisions: Array<{ allowed: boolean; reason?: string }> = [];
    for (let i = 0; i < 5; i++) {
      const d = await engine!.evaluateCheckExecution(`check-${i}`, {
        type: 'log',
        policy: { require: 'admin' },
      });
      decisions.push(d);
    }

    // All decisions should consistently allow admin
    for (const d of decisions) {
      expect(d.allowed).toBe(true);
    }
  }, 30_000);
});
