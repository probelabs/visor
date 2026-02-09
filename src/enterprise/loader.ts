/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

import type { PolicyEngine, PolicyConfig } from '../policy/types';
import { DefaultPolicyEngine } from '../policy/default-engine';
import type { ScheduleStoreBackend, StorageConfig, HAConfig } from '../scheduler/store/types';

/**
 * Load the enterprise policy engine if licensed, otherwise return the default no-op engine.
 *
 * This is the sole import boundary between OSS and enterprise code. Core code
 * must only import from this module (via dynamic `await import()`), never from
 * individual enterprise submodules.
 */
export async function loadEnterprisePolicyEngine(config: PolicyConfig): Promise<PolicyEngine> {
  try {
    const { LicenseValidator } = await import('./license/validator');
    const validator = new LicenseValidator();
    const license = await validator.loadAndValidate();

    if (!license || !validator.hasFeature('policy')) {
      return new DefaultPolicyEngine();
    }

    if (validator.isInGracePeriod()) {
      // eslint-disable-next-line no-console
      console.warn(
        '[visor:enterprise] License has expired but is within the 72-hour grace period. ' +
          'Please renew your license.'
      );
    }

    const { OpaPolicyEngine } = await import('./policy/opa-policy-engine');
    const engine = new OpaPolicyEngine(config);
    await engine.initialize(config);
    return engine;
  } catch (err) {
    // Enterprise code not available or initialization failed
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const { logger } = require('../logger');
      logger.warn(`[PolicyEngine] Enterprise policy init failed, falling back to default: ${msg}`);
    } catch {
      // silent
    }
    return new DefaultPolicyEngine();
  }
}

/**
 * Load the enterprise schedule store backend if licensed.
 *
 * @param driver Database driver ('postgresql', 'mysql', or 'mssql')
 * @param storageConfig Storage configuration with connection details
 * @param haConfig Optional HA configuration
 * @throws Error if enterprise license is not available or missing 'scheduler-sql' feature
 */
export async function loadEnterpriseStoreBackend(
  driver: 'postgresql' | 'mysql' | 'mssql',
  storageConfig: StorageConfig,
  haConfig?: HAConfig
): Promise<ScheduleStoreBackend> {
  const { LicenseValidator } = await import('./license/validator');
  const validator = new LicenseValidator();
  const license = await validator.loadAndValidate();

  if (!license || !validator.hasFeature('scheduler-sql')) {
    throw new Error(
      `The ${driver} schedule storage driver requires a Visor Enterprise license ` +
        `with the 'scheduler-sql' feature. Please upgrade or use driver: 'sqlite' (default).`
    );
  }

  if (validator.isInGracePeriod()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[visor:enterprise] License has expired but is within the 72-hour grace period. ' +
        'Please renew your license.'
    );
  }

  const { KnexStoreBackend } = await import('./scheduler/knex-store');
  return new KnexStoreBackend(driver, storageConfig, haConfig);
}
