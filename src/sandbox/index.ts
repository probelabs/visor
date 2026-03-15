/**
 * Sandbox module - execution environments for Visor checks (Docker, Bubblewrap, and Seatbelt)
 */

export type {
  SandboxConfig,
  SandboxCacheConfig,
  SandboxResourceConfig,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInstance,
  SerializedPRInfo,
  CheckRunPayload,
  CheckRunResult,
  ProjectServiceConfig,
  ProjectEnvironment,
} from './types';

export { filterEnvForSandbox } from './env-filter';
export { SandboxManager } from './sandbox-manager';
export { generateComposeFile } from './compose-generator';
export { CheckRunner } from './check-runner';
export { CacheVolumeManager } from './cache-volume-manager';
export { BubblewrapSandbox } from './bubblewrap-sandbox';
export { SeatbeltSandbox } from './seatbelt-sandbox';
