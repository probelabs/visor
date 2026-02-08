/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface LicensePayload {
  org: string;
  features: string[];
  exp: number;
  iat: number;
  sub: string;
}

export class LicenseValidator {
  /** Ed25519 public key for license verification (PEM format). */
  private static PUBLIC_KEY =
    '-----BEGIN PUBLIC KEY-----\n' +
    'MCowBQYDK2VwAyEAI/Zd08EFmgIdrDm/HXd0l3/5GBt7R1PrdvhdmEXhJlU=\n' +
    '-----END PUBLIC KEY-----\n';

  private cache: { payload: LicensePayload; validatedAt: number } | null = null;
  private static CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private static GRACE_PERIOD = 72 * 3600 * 1000; // 72 hours after expiry

  /**
   * Load and validate license from environment or file.
   *
   * Resolution order:
   * 1. VISOR_LICENSE env var (JWT string)
   * 2. VISOR_LICENSE_FILE env var (path to file)
   * 3. .visor-license in project root (cwd)
   * 4. .visor-license in ~/.config/visor/
   */
  async loadAndValidate(): Promise<LicensePayload | null> {
    // Return cached result if still fresh
    if (this.cache && Date.now() - this.cache.validatedAt < LicenseValidator.CACHE_TTL) {
      return this.cache.payload;
    }

    const token = this.resolveToken();
    if (!token) return null;

    const payload = this.verifyAndDecode(token);
    if (!payload) return null;

    this.cache = { payload, validatedAt: Date.now() };
    return payload;
  }

  /** Check if a specific feature is licensed */
  hasFeature(feature: string): boolean {
    if (!this.cache) return false;
    return this.cache.payload.features.includes(feature);
  }

  /** Check if license is valid (with grace period) */
  isValid(): boolean {
    if (!this.cache) return false;
    const now = Date.now();
    const expiryMs = this.cache.payload.exp * 1000;
    return now < expiryMs + LicenseValidator.GRACE_PERIOD;
  }

  /** Check if the license is within its grace period (expired but still valid) */
  isInGracePeriod(): boolean {
    if (!this.cache) return false;
    const now = Date.now();
    const expiryMs = this.cache.payload.exp * 1000;
    return now >= expiryMs && now < expiryMs + LicenseValidator.GRACE_PERIOD;
  }

  private resolveToken(): string | null {
    // 1. Direct env var
    if (process.env.VISOR_LICENSE) {
      return process.env.VISOR_LICENSE.trim();
    }

    // 2. File path from env (validate against path traversal)
    if (process.env.VISOR_LICENSE_FILE) {
      const resolved = path.normalize(path.resolve(process.env.VISOR_LICENSE_FILE));
      if (resolved.includes('..')) return null;
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const allowedPrefixes = [path.normalize(process.cwd())];
      if (home) allowedPrefixes.push(path.normalize(path.join(home, '.config', 'visor')));
      const isSafe = allowedPrefixes.some(
        prefix => resolved === prefix || resolved.startsWith(prefix + path.sep)
      );
      if (!isSafe) return null;
      return this.readFile(resolved);
    }

    // 3. .visor-license in cwd
    const cwdPath = path.join(process.cwd(), '.visor-license');
    const cwdToken = this.readFile(cwdPath);
    if (cwdToken) return cwdToken;

    // 4. ~/.config/visor/.visor-license
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      const configPath = path.join(home, '.config', 'visor', '.visor-license');
      const configToken = this.readFile(configPath);
      if (configToken) return configToken;
    }

    return null;
  }

  private readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8').trim();
    } catch {
      return null;
    }
  }

  private verifyAndDecode(token: string): LicensePayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [headerB64, payloadB64, signatureB64] = parts;

      // Decode header to verify algorithm
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
      if (header.alg !== 'EdDSA') return null;

      // Verify signature
      const data = `${headerB64}.${payloadB64}`;
      const signature = Buffer.from(signatureB64, 'base64url');

      const publicKey = crypto.createPublicKey(LicenseValidator.PUBLIC_KEY);
      const isValid = crypto.verify(null, Buffer.from(data), publicKey, signature);
      if (!isValid) return null;

      // Decode payload
      const payload: LicensePayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      // Validate required fields
      if (
        !payload.org ||
        !Array.isArray(payload.features) ||
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        !payload.sub
      ) {
        return null;
      }

      // Check expiry (with grace period)
      const now = Date.now();
      const expiryMs = payload.exp * 1000;
      if (now >= expiryMs + LicenseValidator.GRACE_PERIOD) {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }
}
