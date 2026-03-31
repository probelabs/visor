import { formatSlackText } from '../slack/markdown';
import type { SlackClient } from '../slack/client';
import { logger } from '../logger';
import type { TaskLiveUpdateSink } from './task-live-updates';

export class SlackTaskLiveUpdateSink implements TaskLiveUpdateSink {
  readonly kind = 'slack';
  private messageTs?: string;
  /** Serialize all publish calls to prevent concurrent postMessage races */
  private publishQueue: Promise<{ ref?: Record<string, unknown> } | null> = Promise.resolve(null);

  constructor(
    private readonly slack: SlackClient,
    private readonly channel: string,
    private readonly threadTs: string,
    initialMessageTs?: string
  ) {
    this.messageTs = initialMessageTs;
  }

  async start(): Promise<{ ref?: Record<string, unknown> } | null> {
    logger.debug(
      `[TaskLiveUpdates][Slack] Initialized live update sink for channel=${this.channel} thread=${this.threadTs}`
    );
    return null;
  }

  async update(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.enqueue(text, 'progress');
  }

  async complete(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.enqueue(text, 'final');
  }

  async fail(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.enqueue(text, 'final');
  }

  /**
   * Enqueue a publish call so they execute serially.
   * This prevents the race where tick() and complete() both see messageTs=undefined
   * and each call chat.postMessage, creating duplicate messages.
   */
  private enqueue(
    text: string,
    mode: 'progress' | 'final'
  ): Promise<{ ref?: Record<string, unknown> } | null> {
    this.publishQueue = this.publishQueue
      .catch(() => {}) // don't let a prior failure block the queue
      .then(() => this.publish(text, mode));
    return this.publishQueue;
  }

  private async publish(
    text: string,
    mode: 'progress' | 'final'
  ): Promise<{ ref?: Record<string, unknown> } | null> {
    if (this.messageTs) {
      logger.debug(
        `[TaskLiveUpdates][Slack] Updating existing message ts=${this.messageTs} in channel=${this.channel}`
      );
      const updated = await this.slack.chat.update({
        channel: this.channel,
        ts: this.messageTs,
        text: formatSlackText(text),
      });
      if (updated?.ok) return null;
      logger.warn(
        `[TaskLiveUpdates][Slack] chat.update failed for ts=${this.messageTs} error=${updated?.error || 'unknown_error'}; falling back to chat.postMessage`
      );
    }
    logger.info(
      `[TaskLiveUpdates][Slack] Posting live update message in channel=${this.channel} thread=${this.threadTs}`
    );
    const posted = await this.slack.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: formatSlackText(text),
    });
    if (posted?.ok && posted.ts) {
      const previousTs = this.messageTs;
      this.messageTs = posted.ts;
      if (mode === 'final' && previousTs && previousTs !== posted.ts) {
        const deleted = await this.slack.chat.delete({
          channel: this.channel,
          ts: previousTs,
        });
        if (!deleted?.ok) {
          logger.warn(
            `[TaskLiveUpdates][Slack] chat.delete failed for stale live update ts=${previousTs} error=${deleted?.error || 'unknown_error'}`
          );
        } else {
          logger.info(
            `[TaskLiveUpdates][Slack] Removed stale live update message ts=${previousTs} after final fallback post`
          );
        }
      }
      return {
        ref: {
          slack_live_update_channel: this.channel,
          slack_live_update_ts: posted.ts,
          slack_live_update_thread_ts: this.threadTs,
        },
      };
    }
    return null;
  }
}
