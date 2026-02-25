/**
 * Types for sandbox execution environments (Docker and Bubblewrap)
 */

import type { ReviewIssue } from '../reviewer';
import type { CheckConfig } from '../types/config';

/**
 * Cache configuration for sandbox volumes
 */
export interface SandboxCacheConfig {
  /** Liquid template for cache scope prefix (default: git branch) */
  prefix?: string;
  /** Fallback prefix when current prefix has no cache */
  fallback_prefix?: string;
  /** Paths inside the container to cache */
  paths: string[];
  /** Time-to-live for cache volumes (e.g., "7d", "24h") */
  ttl?: string;
  /** Maximum number of cache scopes to keep */
  max_scopes?: number;
}

/**
 * Resource limits for sandbox containers
 */
export interface SandboxResourceConfig {
  /** Memory limit (e.g., "512m", "2g") */
  memory?: string;
  /** CPU limit (e.g., 1.0, 0.5) */
  cpu?: number;
}

/**
 * Configuration for a single sandbox environment
 */
export interface SandboxConfig {
  /** Sandbox engine type: 'docker' (default), 'bubblewrap' (Linux namespaces), or 'seatbelt' (macOS sandbox-exec) */
  engine?: 'docker' | 'bubblewrap' | 'seatbelt';

  // Mode 1: pre-built image (docker only)
  /** Docker image to use (e.g., "node:20-alpine") */
  image?: string;

  // Mode 2: build from Dockerfile
  /** Path to Dockerfile (relative to config file or absolute) */
  dockerfile?: string;
  /** Inline Dockerfile content */
  dockerfile_inline?: string;

  // Mode 3: docker-compose
  /** Path to docker-compose file */
  compose?: string;
  /** Service name within the compose file */
  service?: string;

  // Common options
  /** Working directory inside container (default: /workspace) */
  workdir?: string;
  /** Glob patterns for host env vars to forward into sandbox */
  env_passthrough?: string[];
  /** Enable/disable network access (default: true) */
  network?: boolean;
  /** Mount repo as read-only (default: false) */
  read_only?: boolean;
  /** Resource limits */
  resources?: SandboxResourceConfig;
  /** Where visor is mounted inside container (default: /opt/visor) */
  visor_path?: string;

  // Caching
  /** Cache volume configuration */
  cache?: SandboxCacheConfig;
}

/**
 * Options for executing a command inside a sandbox
 */
export interface SandboxExecOptions {
  /** Command to execute */
  command: string;
  /** Environment variables to set */
  env: Record<string, string>;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Maximum output buffer size in bytes */
  maxBuffer: number;
}

/**
 * Result of a command executed inside a sandbox
 */
export interface SandboxExecResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code of the command */
  exitCode: number;
}

/**
 * A running sandbox instance
 */
export interface SandboxInstance {
  /** Sandbox name (matches key in sandboxes config) */
  name: string;
  /** Sandbox configuration */
  config: SandboxConfig;
  /** Execute a command inside the sandbox */
  exec(options: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Stop and remove the sandbox container */
  stop(): Promise<void>;
}

/**
 * Serialized PR info sent to child visor via --run-check
 */
export interface SerializedPRInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>;
  totalAdditions: number;
  totalDeletions: number;
  eventType?: string;
  fullDiff?: string;
  commitDiff?: string;
  isIncremental?: boolean;
  isIssue?: boolean;
  eventContext?: Record<string, unknown>;
}

/**
 * Payload sent to child visor via --run-check
 */
export interface CheckRunPayload {
  /** The check configuration to execute */
  check: CheckConfig;
  /** PR information for the check */
  prInfo: SerializedPRInfo;
  /** Results from dependency checks */
  dependencyOutputs?: Record<string, unknown>;
  /** Environment variables to set */
  env?: Record<string, string>;
}

/**
 * Result from child visor --run-check
 */
export interface CheckRunResult {
  /** Structured issues found */
  issues: ReviewIssue[];
  /** Raw output from the check (for dependent checks) */
  output?: unknown;
  /** Rendered text content */
  content?: string;
  /** Debug information */
  debug?: unknown;
}
