import type { VisorConfig } from '../types/config';
import type { TaskStore } from '../agent-protocol/task-store';

/**
 * Common interface for all long-running frontend runners (Slack, Telegram, etc.).
 *
 * Runners own an execution engine, accept inbound messages from their
 * respective platform, and dispatch workflow executions.
 */
export interface Runner {
  /** Human-readable runner identifier (e.g. 'slack', 'telegram'). */
  readonly name: string;

  /** Start the runner (connect to platform, open server, etc.). */
  start(): Promise<void>;

  /** Gracefully stop the runner. */
  stop(): Promise<void>;

  /** Hot-swap the Visor configuration. */
  updateConfig(cfg: VisorConfig): void;

  /** Optionally attach a shared cross-frontend task store. */
  setTaskStore?(store: TaskStore, configPath?: string): void;
}
