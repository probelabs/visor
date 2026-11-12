/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */
export interface LicensePayload {
    org: string;
    features: string[];
    exp: number;
    iat: number;
    sub: string;
}
export declare class LicenseValidator {
    /** Ed25519 public key for license verification (PEM format). */
    private static PUBLIC_KEY;
    private cache;
    private static CACHE_TTL;
    private static GRACE_PERIOD;
    /**
     * Load and validate license from environment or file.
     *
     * Resolution order:
     * 1. VISOR_LICENSE env var (JWT string)
     * 2. VISOR_LICENSE_FILE env var (path to file)
     * 3. .visor-license in project root (cwd)
     * 4. .visor-license in ~/.config/visor/
     */
    loadAndValidate(): Promise<LicensePayload | null>;
    /** Check if a specific feature is licensed */
    hasFeature(feature: string): boolean;
    /** Check if license is valid (with grace period) */
    isValid(): boolean;
    /** Check if the license is within its grace period (expired but still valid) */
    isInGracePeriod(): boolean;
    private resolveToken;
    private readFile;
    private verifyAndDecode;
}
//# sourceMappingURL=validator.d.ts.map