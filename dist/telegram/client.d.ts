import { Bot, type Api } from 'grammy';
export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
}
export interface TelegramSendResult {
    ok: boolean;
    message_id?: number;
    error?: string;
}
export declare class TelegramClient {
    private bot;
    private _botInfo;
    constructor(botToken: string);
    /** Get the underlying grammy Bot instance (for polling runner) */
    getBot(): Bot;
    /** Get the underlying grammy API instance */
    get api(): Api;
    /** Initialize bot info (call before using) */
    init(): Promise<TelegramUser>;
    /** Get cached bot info */
    getBotInfo(): TelegramUser | null;
    /**
     * Send a text message with optional HTML parse mode.
     * Auto-chunks messages exceeding 4096 characters.
     * Falls back to plain text if HTML parsing fails.
     */
    sendMessage(opts: {
        chat_id: number | string;
        text: string;
        parse_mode?: 'HTML';
        reply_to_message_id?: number;
        message_thread_id?: number;
    }): Promise<TelegramSendResult>;
    /**
     * Edit an existing text message.
     * Returns ok=false if Telegram rejects the edit (e.g. message too old or unchanged).
     */
    editMessageText(opts: {
        chat_id: number | string;
        message_id: number;
        text: string;
        parse_mode?: 'HTML';
    }): Promise<TelegramSendResult>;
    /**
     * Delete a message.
     */
    deleteMessage(opts: {
        chat_id: number | string;
        message_id: number;
    }): Promise<boolean>;
    /**
     * Send a document/file.
     */
    sendDocument(opts: {
        chat_id: number | string;
        document: Buffer;
        filename: string;
        caption?: string;
        parse_mode?: 'HTML';
        reply_to_message_id?: number;
        message_thread_id?: number;
    }): Promise<TelegramSendResult>;
    /**
     * Add an emoji reaction to a message.
     * Note: Bot must be admin in groups to set reactions.
     */
    setMessageReaction(opts: {
        chat_id: number | string;
        message_id: number;
        emoji: string;
    }): Promise<boolean>;
}
//# sourceMappingURL=client.d.ts.map