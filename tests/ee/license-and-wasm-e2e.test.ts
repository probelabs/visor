/**
 * Enterprise E2E tests: License validation + OPA WASM policy evaluation.
 *
 * These tests exercise the real Ed25519 JWT signing/verification path,
 * the enterprise loader gating logic, and (when OPA CLI + @open-policy-agent/opa-wasm
 * are available) full WASM compilation and evaluation of OPA rego policies.
 *
 * The WASM tests (sections 6 and 7) use WASM-safe rego files that are
 * functionally identical to the example policies at
 * examples/enterprise-policy/policies/ but avoid the `not set[_] == X`
 * pattern which is unsafe for OPA WASM compilation. The logical behavior
 * tested is the same.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { LicenseValidator, LicensePayload } from '../../src/enterprise/license/validator';
import { DefaultPolicyEngine } from '../../src/policy/default-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a fresh Ed25519 keypair for testing and patch LicenseValidator.
 * This avoids needing the visor-private.pem file on disk (it's gitignored).
 */
const testKeyPair = crypto.generateKeyPairSync('ed25519');
const testPublicKeyPem = testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// Patch LicenseValidator to use our test public key
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(LicenseValidator as any).PUBLIC_KEY = testPublicKeyPem;

/**
 * Sign a JWT with the generated test private key.
 *
 * Format: base64url(header).base64url(payload).base64url(signature)
 * Header: { "alg": "EdDSA", "typ": "JWT" }
 */
function signJwt(payload: Record<string, unknown> | LicensePayload): string {
  const privateKey = testKeyPair.privateKey;

  const header = { alg: 'EdDSA', typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const data = `${headerB64}.${payloadB64}`;
  const signature = crypto.sign(null, Buffer.from(data), privateKey);
  const signatureB64 = signature.toString('base64url');

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Build a standard license payload with sensible defaults.
 * Caller can override any field.
 */
function buildLicensePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    org: 'test-org',

    features: ['policy'],
    exp: now + 3600,
    iat: now,
    sub: 'test-license-001',
    ...overrides,
  };
}

/**
 * Detect whether the `opa` CLI is available on PATH and supports WASM compilation.
 */
function isOpaWasmCapable(): boolean {
  try {
    const output = execSync('opa version', { stdio: 'pipe', encoding: 'utf-8' });
    return output.includes('WebAssembly: available');
  } catch {
    return false;
  }
}

/**
 * Detect whether @open-policy-agent/opa-wasm is importable.
 *
 * Note: We cannot use `new Function('id', 'return require(id)')` here
 * because Jest's sandbox does not expose `require` as a global inside
 * dynamically constructed functions. Instead we use the Jest-provided
 * `require` directly.
 */
