import { logger } from '../logger';
import { EventEmitter } from 'events';

/**
 * Work item to be executed by the worker pool
 */
export interface WorkItem<T = any> {
  id: string;
  data: T;
  priority?: number; // Higher priority = processed first (default: 0)
}

/**
 * Work result from execution
 */
export interface WorkResult<T = any> {
  workItemId: string;
  success: boolean;
  result?: T;
  error?: Error;
  duration: number; // milliseconds
}

/**
 * Worker status
 */
export enum WorkerStatus {
  IDLE = 'idle',
  BUSY = 'busy',
  ERROR = 'error',
}

/**
 * Worker statistics
 */
export interface WorkerStats {
  id: number;
  status: WorkerStatus;
  currentWorkItemId?: string;
  tasksCompleted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  totalDuration: number; // milliseconds
  lastError?: string;
}

/**
 * Pool statistics
 */
export interface PoolStats {
  poolSize: number;
  activeWorkers: number;
  idleWorkers: number;
  errorWorkers: number;
  queueSize: number;
  queueCapacity: number;
  totalTasksCompleted: number;
  totalTasksSucceeded: number;
  totalTasksFailed: number;
  totalTasksRejected: number; // Rejected due to full queue
  workers: WorkerStats[];
}

/**
 * Worker pool configuration
 */
export interface WorkerPoolConfig {
  /** Number of concurrent workers (default: 3) */
  poolSize?: number;
  /** Maximum queue size (default: 100). When full, new tasks are rejected */
  queueCapacity?: number;
  /** Task timeout in milliseconds (default: 5 minutes) */
  taskTimeout?: number;
  /** Enable graceful shutdown (default: true) */
  gracefulShutdown?: boolean;
  /** Graceful shutdown timeout in milliseconds (default: 30 seconds) */
  shutdownTimeout?: number;
}

/**
 * Worker pool for executing tasks concurrently
 * Supports:
 * - Configurable pool size and queue capacity
 * - Priority queue for work items
 * - Backpressure handling (reject when queue full)
 * - Worker status tracking
 * - Graceful shutdown
 * - Task timeouts
 */
export class WorkerPool<T = any, R = any> extends EventEmitter {
  private poolSize: number;
  private queueCapacity: number;
  private taskTimeout: number;
  private gracefulShutdown: boolean;
  private shutdownTimeout: number;

  private workers: Map<number, WorkerStats>;
  private queue: WorkItem<T>[];
  private processing: boolean;
  private shuttingDown: boolean;

  private totalTasksCompleted: number = 0;
  private totalTasksSucceeded: number = 0;
  private totalTasksFailed: number = 0;
  private totalTasksRejected: number = 0;

  private executor: (data: T) => Promise<R>;

  /**
   * Create a new worker pool
   * @param executor Function to execute work items
   * @param config Pool configuration
   */
  constructor(executor: (data: T) => Promise<R>, config?: WorkerPoolConfig) {
    super();

    this.executor = executor;
    this.poolSize = config?.poolSize ?? 3;
    this.queueCapacity = config?.queueCapacity ?? 100;
    this.taskTimeout = config?.taskTimeout ?? 5 * 60 * 1000; // 5 minutes
    this.gracefulShutdown = config?.gracefulShutdown ?? true;
    this.shutdownTimeout = config?.shutdownTimeout ?? 30 * 1000; // 30 seconds

    this.workers = new Map();
    this.queue = [];
    this.processing = false;
    this.shuttingDown = false;

    // Initialize workers
    for (let i = 0; i < this.poolSize; i++) {
      this.workers.set(i, {
        id: i,
        status: WorkerStatus.IDLE,
        tasksCompleted: 0,
        tasksSucceeded: 0,
        tasksFailed: 0,
        totalDuration: 0,
      });
    }

    logger.info(
      `Worker pool initialized: size=${this.poolSize}, queue=${this.queueCapacity}, timeout=${this.taskTimeout}ms`
    );
  }

