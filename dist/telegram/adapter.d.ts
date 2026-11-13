import type { TelegramClient } from './client';
import type { ConversationContext, NormalizedMessage } from '../types/bot';
/** Subset of Telegram message fields we care about */
export interface TelegramMessageInfo {
    message_id: number;
    from?: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username?: string;
    };
    chat: {
        id: number;
        type: 'private' | 'group' | 'supergroup' | 'channel';
        title?: string;
        username?: string;
    };
    date: number;
    text?: string;
    caption?: string;
    reply_to_message?: TelegramMessageInfo;
    message_thread_id?: number;
}
export declare class TelegramAdapter {
    private client;
    private botInfo;
    constructor(client: TelegramClient);
    initialize(): Promise<void>;
    getBotUsername(): string | undefined;
    getBotUserId(): number | undefined;
    /** Check if the bot is mentioned in the message text via @username */
    isBotMentioned(text: string): boolean;
    /** Check if this is a private (DM) chat */
    isPrivateChat(chat: {
        type: string;
    }): boolean;
    /** Check if this is a channel post */
    isChannelPost(chat: {
        type: string;
    }): boolean;
    /** Normalize a Telegram message to NormalizedMessage */
    normalizeMessage(msg: TelegramMessageInfo): NormalizedMessage;
    /** Build ConversationContext from a Telegram message */
    buildConversationContext(msg: TelegramMessageInfo): ConversationContext;
}
//# sourceMappingURL=adapter.d.ts.map