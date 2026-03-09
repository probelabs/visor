// WhatsApp message adapter.
// Normalizes WhatsApp webhook messages into Visor's shared ConversationContext format.

import type { ConversationContext, NormalizedMessage } from '../types/bot';

/** Subset of WhatsApp message fields from the webhook payload */
export interface WhatsAppMessageInfo {
  messageId: string; // wamid.* ID
  from: string; // sender phone number
  timestamp: string; // Unix timestamp string
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'reaction' | 'unknown';
  text?: string; // for text messages
  caption?: string; // for media messages
  context?: {
    // if this is a reply
    message_id: string;
    from?: string;
  };
  phoneNumberId: string; // the bot's phone number ID (from metadata)
  displayName?: string; // sender's profile name from contacts
}

export class WhatsAppAdapter {
  private phoneNumberId: string;

  constructor(phoneNumberId: string) {
    this.phoneNumberId = phoneNumberId;
  }

  /** Check if message is from the bot itself */
  isFromBot(msg: WhatsAppMessageInfo): boolean {
    return msg.from === this.phoneNumberId;
  }

  /** Normalize a WhatsApp message to NormalizedMessage */
  normalizeMessage(msg: WhatsAppMessageInfo): NormalizedMessage {
    const isBot = this.isFromBot(msg);
    return {
      role: isBot ? 'bot' : 'user',
      text: msg.text || msg.caption || '',
      timestamp: msg.timestamp,
      origin: isBot ? 'visor' : undefined,
      user: msg.from,
    };
  }

  /** Build ConversationContext from a WhatsApp message */
  buildConversationContext(msg: WhatsAppMessageInfo): ConversationContext {
    // Thread ID = sender phone number (conversations tracked by phone number pair)
    const threadId = msg.from;
    const current = this.normalizeMessage(msg);

    return {
      transport: 'whatsapp',
      thread: { id: threadId },
      messages: [current],
      current,
      attributes: {
        message_id: msg.messageId,
        from: msg.from,
        phone_number_id: msg.phoneNumberId,
        ...(msg.displayName ? { display_name: msg.displayName } : {}),
        ...(msg.context?.message_id ? { reply_to_message_id: msg.context.message_id } : {}),
      },
    };
  }

  /**
   * Parse webhook payload into WhatsAppMessageInfo[].
   * A single webhook POST can contain multiple messages.
   */
  static parseWebhookPayload(body: any): WhatsAppMessageInfo[] {
    const results: WhatsAppMessageInfo[] = [];

    if (!body || !Array.isArray(body.entry)) return results;

    for (const entry of body.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (!value || !Array.isArray(value.messages)) continue;

        const phoneNumberId = value.metadata?.phone_number_id || '';

        // Build contacts map for display names
        const contactMap = new Map<string, string>();
        if (Array.isArray(value.contacts)) {
          for (const c of value.contacts) {
            if (c.wa_id && c.profile?.name) {
              contactMap.set(c.wa_id, c.profile.name);
            }
          }
        }

        for (const msg of value.messages) {
          const type = msg.type || 'unknown';
          const info: WhatsAppMessageInfo = {
            messageId: msg.id || '',
            from: msg.from || '',
            timestamp: msg.timestamp || '',
            type: ['text', 'image', 'document', 'audio', 'video', 'reaction'].includes(type)
              ? type
              : 'unknown',
            phoneNumberId,
            displayName: contactMap.get(msg.from),
          };

          // Extract text content based on message type
          if (type === 'text' && msg.text?.body) {
            info.text = msg.text.body;
          } else if (['image', 'document', 'audio', 'video'].includes(type)) {
            info.caption = msg[type]?.caption;
          }

          // Extract reply context
          if (msg.context) {
            info.context = {
              message_id: msg.context.id,
              from: msg.context.from,
            };
          }

          results.push(info);
        }
      }
    }

    return results;
  }
}
