import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../logger';
import type { RunnerHost } from './runner-host';
import type { GracefulRestartConfig } from '../types/config';

export interface GracefulRestartOptions {
  drainTimeoutMs: number;
  childReadyTimeoutMs: number;
  notifyUsers: boolean;
  restartCommand?: string;
}

/**
 * Manages graceful restart: drains the old process while spawning a new one.
 *
 * Trigger via SIGUSR1. The old process stops accepting new work, waits for
 * in-flight tasks to complete, then exits. The new process takes over.
 */
export class GracefulRestartManager {
  private restarting = false;
  private host: RunnerHost;
  private options: GracefulRestartOptions;
  private cleanupCallbacks: Array<() => Promise<void>> = [];

  constructor(host: RunnerHost, config?: GracefulRestartConfig) {
    this.host = host;
    this.options = {
      drainTimeoutMs: config?.drain_timeout_ms ?? 0,
      childReadyTimeoutMs: config?.child_ready_timeout_ms ?? 15000,
      notifyUsers: config?.notify_users ?? true,
      restartCommand: config?.restart_command || undefined,
    };
  }

  /** Register a cleanup callback to run before old process exits. */
  onCleanup(cb: () => Promise<void>): void {
    this.cleanupCallbacks.push(cb);
  }

  /** Whether a restart is currently in progress. */
  get isRestarting(): boolean {
    return this.restarting;
  }

  /**
   * Initiate a graceful restart. Both processes run in parallel during the
   * transition: the new process accepts new work while the old one finishes
   * its in-flight tasks.
   *
   * 1. Stop listening (close servers/sockets, free ports)
   * 2. Spawn new process (binds to freed ports, starts accepting)
   * 3. Wait for new process to signal readiness
   * 4. Drain old process (wait for in-flight work to complete)
   * 5. Cleanup and exit old process
   */
  async initiateRestart(): Promise<void> {
    if (this.restarting) {
      logger.warn('[GracefulRestart] Restart already in progress, ignoring');
      return;
    }
    this.restarting = true;

    logger.info('[GracefulRestart] Initiating graceful restart…');

    let child: ChildProcess | undefined;
    try {
      // 1. Stop listening — close servers/sockets to free ports.
      //    In-flight work continues processing.
      logger.info('[GracefulRestart] Stopping listeners (freeing ports)…');
      await this.host.stopListeningAll();

      // 2. Spawn the new process (ports are now free)
      child = this.spawnNewProcess();

      // 3. Wait for the child to signal it's ready
      await this.waitForChildReady(child);
      logger.info('[GracefulRestart] New process is ready and accepting work');

      // 4. Drain — wait for old process in-flight work to complete.
      //    New process is handling new requests in parallel.
      logger.info('[GracefulRestart] Waiting for in-flight work to complete…');
      await this.host.drainAll(this.options.drainTimeoutMs);
      logger.info('[GracefulRestart] All in-flight work completed');

      // 5. Run cleanup callbacks (telemetry flush, task store shutdown, etc.)
      for (const cb of this.cleanupCallbacks) {
        try {
          await cb();
        } catch (err) {
          logger.warn(`[GracefulRestart] Cleanup callback error: ${err}`);
        }
      }

      logger.info('[GracefulRestart] Old process exiting');
      process.exit(0);
    } catch (err) {
      logger.error(`[GracefulRestart] Failed: ${err}`);
      this.restarting = false;

      // If child was spawned but we failed, kill it
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      // Old process continues running
    }
  }

  private spawnNewProcess(): ChildProcess {
    const { command, args } = this.buildSpawnCommand();
    const generation = parseInt(process.env.VISOR_RESTART_GENERATION || '0', 10);

    logger.info(
      `[GracefulRestart] Spawning new process (generation ${generation + 1}): ${command} ${args.join(' ')}`
    );

    const child = spawn(command, args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        VISOR_RESTART_GENERATION: String(generation + 1),
      },
      detached: false,
    });

    child.on('error', err => {
      logger.error(`[GracefulRestart] Child process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (this.restarting) {
        logger.warn(
          `[GracefulRestart] Child process exited unexpectedly (code=${code}, signal=${signal})`
        );
      }
    });

    return child;
  }

  private buildSpawnCommand(): { command: string; args: string[] } {
    // 1. Config override takes priority
    if (this.options.restartCommand) {
      const parts = this.options.restartCommand.split(/\s+/);
      return { command: parts[0], args: parts.slice(1) };
    }

    // 2. Auto-detect npx
    const userAgent = process.env.npm_config_user_agent || '';
    if (userAgent.includes('npx/')) {
      // Extract package name from the resolved script path
      // npx resolves to something like: /home/user/.npm/_npx/.../node_modules/.bin/visor
      const visorArgs = this.extractVisorArgs();
      return {
        command: 'npx',
        args: ['-y', '@probelabs/visor@latest', ...visorArgs],
      };
    }

    // 3. Default: re-spawn with same binary
    return {
      command: process.execPath,
      args: process.argv.slice(1),
    };
  }

  /**
   * Extract visor-specific args from process.argv, skipping the node binary
   * and the script path (which may be an npx-resolved path).
   */
  private extractVisorArgs(): string[] {
    // process.argv = ['node', '/path/to/visor', '--slack', '--config', ...]
    // We want everything after the script path
    return process.argv.slice(2);
  }

  private waitForChildReady(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.childReadyTimeoutMs;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Child process did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (msg: unknown) => {
        if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'ready') {
          cleanup();
          // Disconnect IPC so the old process isn't held alive by the child
          if (child.connected) {
            child.disconnect();
          }
          // Unref the child so it doesn't prevent old process from exiting
          child.unref();
          resolve();
        }
      };

      const onExit = (code: number | null, signal: string | null) => {
        cleanup();
        reject(
          new Error(`Child process exited before becoming ready (code=${code}, signal=${signal})`)
        );
      };

      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };

      child.on('message', onMessage);
      child.on('exit', onExit);
    });
  }
}
