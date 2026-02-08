import * as crypto from 'crypto';
import { LicenseValidator } from '../../../src/enterprise/license/validator';

// Generate a test Ed25519 keypair
function generateTestKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function createTestJWT(payload: Record<string, unknown>, privateKey: crypto.KeyObject): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const signature = crypto.sign(null, Buffer.from(data), privateKey);
  return `${data}.${signature.toString('base64url')}`;
}

describe('LicenseValidator', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  it('returns null when no license is found', async () => {
    delete process.env.VISOR_LICENSE;
    delete process.env.VISOR_LICENSE_FILE;
    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();
    expect(result).toBeNull();
  });

  it('returns null for malformed JWT', async () => {
    process.env.VISOR_LICENSE = 'not.a.valid.jwt';
    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();
    expect(result).toBeNull();
  });

  it('returns null for JWT with wrong algorithm', async () => {
    // Create a JWT with HS256 header (wrong alg)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ org: 'test' })).toString('base64url');
    process.env.VISOR_LICENSE = `${header}.${body}.fakesignature`;
    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();
    expect(result).toBeNull();
  });

  it('returns null for JWT with invalid signature (wrong key)', async () => {
    // The validator has a hardcoded placeholder public key, so any JWT signed
    // with a different key will fail signature verification
    const { privateKey } = generateTestKeyPair();
    const payload = {
      org: 'test-org',

      features: ['policy'],
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub: 'license-123',
    };
    const token = createTestJWT(payload, privateKey);
    process.env.VISOR_LICENSE = token;

    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();
    // Should fail because the signing key doesn't match the embedded public key
    expect(result).toBeNull();
  });

  it('hasFeature returns false without a loaded license', () => {
    const validator = new LicenseValidator();
    expect(validator.hasFeature('policy')).toBe(false);
  });

  it('isValid returns false without a loaded license', () => {
    const validator = new LicenseValidator();
    expect(validator.isValid()).toBe(false);
  });

  it('isInGracePeriod returns false without a loaded license', () => {
    const validator = new LicenseValidator();
    expect(validator.isInGracePeriod()).toBe(false);
  });

  it('reads VISOR_LICENSE_FILE env var', async () => {
    delete process.env.VISOR_LICENSE;
    // Point to a non-existent file — should return null gracefully
    process.env.VISOR_LICENSE_FILE = '/tmp/nonexistent-visor-license-test';
    const validator = new LicenseValidator();
    const result = await validator.loadAndValidate();
    expect(result).toBeNull();
  });
});
