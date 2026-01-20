import { SlackClient } from './client';
import { ThreadCache } from './thread-cache';
import { ConversationContext, NormalizedMessage, SlackBotConfig } from '../types/bot';
interface SlackMessage {
    ts: string;
    user?: string;
    text?: string;
    bot_id?: string;
    thread_ts?: string;
}
export declare class SlackAdapter {
    private client;
    private cache;
    private config;
    private botUserId;
    private botId;
    constructor(client: SlackClient, config: SlackBotConfig, cache?: ThreadCache, botId?: string);
    private getBotUserId;
    fetchConversation(channel: string, threadTs: string, currentMessage: {
        ts: string;
        user: string;
        text: string;
        timestamp: number;
    }): Promise<ConversationContext>;
    private fetchThreadFromAPI;
    normalizeSlackMessage(msg: SlackMessage): NormalizedMessage;
    private buildConversationContext;
    updateCache(channel: string, threadTs: string, newMessage: NormalizedMessage): void;
    invalidateCache(channel: string, threadTs: string): void;
    getCacheStats(): import("./thread-cache").CacheStats;
    getCache(): ThreadCache;
    getClient(): SlackClient;
    getConfig(): SlackBotConfig;
}
export {};
//# sourceMappingURL=adapter.d.ts.map