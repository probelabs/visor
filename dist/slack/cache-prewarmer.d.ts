import { SlackClient } from './client';
import { SlackAdapter } from './adapter';
import { SlackCachePrewarmingConfig } from '../types/bot';
export interface PrewarmingResult {
    totalThreads: number;
    durationMs: number;
    channels: Array<{
        channel: string;
        threadsPrewarmed: number;
        errors: string[];
    }>;
    users: Array<{
        user: string;
        threadsPrewarmed: number;
        errors: string[];
    }>;
    errors: string[];
}
export declare class CachePrewarmer {
    private client;
    private adapter;
    private cfg;
    constructor(client: SlackClient, adapter: SlackAdapter, config: SlackCachePrewarmingConfig);
    prewarm(): Promise<PrewarmingResult>;
    private prewarmChannels;
    private prewarmUsers;
    private prewarmChannel;
    private prewarmUser;
    private sleep;
}
//# sourceMappingURL=cache-prewarmer.d.ts.map