import { formatTeamsText } from '../teams/markdown';
import type { TeamsClient } from '../teams/client';
import type { ConversationReference } from 'botbuilder';
import { logger } from '../logger';
import type { TaskLiveUpdateSink } from './task-live-updates';

export class TeamsTaskLiveUpdateSink implements TaskLiveUpdateSink {
  readonly kind = 'teams';
  private activityId?: string;

  constructor(
    private readonly teams: TeamsClient,
    private readonly conversationReference: ConversationReference,
    private readonly replyToActivityId?: string,
    initialActivityId?: string
  ) {
    this.activityId = initialActivityId;
  }

  async start(): Promise<{ ref?: Record<string, unknown> } | null> {
    logger.debug('[TaskLiveUpdates][Teams] Initialized live update sink');
    return null;
  }

  async update(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.publish(text, 'progress');
  }

  async complete(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.publish(text, 'final');
  }

  async fail(text: string): Promise<{ ref?: Record<string, unknown> } | null> {
    return this.publish(text, 'final');
  }

  private async publish(
    text: string,
    mode: 'progress' | 'final'
  ): Promise<{ ref?: Record<string, unknown> } | null> {
    const formatted = formatTeamsText(text);
    if (this.activityId) {
      logger.debug(`[TaskLiveUpdates][Teams] Updating existing activityId=${this.activityId}`);
      const updated = await this.teams.updateMessage({
        conversationReference: this.conversationReference,
        activityId: this.activityId,
        text: formatted,
      });
      if (updated?.ok) return null;
      logger.warn(
        `[TaskLiveUpdates][Teams] updateMessage failed for activityId=${this.activityId} error=${updated?.error || 'unknown_error'}; falling back to sendMessage`
      );
    }

    logger.info('[TaskLiveUpdates][Teams] Posting live update message');
    const posted = await this.teams.sendMessage({
      conversationReference: this.conversationReference,
      text: formatted,
      ...(this.replyToActivityId ? { replyToActivityId: this.replyToActivityId } : {}),
    });
    if (posted?.ok && posted.activityId) {
      const previousActivityId = this.activityId;
      this.activityId = posted.activityId;
      if (mode === 'final' && previousActivityId && previousActivityId !== posted.activityId) {
        const deleted = await this.teams.deleteMessage({
          conversationReference: this.conversationReference,
          activityId: previousActivityId,
        });
        if (!deleted) {
          logger.warn(
            `[TaskLiveUpdates][Teams] deleteMessage failed for stale live update activityId=${previousActivityId}`
          );
        } else {
          logger.info(
            `[TaskLiveUpdates][Teams] Removed stale live update activityId=${previousActivityId} after final fallback post`
          );
        }
      }
      return {
        ref: {
          teams_live_update_activity_id: posted.activityId,
        },
      };
    }

    return null;
  }
}