  /**
   * Submit a work item to the pool
   * @param workItem Work item to execute
   * @returns True if accepted, false if queue is full
   */
  submitWork(workItem: WorkItem<T>): boolean {
    if (this.shuttingDown) {
      logger.warn(`Work item ${workItem.id} rejected: pool is shutting down`);
      this.totalTasksRejected++;
      return false;
    }

    // Check queue capacity
    if (this.queue.length >= this.queueCapacity) {
      logger.warn(
        `Work item ${workItem.id} rejected: queue is full (${this.queue.length}/${this.queueCapacity})`
      );
      this.totalTasksRejected++;
      this.emit('queueFull', workItem);
      return false;
    }

    // Add to queue
    this.queue.push(workItem);

    // Sort by priority (higher priority first)
    this.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    logger.debug(
      `Work item ${workItem.id} added to queue (priority: ${workItem.priority ?? 0}, queue size: ${this.queue.length})`
    );

    this.emit('workSubmitted', workItem);

    // Start processing if not already running
    if (!this.processing) {
      this.startProcessing();
    }

    return true;
  }

  /**
   * Start processing work items from the queue
   */
  private startProcessing(): void {
    if (this.processing || this.shuttingDown) {
      return;
    }

    this.processing = true;
    logger.debug('Worker pool started processing');

    // Kick off all workers
    for (let i = 0; i < this.poolSize; i++) {
      this.processNextItem(i);
    }
  }