function isOpaWasmNpmAvailable(): boolean {
  try {
    require('@open-policy-agent/opa-wasm');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WASM-safe rego policies (equivalent to examples/enterprise-policy/policies/)
//
// OPA's WASM compiler rejects `not collection[_] == "value"` because `_` is
// unbound inside negation. The standard workaround is to extract helper rules
// (e.g., `is_admin { input.actor.roles[_] == "admin" }`) and negate the
// helper (`not is_admin`). The logical behavior is identical.
// ---------------------------------------------------------------------------

const CHECK_EXECUTE_REGO = `
package visor.check.execute

default allowed = false

# Admin can run anything
allowed {
  input.actor.roles[_] == "admin"
}

# Developers can run non-production checks
allowed {
  input.actor.roles[_] == "developer"
  not startswith(input.check.id, "deploy-production")
}

# Reviewers can run read-only checks (info/policy criticality)
allowed {
  input.actor.roles[_] == "reviewer"
  input.check.criticality == "info"
}

allowed {
  input.actor.roles[_] == "reviewer"
  input.check.criticality == "policy"
}

# Per-step role requirement (from YAML policy.require)
allowed {
  required := input.check.policy.require
  is_string(required)
  input.actor.roles[_] == required
}

allowed {
  required := input.check.policy.require
  is_array(required)
  required[_] == input.actor.roles[_]
}

# Local mode (CLI) gets broader access
allowed {
  input.actor.isLocalMode == true
}

reason = "insufficient role for this check" { not allowed }
`;

const TOOL_INVOKE_REGO = `
package visor.tool.invoke

default allowed = true

# Helper: actor has admin role
is_admin { input.actor.roles[_] == "admin" }

# Block destructive methods for non-admins
allowed = false {
  endswith(input.tool.methodName, "_delete")
  not is_admin
}

# Block bash execution tool for externals
allowed = false {
  input.tool.methodName == "bash"
  input.actor.roles[_] == "external"
}

reason = "tool access denied by policy" { not allowed }
`;

const CAPABILITY_RESOLVE_REGO = `
package visor.capability.resolve

# Helper: actor has developer role
is_developer { input.actor.roles[_] == "developer" }

# Helper: actor has admin role
is_admin { input.actor.roles[_] == "admin" }

# Disable file editing for non-developers
capabilities["allowEdit"] = false {
  not is_developer
  not is_admin
}

# Disable bash for external contributors
capabilities["allowBash"] = false {
  input.actor.roles[_] == "external"
}
`;

/**
 * Create a temporary directory with WASM-safe rego files.
 * Returns the path to the directory.
 */
function createWasmSafeRegoDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-opa-test-'));
  fs.writeFileSync(path.join(tmpDir, 'check_execute.rego'), CHECK_EXECUTE_REGO);
  fs.writeFileSync(path.join(tmpDir, 'tool_invoke.rego'), TOOL_INVOKE_REGO);
  fs.writeFileSync(path.join(tmpDir, 'capability_resolve.rego'), CAPABILITY_RESOLVE_REGO);
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Environment save/restore
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear any license-related env vars so tests start clean
  delete process.env.VISOR_LICENSE;
  delete process.env.VISOR_LICENSE_FILE;
  // Clear GitHub env vars that OpaPolicyEngine.initialize reads
  delete process.env.VISOR_AUTHOR_ASSOCIATION;
  delete process.env.VISOR_AUTHOR_LOGIN;
  delete process.env.GITHUB_ACTOR;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_REPOSITORY_OWNER;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_BASE_REF;
  delete process.env.GITHUB_EVENT_NAME;
});

afterEach(() => {
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

// ===========================================================================
// 1. License Validator Happy Path
// ===========================================================================

describe('Enterprise E2E: License Validator Happy Path', () => {
  it('validates a properly-signed JWT and exposes feature checks', async () => {
    const payload = buildLicensePayload();
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    // Should successfully decode and return the payload
    expect(result).not.toBeNull();
    expect(result!.org).toBe('test-org');
    expect(result!.features).toEqual(['policy']);
    expect(result!.sub).toBe('test-license-001');

    // Feature checks
    expect(validator.hasFeature('policy')).toBe(true);
    expect(validator.hasFeature('nonexistent')).toBe(false);

    // Validity checks
    expect(validator.isValid()).toBe(true);
    expect(validator.isInGracePeriod()).toBe(false);
  });

  it('rejects a JWT signed with a different key', async () => {
    // Generate a throwaway Ed25519 key pair
    const { privateKey: wrongKey } = crypto.generateKeyPairSync('ed25519');

    const payload = buildLicensePayload();
    const header = { alg: 'EdDSA', typ: 'JWT' };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = `${headerB64}.${payloadB64}`;
    const signature = crypto.sign(null, Buffer.from(data), wrongKey);
    const jwt = `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).toBeNull();
    expect(validator.isValid()).toBe(false);
    expect(validator.hasFeature('policy')).toBe(false);
  });

  it('rejects a JWT with non-EdDSA algorithm header', async () => {
    const payload = buildLicensePayload();
    const privateKey = testKeyPair.privateKey;

    // Create a JWT with wrong algorithm in header
    const header = { alg: 'RS256', typ: 'JWT' };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = `${headerB64}.${payloadB64}`;
    const signature = crypto.sign(null, Buffer.from(data), privateKey);
    const jwt = `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).toBeNull();
  });

  it('rejects a JWT with missing required fields', async () => {
    // Sign a payload missing the 'org' field
    const payload = {
      features: ['policy'],
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub: 'test-license-001',
    };
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).toBeNull();
  });

  it('rejects a malformed JWT string', async () => {
    process.env.VISOR_LICENSE = 'not.a.valid.jwt.string';

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).toBeNull();
  });

  it('returns null when no license is configured', async () => {
    // All license env vars are cleared in beforeEach
    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).toBeNull();
    expect(validator.isValid()).toBe(false);
    expect(validator.hasFeature('policy')).toBe(false);
  });
});

