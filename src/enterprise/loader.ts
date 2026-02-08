/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

import type { PolicyEngine, PolicyConfig } from '../policy/types';
import { DefaultPolicyEngine } from '../policy/default-engine';

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
