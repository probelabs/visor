/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

/**
 * Re-export KnexStoreBackend from the unified OSS implementation.
 * Enterprise features (license gating) are handled by the loader.
 */
export { KnexStoreBackend } from '../../scheduler/store/knex-store';