// ===========================================================================
// 2. License Expiry + Grace Period
// ===========================================================================

describe('Enterprise E2E: License Expiry + Grace Period', () => {
  it('accepts a license expired within the 72h grace period', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Expired 1 hour ago -- well within the 72-hour grace period
    const payload = buildLicensePayload({ exp: now - 3600 });
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).not.toBeNull();
    expect(result!.org).toBe('test-org');

    // License is technically expired but within grace: still valid
    expect(validator.isValid()).toBe(true);
    // ...but should be flagged as in grace period
    expect(validator.isInGracePeriod()).toBe(true);
  });

  it('accepts a license expired 71 hours ago (edge of grace period)', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 71 hours ago: still within the 72h window
    const payload = buildLicensePayload({ exp: now - 71 * 3600 });
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).not.toBeNull();
    expect(validator.isValid()).toBe(true);
    expect(validator.isInGracePeriod()).toBe(true);
  });
});

// ===========================================================================
// 3. License Fully Expired
// ===========================================================================

describe('Enterprise E2E: License Fully Expired', () => {
  it('rejects a license expired more than 72 hours ago', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 100 days ago -- well past the 72-hour grace window
    const payload = buildLicensePayload({ exp: now - 100 * 86400 });
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    // loadAndValidate should return null for fully expired licenses
    expect(result).toBeNull();
    expect(validator.isValid()).toBe(false);
  });

  it('rejects a license expired exactly 73 hours ago (just past grace)', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 73 hours ago: just past the 72-hour window
    const payload = buildLicensePayload({ exp: now - 73 * 3600 });
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();

    expect(result).toBeNull();
  });
});

// ===========================================================================
// 4. License Cache
// ===========================================================================

describe('Enterprise E2E: License Cache', () => {
  it('caches the validated license on subsequent calls', async () => {
    const payload = buildLicensePayload();
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();

    // First call: cold validation
    const t0 = performance.now();
    const result1 = await validator.loadAndValidate();
    const firstDuration = performance.now() - t0;

    // Second call: should use cache
    const t1 = performance.now();
    const result2 = await validator.loadAndValidate();
    const secondDuration = performance.now() - t1;

    // Both should return the same payload
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.sub).toBe(result2!.sub);
    expect(result1!.org).toBe(result2!.org);

    // The cached call should be at least as fast (or faster).
    // We mainly verify both calls succeed with the same result.
    // On fast machines both may be sub-ms, so we just check they work.
    expect(secondDuration).toBeLessThanOrEqual(firstDuration + 5);
  });

  it('returns cached result even after env var is removed', async () => {
    const payload = buildLicensePayload();
    const jwt = signJwt(payload);

    process.env.VISOR_LICENSE = jwt;

    const validator = new LicenseValidator();
    const result1 = await validator.loadAndValidate();
    expect(result1).not.toBeNull();

    // Remove the env var
    delete process.env.VISOR_LICENSE;

    // Second call should still return cached result (within 5-min TTL)
    const result2 = await validator.loadAndValidate();
    expect(result2).not.toBeNull();
    expect(result2!.sub).toBe(result1!.sub);
  });
});

// ===========================================================================
// 5. Enterprise Loader Integration
// ===========================================================================

