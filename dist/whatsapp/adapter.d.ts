import type { ConversationContext, NormalizedMessage } from '../types/bot';
/** Subset of WhatsApp message fields from the webhook payload */
export interface WhatsAppMessageInfo {
    messageId: string;
    from: string;
    timestamp: string;
    type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'reaction' | 'unknown';
    text?: string;
    caption?: string;
    context?: {
        message_id: string;
        from?: string;
    };
    phoneNumberId: string;
    displayName?: string;
}
export declare class WhatsAppAdapter {
    private phoneNumberId;
    constructor(phoneNumberId: string);
    /** Check if message is from the bot itself */
    isFromBot(msg: WhatsAppMessageInfo): boolean;
    /** Normalize a WhatsApp message to NormalizedMessage */
    normalizeMessage(msg: WhatsAppMessageInfo): NormalizedMessage;
    /** Build ConversationContext from a WhatsApp message */
    buildConversationContext(msg: WhatsAppMessageInfo): ConversationContext;
    /**
     * Parse webhook payload into WhatsAppMessageInfo[].
     * A single webhook POST can contain multiple messages.
     */
    static parseWebhookPayload(body: any): WhatsAppMessageInfo[];
}
//# sourceMappingURL=adapter.d.ts.map