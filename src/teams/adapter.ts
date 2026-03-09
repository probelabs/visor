// Microsoft Teams message normalization + Activity parsing.
// Converts Bot Framework Activity objects into Visor's shared NormalizedMessage/ConversationContext.

import { TurnContext } from 'botbuilder';
import type { Activity, ConversationReference } from 'botbuilder';
import type { NormalizedMessage, ConversationContext } from '../types/bot';

export interface TeamsMessageInfo {
  activityId: string;
  conversationId: string;
  conversationType: 'personal' | 'groupChat' | 'channel';
  from: {
    id: string;
    name?: string;
    aadObjectId?: string;
  };
  text: string;
  timestamp: string;
  replyToId?: string;
  channelId?: string;
  teamId?: string;
  tenantId?: string;
  conversationReference: ConversationReference;
}

export class TeamsAdapter {
  private appId: string;

  constructor(appId: string) {
    this.appId = appId;
  }

  /** Check if a message is from the bot itself */
  isFromBot(msg: TeamsMessageInfo): boolean {
    return msg.from.id === this.appId;
  }

  /** Normalize a Teams message into Visor's shared format */
  normalizeMessage(msg: TeamsMessageInfo): NormalizedMessage {
    const isBot = this.isFromBot(msg);
    return {
      role: isBot ? 'bot' : 'user',
      text: msg.text || '',
      timestamp: msg.timestamp,
      origin: isBot ? 'visor' : undefined,
      user: msg.from.id,
    };
  }

  /** Build a ConversationContext from a Teams message */
  buildConversationContext(msg: TeamsMessageInfo): ConversationContext {
    const threadId = msg.conversationId;
    const current = this.normalizeMessage(msg);
    return {
      transport: 'teams',
      thread: { id: threadId },
      messages: [current],
      current,
      attributes: {
        activity_id: msg.activityId,
        conversation_id: msg.conversationId,
        conversation_type: msg.conversationType,
        from_id: msg.from.id,
        ...(msg.from.name ? { from_name: msg.from.name } : {}),
        ...(msg.replyToId ? { reply_to_id: msg.replyToId } : {}),
        ...(msg.channelId ? { channel_id: msg.channelId } : {}),
        ...(msg.teamId ? { team_id: msg.teamId } : {}),
        ...(msg.tenantId ? { tenant_id: msg.tenantId } : {}),
      },
    };
  }

  /**
   * Parse a Bot Framework Activity into TeamsMessageInfo.
   * Returns null for non-message activities or empty text.
   */
  static parseActivity(activity: Activity): TeamsMessageInfo | null {
    if (activity.type !== 'message') return null;

    // Strip @mention of the bot from message text
    let text = activity.text || '';
    if (activity.entities) {
      for (const entity of activity.entities) {
        if (entity.type === 'mention' && entity.mentioned?.id) {
          const mentionText = entity.text || '';
          if (mentionText) {
            text = text.replace(mentionText, '').trim();
          }
        }
      }
    }

    if (!text) return null;

    const conversationType =
      (activity.conversation?.conversationType as 'personal' | 'groupChat' | 'channel') ||
      'personal';

    const conversationReference = TurnContext.getConversationReference(
      activity
    ) as ConversationReference;

    return {
      activityId: activity.id || '',
      conversationId: activity.conversation?.id || '',
      conversationType,
      from: {
        id: activity.from?.id || '',
        name: activity.from?.name,
        aadObjectId: (activity.from as any)?.aadObjectId,
      },
      text,
      timestamp: activity.timestamp
        ? new Date(activity.timestamp as any).toISOString()
        : new Date().toISOString(),
      replyToId: activity.replyToId,
      channelId: (activity.channelData as any)?.channel?.id,
      teamId: (activity.channelData as any)?.team?.id,
      tenantId: activity.conversation?.tenantId,
      conversationReference,
    };
  }
}