describe('Enterprise E2E: Enterprise Loader Integration', () => {
  // Dynamic import to match how the loader is used in production
  let loadEnterprisePolicyEngine: typeof import('../../src/enterprise/loader').loadEnterprisePolicyEngine;

  beforeAll(async () => {
    const mod = await import('../../src/enterprise/loader');
    loadEnterprisePolicyEngine = mod.loadEnterprisePolicyEngine;
  });

  it('returns DefaultPolicyEngine when no license is set', async () => {
    // No VISOR_LICENSE env var (cleared in beforeEach)
    const engine = await loadEnterprisePolicyEngine({ engine: 'disabled' });

    expect(engine).toBeInstanceOf(DefaultPolicyEngine);

    // DefaultPolicyEngine always allows everything
    const decision = await engine.evaluateCheckExecution('any-check', {});
    expect(decision.allowed).toBe(true);

    await engine.shutdown();
  });

  it('returns DefaultPolicyEngine when license lacks "policy" feature', async () => {
    // Sign a license with different features (no 'policy')
    const payload = buildLicensePayload({ features: ['analytics', 'audit'] });
    const jwt = signJwt(payload);
    process.env.VISOR_LICENSE = jwt;

    const engine = await loadEnterprisePolicyEngine({ engine: 'disabled' });

    expect(engine).toBeInstanceOf(DefaultPolicyEngine);
    await engine.shutdown();
  });

  it('returns OpaPolicyEngine when valid license with "policy" feature is set', async () => {
    const payload = buildLicensePayload({ features: ['policy'] });
    const jwt = signJwt(payload);
    process.env.VISOR_LICENSE = jwt;

    const engine = await loadEnterprisePolicyEngine({ engine: 'disabled' });

    // When engine='disabled', OpaPolicyEngine.initialize sets evaluator=null,
    // but the loader still returns an OpaPolicyEngine instance (not Default)
    expect(engine).not.toBeInstanceOf(DefaultPolicyEngine);
    // The engine class name should be OpaPolicyEngine
    expect(engine.constructor.name).toBe('OpaPolicyEngine');

    // With evaluator=null (engine: 'disabled'), evaluations return { allowed: true }
    const decision = await engine.evaluateCheckExecution('test-check', { type: 'ai' });
    expect(decision.allowed).toBe(true);

    await engine.shutdown();
  });

  it('logs a warning when license is in grace period', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = buildLicensePayload({ exp: now - 3600 }); // expired 1h ago
    const jwt = signJwt(payload);
    process.env.VISOR_LICENSE = jwt;

    // Capture console.warn calls
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const engine = await loadEnterprisePolicyEngine({ engine: 'disabled' });

    // The loader should have called console.warn about grace period
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('grace period'));

    expect(engine.constructor.name).toBe('OpaPolicyEngine');

    warnSpy.mockRestore();
    await engine.shutdown();
  });
});

// ===========================================================================
// 6. WASM Evaluator with Real Rego (REQUIRES OPA CLI)
// ===========================================================================

const opaWasmCapable = isOpaWasmCapable();
const opaWasmNpmAvailable = isOpaWasmNpmAvailable();
const canRunWasmTests = opaWasmCapable && opaWasmNpmAvailable;

const describeOpa = canRunWasmTests ? describe : describe.skip;

if (!opaWasmCapable) {
  // eslint-disable-next-line no-console
  console.log(
    'OPA CLI not found or does not support WASM. Skipping WASM test suites. ' +
      'Install opa (non-static build with WASM support) to run these tests.'
  );
}
if (opaWasmCapable && !opaWasmNpmAvailable) {
  // eslint-disable-next-line no-console
  console.log(
    '@open-policy-agent/opa-wasm not installed. Skipping WASM test suites. ' +
      'Install it with: npm install @open-policy-agent/opa-wasm'
  );
}

