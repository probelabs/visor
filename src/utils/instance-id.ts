/**
 * Visor instance ID — unique per process lifetime.
 *
 * Used to identify which visor instance created/owns a task,
 * especially in multi-node environments.
 */

import { generateHumanId } from './human-id';

let _instanceId: string | undefined;

/** Get or generate the visor instance ID for this process. */
export function getInstanceId(): string {
  if (!_instanceId) {
    _instanceId = generateHumanId();
  }
  return _instanceId;
}
