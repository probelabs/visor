/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */
import type { PolicyEngine, PolicyConfig } from '../policy/types';
import type { ScheduleStoreBackend, StorageConfig, HAConfig } from '../scheduler/store/types';
/**
 * Load the enterprise policy engine if licensed, otherwise return the default no-op engine.
 *
 * This is the sole import boundary between OSS and enterprise code. Core code
 * must only import from this module (via dynamic `await import()`), never from
 * individual enterprise submodules.
 */
export declare function loadEnterprisePolicyEngine(config: PolicyConfig): Promise<PolicyEngine>;
/**
 * Load the enterprise schedule store backend if licensed.
 *
 * @param driver Database driver ('postgresql', 'mysql', or 'mssql')
 * @param storageConfig Storage configuration with connection details
 * @param haConfig Optional HA configuration
 * @throws Error if enterprise license is not available or missing 'scheduler-sql' feature
 */
export declare function loadEnterpriseStoreBackend(driver: 'postgresql' | 'mysql' | 'mssql', storageConfig: StorageConfig, haConfig?: HAConfig): Promise<ScheduleStoreBackend>;
//# sourceMappingURL=loader.d.ts.map