describeOpa('Enterprise E2E: WASM Evaluator with Real Rego', () => {
  // These tests require:
  //   1. `opa` CLI on PATH with WASM support
  //   2. `@open-policy-agent/opa-wasm` npm package installed
  // They compile WASM-safe rego files (equivalent to example policies) and evaluate them.

  let OpaWasmEvaluator: typeof import('../../src/enterprise/policy/opa-wasm-evaluator').OpaWasmEvaluator;
  let evaluator: InstanceType<typeof OpaWasmEvaluator>;
  let testPoliciesDir: string;
  let savedGlobalRequire: any;

  beforeAll(async () => {
    // The OpaWasmEvaluator uses `new Function('id', 'return require(id)')` to
    // dynamically load @open-policy-agent/opa-wasm (avoiding bundler issues).
    // In Jest's sandbox, `require` is module-scoped rather than global, so we
    // temporarily expose it on globalThis for the evaluator to find.
    savedGlobalRequire = (globalThis as any).require;
    (globalThis as any).require = require;

    const mod = await import('../../src/enterprise/policy/opa-wasm-evaluator');
    OpaWasmEvaluator = mod.OpaWasmEvaluator;

    // Create WASM-safe rego files in a temp directory
    testPoliciesDir = createWasmSafeRegoDir();

    evaluator = new OpaWasmEvaluator();
    await evaluator.initialize(testPoliciesDir);
  }, 30000); // WASM compilation can take time

  afterAll(async () => {
    // Restore globalThis.require
    if (savedGlobalRequire !== undefined) {
      (globalThis as any).require = savedGlobalRequire;
    } else {
      delete (globalThis as any).require;
    }

    if (evaluator) {
      await evaluator.shutdown();
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

  it('evaluates check_execute: admin role is allowed for any check', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'deploy-production',
        type: 'command',
        policy: { require: 'admin' },
      },
      actor: {
        login: 'admin-user',
        roles: ['admin'],
        isLocalMode: false,
      },
      repository: { owner: 'test-org', name: 'test-repo' },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    // The WASM bundle evaluates the entire visor package tree.
    // The check_execute.rego result has allowed=true for admin.
    expect(result.check).toBeDefined();
    expect(result.check.execute).toBeDefined();
    expect(result.check.execute.allowed).toBe(true);
  });

  it('evaluates check_execute: external role is denied for deploy-production', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'deploy-production',
        type: 'command',
      },
      actor: {
        login: 'external-contributor',
        roles: ['external'],
        isLocalMode: false,
      },
      repository: { owner: 'test-org', name: 'test-repo' },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check).toBeDefined();
    expect(result.check.execute).toBeDefined();
    expect(result.check.execute.allowed).toBe(false);
    expect(result.check.execute.reason).toBe('insufficient role for this check');
  });

  it('evaluates check_execute: developer is allowed for non-production checks', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'lint-code',
        type: 'ai',
      },
      actor: {
        login: 'dev-user',
        roles: ['developer'],
        isLocalMode: false,
      },
      repository: { owner: 'test-org', name: 'test-repo' },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check.execute.allowed).toBe(true);
  });

  it('evaluates check_execute: developer is denied for deploy-production', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'deploy-production',
        type: 'command',
      },
      actor: {
        login: 'dev-user',
        roles: ['developer'],
        isLocalMode: false,
      },
      repository: { owner: 'test-org', name: 'test-repo' },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check.execute.allowed).toBe(false);
  });

  it('evaluates check_execute: local mode allows everything', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'deploy-production',
        type: 'command',
      },
      actor: {
        login: 'nobody',
        roles: [],
        isLocalMode: true,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check.execute.allowed).toBe(true);
  });

  it('evaluates check_execute: reviewer allowed for info criticality', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'info-check',
        type: 'ai',
        criticality: 'info',
      },
      actor: {
        login: 'reviewer-user',
        roles: ['reviewer'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check.execute.allowed).toBe(true);
  });

  it('evaluates check_execute: reviewer denied for non-info criticality', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'high-criticality-check',
        type: 'ai',
        criticality: 'high',
      },
      actor: {
        login: 'reviewer-user',
        roles: ['reviewer'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check.execute.allowed).toBe(false);
  });

  it('evaluates check_execute: per-step policy.require string match', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'custom-step',
        type: 'command',
        policy: { require: 'developer' },
      },
      actor: {
        login: 'dev-user',
        roles: ['developer'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check.execute.allowed).toBe(true);
  });

  it('evaluates check_execute: per-step policy.require array match', async () => {
    const input = {
      scope: 'check.execute',
      check: {
        id: 'multi-role-step',
        type: 'command',
        policy: { require: ['admin', 'developer'] },
      },
      actor: {
        login: 'dev-user',
        roles: ['developer'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.check.execute.allowed).toBe(true);
  });

  it('evaluates tool_invoke: default allows most tools', async () => {
    const input = {
      scope: 'tool.invoke',
      tool: {
        serverName: 'github',
        methodName: 'search_issues',
      },
      actor: {
        login: 'dev-user',
        roles: ['developer'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.tool).toBeDefined();
    expect(result.tool.invoke).toBeDefined();
    expect(result.tool.invoke.allowed).toBe(true);
  });

  it('evaluates tool_invoke: _delete methods are blocked for non-admins', async () => {
    const input = {
      scope: 'tool.invoke',
      tool: {
        serverName: 'github',
        methodName: 'repo_delete',
      },
      actor: {
        login: 'external-user',
        roles: ['external'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.tool.invoke.allowed).toBe(false);
    expect(result.tool.invoke.reason).toBe('tool access denied by policy');
  });

  it('evaluates tool_invoke: admin can call _delete methods', async () => {
    const input = {
      scope: 'tool.invoke',
      tool: {
        serverName: 'github',
        methodName: 'repo_delete',
      },
      actor: {
        login: 'admin-user',
        roles: ['admin'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.tool.invoke.allowed).toBe(true);
  });

  it('evaluates tool_invoke: bash is blocked for external role', async () => {
    const input = {
      scope: 'tool.invoke',
      tool: {
        serverName: 'shell',
        methodName: 'bash',
      },
      actor: {
        login: 'external-user',
        roles: ['external'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.tool.invoke.allowed).toBe(false);
  });

  it('evaluates tool_invoke: developer can use _delete methods (only admin is checked)', async () => {
    // The policy blocks _delete for non-admins -- developer is not admin so should be denied
    const input = {
      scope: 'tool.invoke',
      tool: {
        serverName: 'github',
        methodName: 'branch_delete',
      },
      actor: {
        login: 'dev-user',
        roles: ['developer'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.tool.invoke.allowed).toBe(false);
  });

  it('evaluates capability_resolve: external role has allowBash=false', async () => {
    const input = {
      scope: 'capability.resolve',
      check: { id: 'ai-review', type: 'ai' },
      capability: {
        allowEdit: true,
        allowBash: true,
        allowedTools: ['github'],
      },
      actor: {
        login: 'external-user',
        roles: ['external'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    expect(result.capability).toBeDefined();
    expect(result.capability.resolve).toBeDefined();
    // External users should have allowBash restricted
    expect(result.capability.resolve.capabilities).toBeDefined();
    expect(result.capability.resolve.capabilities.allowBash).toBe(false);
    // External is also not developer/admin, so allowEdit should be false too
    expect(result.capability.resolve.capabilities.allowEdit).toBe(false);
  });

  it('evaluates capability_resolve: admin keeps full capabilities', async () => {
    const input = {
      scope: 'capability.resolve',
      check: { id: 'ai-review', type: 'ai' },
      capability: {
        allowEdit: true,
        allowBash: true,
      },
      actor: {
        login: 'admin-user',
        roles: ['admin'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    // Admin should not have capability restrictions.
    // The capabilities object should either be empty or not set false.
    if (result.capability?.resolve?.capabilities) {
      expect(result.capability.resolve.capabilities.allowEdit).not.toBe(false);
      expect(result.capability.resolve.capabilities.allowBash).not.toBe(false);
    }
  });

  it('evaluates capability_resolve: developer keeps allowEdit but non-external keeps allowBash', async () => {
    const input = {
      scope: 'capability.resolve',
      check: { id: 'ai-review', type: 'ai' },
      capability: {
        allowEdit: true,
        allowBash: true,
      },
      actor: {
        login: 'dev-user',
        roles: ['developer'],
        isLocalMode: false,
      },
    };

    const result = await evaluator.evaluate(input);

    expect(result).toBeDefined();
    // Developer is included in the developer/admin check, so allowEdit not restricted.
    // Developer is not external, so allowBash not restricted.
    if (result.capability?.resolve?.capabilities) {
      expect(result.capability.resolve.capabilities.allowEdit).not.toBe(false);
      expect(result.capability.resolve.capabilities.allowBash).not.toBe(false);
    }
  });
});

// ===========================================================================
// 7. Full OpaPolicyEngine with WASM (REQUIRES OPA CLI)
// ===========================================================================

describeOpa('Enterprise E2E: Full OpaPolicyEngine with WASM', () => {
  // These tests exercise the full OpaPolicyEngine -> OpaWasmEvaluator path
  // with WASM-safe rego files, real role resolution, and the PolicyEngine interface.

  let OpaPolicyEngine: typeof import('../../src/enterprise/policy/opa-policy-engine').OpaPolicyEngine;
  let engine: InstanceType<typeof OpaPolicyEngine> | null = null;
  let testPoliciesDir: string;
  let savedGlobalRequire: any;

  beforeAll(async () => {
    // Expose `require` globally so OpaWasmEvaluator's dynamic require works in Jest
    savedGlobalRequire = (globalThis as any).require;
    (globalThis as any).require = require;

    const mod = await import('../../src/enterprise/policy/opa-policy-engine');
    OpaPolicyEngine = mod.OpaPolicyEngine;

    // Create WASM-safe rego files in a temp directory
    testPoliciesDir = createWasmSafeRegoDir();
  });

  afterEach(async () => {
    if (engine) {
      await engine.shutdown();
      engine = null;
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

  async function createEngine(actorLogin: string, authorAssociation: string): Promise<void> {
    const config = {
      engine: 'local' as const,
      rules: testPoliciesDir,
      fallback: 'deny' as const,
      timeout: 10000,
      roles: {
        admin: { author_association: ['OWNER', 'MEMBER'] },
        developer: { author_association: ['COLLABORATOR'] },
        reviewer: { author_association: ['CONTRIBUTOR'] },
        external: { author_association: ['NONE', 'FIRST_TIME_CONTRIBUTOR'] },
      },
    };

    engine = new OpaPolicyEngine(config);

    // Set environment for actor context resolution during initialize
    process.env.VISOR_AUTHOR_LOGIN = actorLogin;
    process.env.VISOR_AUTHOR_ASSOCIATION = authorAssociation;
    // Ensure NOT in local mode so isLocalMode doesn't grant blanket access
    process.env.GITHUB_ACTIONS = 'true';

    await engine.initialize(config);
  }

  // -----------------------------------------------------------------------
  // OpaPolicyEngine now includes WASM result navigation (navigateWasmResult)
  // which correctly navigates from the full visor package tree to the
  // specific rule subtree (e.g., visor/check/execute → result.check.execute)
  // before calling parseDecision(). This means deny decisions are now
  // correctly surfaced through the engine.
  // -----------------------------------------------------------------------

  it('admin (OWNER) can execute deploy-production', async () => {
    await createEngine('admin-user', 'OWNER');

    const decision = await engine!.evaluateCheckExecution('deploy-production', {
      type: 'command',
      policy: { require: 'admin' },
    });

    // Admin is always allowed, and the WASM result also parses as allowed=true
    expect(decision.allowed).toBe(true);
  }, 30000);

  it('external user is denied deploy-production by OPA policy', async () => {
    await createEngine('external-user', 'NONE');

    const decision = await engine!.evaluateCheckExecution('deploy-production', {
      type: 'command',
    });

    // The policy denies external users for deploy-production.
    // navigateWasmResult correctly reads .check.execute.allowed from the nested tree.
    expect(decision).toBeDefined();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('insufficient role for this check');
  }, 30000);

  it('developer (COLLABORATOR) is allowed for non-production check', async () => {
    await createEngine('dev-user', 'COLLABORATOR');

    const decision = await engine!.evaluateCheckExecution('lint-code', {
      type: 'ai',
    });

    expect(decision.allowed).toBe(true);
  }, 30000);

  it('role resolution: OWNER maps to admin role during initialization', async () => {
    // Verify that OpaPolicyEngine correctly resolves roles via PolicyInputBuilder
    await createEngine('admin-user', 'OWNER');

    // The engine should have created a PolicyInputBuilder that resolves 'admin' role
    // for OWNER association. We verify this by testing that evaluation succeeds
    // (if role resolution failed, the input would have empty roles array).
    const decision = await engine!.evaluateCheckExecution('admin-only-check', {
      type: 'command',
      policy: { require: 'admin' },
    });

    expect(decision).toBeDefined();
    expect(decision.allowed).toBe(true);
  }, 30000);

  it('role resolution: NONE maps to external role during initialization', async () => {
    await createEngine('external-user', 'NONE');

    // The engine resolves NONE -> external role for the actor.
    // search_issues is allowed for all (default allowed = true for non-destructive tools)
    const decision = await engine!.evaluateToolInvocation('github', 'search_issues');

    expect(decision).toBeDefined();
    expect(decision.allowed).toBe(true);
  }, 30000);

  it('tool invocation: search_issues returns a valid decision', async () => {
    await createEngine('external-user', 'NONE');

    const decision = await engine!.evaluateToolInvocation('github', 'search_issues');

    expect(decision.allowed).toBe(true);
  }, 30000);

  it('tool invocation: repo_delete for admin returns valid decision', async () => {
    await createEngine('admin-user', 'OWNER');

    const decision = await engine!.evaluateToolInvocation('github', 'repo_delete');

    expect(decision.allowed).toBe(true);
  }, 30000);

  it('setActorContext updates the actor for subsequent evaluations', async () => {
    // Start as admin
    await createEngine('admin-user', 'OWNER');

    // Admin can deploy
    const d1 = await engine!.evaluateCheckExecution('deploy-production', {
      type: 'command',
      policy: { require: 'admin' },
    });
    expect(d1.allowed).toBe(true);

    // Switch to external actor via setActorContext
    // The new PolicyInputBuilder will resolve roles from the config
    engine!.setActorContext(
      { login: 'external-user', authorAssociation: 'NONE', isLocalMode: false },
      { owner: 'test-org', name: 'test-repo' }
    );

    // The evaluation runs with the new actor context.
    // External users should be denied deploy-production.
    const d2 = await engine!.evaluateCheckExecution('deploy-production', {
      type: 'command',
    });
    expect(d2).toBeDefined();
    expect(d2.allowed).toBe(false);
  }, 30000);

  it('evaluateCapabilities: external user gets restricted capabilities', async () => {
    await createEngine('external-user', 'NONE');

    const decision = await engine!.evaluateCapabilities('ai-review', {
      allowEdit: true,
      allowBash: true,
      allowedTools: ['github'],
    });

    // The capability_resolve.rego returns capabilities for external users:
    // allowBash=false, allowEdit=false. navigateWasmResult correctly extracts
    // the result from .capability.resolve before parseDecision processes it.
    expect(decision).toBeDefined();
    expect(decision.capabilities).toBeDefined();
    expect(decision.capabilities?.allowBash).toBe(false);
    expect(decision.capabilities?.allowEdit).toBe(false);
  }, 30000);

  it('shutdown cleans up and subsequent evaluations return allowed:true (no evaluator)', async () => {
    await createEngine('admin-user', 'OWNER');

    await engine!.shutdown();

    // After shutdown, evaluator is null, so all evaluations return { allowed: true }
    const decision = await engine!.evaluateCheckExecution('any-check', {});
    expect(decision.allowed).toBe(true);

    // Prevent double-shutdown in afterEach
    engine = null;
  }, 30000);

  it('engine initializes with local mode and evaluates without errors', async () => {
    // Verify the complete initialization lifecycle:
    // 1. Config with local engine mode and roles
    // 2. Actor context resolved from environment
    // 3. OpaWasmEvaluator initialized with compiled WASM
    // 4. Evaluation returns a result (even if not perfectly parsed for deny)
    await createEngine('dev-user', 'COLLABORATOR');

    const checkDecision = await engine!.evaluateCheckExecution('test-check', {
      type: 'ai',
    });
    const toolDecision = await engine!.evaluateToolInvocation('github', 'list_repos');
    const capDecision = await engine!.evaluateCapabilities('test-check', {
      allowEdit: true,
      allowBash: true,
    });

    // All evaluation methods should return valid PolicyDecision objects
    expect(checkDecision).toHaveProperty('allowed');
    expect(toolDecision).toHaveProperty('allowed');
    expect(capDecision).toHaveProperty('allowed');
  }, 30000);

  it('multiple evaluations on the same engine instance are stable', async () => {
    await createEngine('admin-user', 'OWNER');

    // Run multiple evaluations to verify the engine doesn't degrade
    const decisions: Array<{ allowed: boolean; reason?: string }> = [];
    for (let i = 0; i < 5; i++) {
      const d = await engine!.evaluateCheckExecution(`check-${i}`, {
        type: 'ai',
      });
      decisions.push(d);
    }

    // All decisions should be consistent
    for (const d of decisions) {
      expect(d.allowed).toBe(true);
    }
  }, 30000);
});