  /**
   * Process the next work item with a specific worker
   * @param workerId Worker ID
   */
  private async processNextItem(workerId: number): Promise<void> {
    // Check if shutting down
    if (this.shuttingDown) {
      return;
    }

    const worker = this.workers.get(workerId);
    if (!worker) {
      logger.error(`Worker ${workerId} not found`);
      return;
    }

    // Get next work item from queue
    const workItem = this.queue.shift();

    if (!workItem) {
      // No more work, mark worker as idle
      worker.status = WorkerStatus.IDLE;
      worker.currentWorkItemId = undefined;

      // Check if all workers are idle
      const allIdle = Array.from(this.workers.values()).every(w => w.status === WorkerStatus.IDLE);
      if (allIdle && this.queue.length === 0) {
        this.processing = false;
        logger.debug('Worker pool stopped processing (no more work)');
        this.emit('idle');
      }
      return;
    }

    // Mark worker as busy
    worker.status = WorkerStatus.BUSY;
    worker.currentWorkItemId = workItem.id;

    logger.debug(`Worker ${workerId} processing work item ${workItem.id}`);

    const startTime = Date.now();
    let timedOut = false;

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(new Error(`Task timed out after ${this.taskTimeout}ms`));
        }, this.taskTimeout);
      });

      // Race between executor and timeout
      const result = await Promise.race([this.executor(workItem.data), timeoutPromise]);

      const duration = Date.now() - startTime;

      // Update worker stats
      worker.tasksCompleted++;
      worker.tasksSucceeded++;
      worker.totalDuration += duration;
      this.totalTasksCompleted++;
      this.totalTasksSucceeded++;

      logger.debug(
        `Worker ${workerId} completed work item ${workItem.id} successfully (${duration}ms)`
      );

      this.emit('workCompleted', {
        workItemId: workItem.id,
        success: true,
        result,
        duration,
      } as WorkResult<R>);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update worker stats
      worker.tasksCompleted++;
      worker.tasksFailed++;
      worker.totalDuration += duration;
      worker.lastError = errorMessage;
      this.totalTasksCompleted++;
      this.totalTasksFailed++;

      if (timedOut) {
        worker.status = WorkerStatus.ERROR;
        logger.error(`Worker ${workerId} timed out processing work item ${workItem.id}`);
      } else {
        logger.error(
          `Worker ${workerId} failed to process work item ${workItem.id}: ${errorMessage}`
        );
      }

      this.emit('workFailed', {
        workItemId: workItem.id,
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
        duration,
      } as WorkResult<R>);
    }

    // Process next item (unless shutting down)
    if (!this.shuttingDown) {
      // Small delay to prevent tight loops
      setTimeout(() => this.processNextItem(workerId), 10);
    }
  }

  /**
   * Get current pool statistics
   */
  getStatus(): PoolStats {
    const workers = Array.from(this.workers.values());

    return {
      poolSize: this.poolSize,
      activeWorkers: workers.filter(w => w.status === WorkerStatus.BUSY).length,
      idleWorkers: workers.filter(w => w.status === WorkerStatus.IDLE).length,
      errorWorkers: workers.filter(w => w.status === WorkerStatus.ERROR).length,
      queueSize: this.queue.length,
      queueCapacity: this.queueCapacity,
      totalTasksCompleted: this.totalTasksCompleted,
      totalTasksSucceeded: this.totalTasksSucceeded,
      totalTasksFailed: this.totalTasksFailed,
      totalTasksRejected: this.totalTasksRejected,
      workers: workers.map(w => ({ ...w })),
    };
  }

  /**
   * Gracefully shutdown the worker pool
   * Waits for all active workers to complete (up to shutdownTimeout)
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      logger.warn('Worker pool is already shutting down');
      return;
    }

    logger.info('Worker pool shutting down...');
    this.shuttingDown = true;

    if (this.gracefulShutdown) {
      // Wait for active workers to complete
      const startTime = Date.now();
      const checkInterval = 100; // Check every 100ms

      while (Date.now() - startTime < this.shutdownTimeout) {
        const activeWorkers = Array.from(this.workers.values()).filter(
          w => w.status === WorkerStatus.BUSY
        ).length;

        if (activeWorkers === 0) {
          logger.info('All workers completed gracefully');
          break;
        }

        logger.debug(`Waiting for ${activeWorkers} workers to complete...`);
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }

      // Check if any workers are still busy
      const stillBusy = Array.from(this.workers.values()).filter(
        w => w.status === WorkerStatus.BUSY
      ).length;

      if (stillBusy > 0) {
        logger.warn(
          `Graceful shutdown timeout reached, ${stillBusy} workers still busy (forced shutdown)`
        );
      }
    }

    // Clear queue
    const remainingWork = this.queue.length;
    if (remainingWork > 0) {
      logger.warn(`Worker pool shutdown: ${remainingWork} items in queue were not processed`);
      this.queue = [];
    }

    this.processing = false;
    this.emit('shutdown');

    logger.info(
      `Worker pool shutdown complete (completed: ${this.totalTasksCompleted}, succeeded: ${this.totalTasksSucceeded}, failed: ${this.totalTasksFailed}, rejected: ${this.totalTasksRejected})`
    );
  }

  /**
   * Resize the worker pool (add or remove workers)
   * @param newSize New pool size
   */
  async resize(newSize: number): Promise<void> {
    if (newSize < 1) {
      throw new Error('Pool size must be at least 1');
    }

    if (newSize === this.poolSize) {
      logger.debug(`Pool size already ${newSize}, no resize needed`);
      return;
    }

    logger.info(`Resizing worker pool from ${this.poolSize} to ${newSize}`);

    if (newSize > this.poolSize) {
      // Add workers
      for (let i = this.poolSize; i < newSize; i++) {
        this.workers.set(i, {
          id: i,
          status: WorkerStatus.IDLE,
          tasksCompleted: 0,
          tasksSucceeded: 0,
          tasksFailed: 0,
          totalDuration: 0,
        });

        // Start processing if there's work in the queue
        if (this.queue.length > 0 && !this.shuttingDown) {
          this.processNextItem(i);
        }
      }
    } else {
      // Remove workers (gracefully wait for them to finish)
      const workersToRemove = Array.from(this.workers.keys())
        .filter(id => id >= newSize)
        .sort((a, b) => b - a); // Remove from highest ID first

      for (const workerId of workersToRemove) {
        const worker = this.workers.get(workerId);
        if (worker && worker.status === WorkerStatus.BUSY) {
          logger.debug(`Waiting for worker ${workerId} to complete before removing...`);
          // Wait for worker to become idle (with timeout)
          const maxWait = 10000; // 10 seconds
          const startWait = Date.now();
          while (worker.status === WorkerStatus.BUSY && Date.now() - startWait < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        this.workers.delete(workerId);
      }
    }

    this.poolSize = newSize;
    this.emit('resized', { oldSize: this.poolSize, newSize });

    logger.info(`Worker pool resized to ${newSize}`);
  }

  /**
   * Clear the work queue (does not stop running tasks)
   */
  clearQueue(): number {
    const count = this.queue.length;
    this.queue = [];
    logger.info(`Cleared ${count} items from work queue`);
    return count;
  }

  /**
   * Check if pool is idle (no active workers and empty queue)
   */
  isIdle(): boolean {
    return (
      Array.from(this.workers.values()).every(w => w.status === WorkerStatus.IDLE) &&
      this.queue.length === 0
    );
  }

  /**
   * Check if pool is shutting down
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
