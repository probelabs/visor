/**
 * TaskStreamManager — manages SSE subscribers for task updates.
 *
 * Provides subscribe/emit/cleanup for real-time task event streaming.
 * Each subscriber is an HTTP ServerResponse that receives SSE events.
 */

import http from 'http';
import type { TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from './types';
import { isTerminalState } from './state-transitions';

export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export class TaskStreamManager {
  private subscribers = new Map<string, Set<http.ServerResponse>>();
  private keepaliveTimers = new Map<http.ServerResponse, ReturnType<typeof setInterval>>();
  private keepaliveIntervalMs: number;

  constructor(keepaliveIntervalMs = 30_000) {
    this.keepaliveIntervalMs = keepaliveIntervalMs;
  }

  /**
   * Subscribe an HTTP response to SSE events for a task.
   * Sets SSE headers and registers cleanup on disconnect.
   */
  subscribe(taskId: string, res: http.ServerResponse): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (!this.subscribers.has(taskId)) {
      this.subscribers.set(taskId, new Set());
    }
    this.subscribers.get(taskId)!.add(res);

    // Clean up on disconnect
    res.on('close', () => {
      this.removeSubscriber(taskId, res);
    });

    // Send keepalive every N seconds
    const timer = setInterval(() => {
      if (res.writable) {
        res.write(': keepalive\n\n');
      } else {
        this.removeSubscriber(taskId, res);
      }
    }, this.keepaliveIntervalMs);
    this.keepaliveTimers.set(res, timer);
  }

  /**
   * Emit an event to all subscribers of a task.
   * If the event is a terminal status update, closes all connections.
   */
  emit(taskId: string, event: TaskEvent): void {
    const subs = this.subscribers.get(taskId);
    if (!subs || subs.size === 0) return;

    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subs) {
      if (res.writable) {
        res.write(data);
      }
    }

    // If terminal state, close all connections for this task
    if (event.type === 'TaskStatusUpdateEvent' && isTerminalState(event.status.state)) {
      for (const res of subs) {
        this.clearKeepalive(res);
        if (res.writable) {
          res.end();
        }
      }
      this.subscribers.delete(taskId);
    }
  }

  /**
   * Check if a task has any active subscribers.
   */
  hasSubscribers(taskId: string): boolean {
    return (this.subscribers.get(taskId)?.size ?? 0) > 0;
  }

  /**
   * Get count of subscribers for a task.
   */
  getSubscriberCount(taskId: string): number {
    return this.subscribers.get(taskId)?.size ?? 0;
  }

  /**
   * Close all connections and clean up.
   */
  shutdown(): void {
    for (const [, subs] of this.subscribers) {
      for (const res of subs) {
        this.clearKeepalive(res);
        if (res.writable) {
          res.end();
        }
      }
      subs.clear();
    }
    this.subscribers.clear();
  }

  private removeSubscriber(taskId: string, res: http.ServerResponse): void {
    this.clearKeepalive(res);
    const subs = this.subscribers.get(taskId);
    if (subs) {
      subs.delete(res);
      if (subs.size === 0) {
        this.subscribers.delete(taskId);
      }
    }
  }

  private clearKeepalive(res: http.ServerResponse): void {
    const timer = this.keepaliveTimers.get(res);
    if (timer) {
      clearInterval(timer);
      this.keepaliveTimers.delete(res);
    }
  }
}
