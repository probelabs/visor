export declare class SlackClient {
    private token;
    constructor(botToken: string);
    readonly reactions: {
        add: ({ channel, timestamp, name, }: {
            channel: string;
            timestamp: string;
            name: string;
        }) => Promise<{
            ok: false;
        } | {
            readonly ok: true;
        }>;
        remove: ({ channel, timestamp, name, }: {
            channel: string;
            timestamp: string;
            name: string;
        }) => Promise<{
            ok: false;
        } | {
            readonly ok: true;
        }>;
    };
    readonly chat: {
        postMessage: ({ channel, text, thread_ts, }: {
            channel: string;
            text: string;
            thread_ts?: string;
        }) => Promise<{
            ok: false;
            ts: undefined;
            message: undefined;
            data: any;
            error: any;
        } | {
            ok: true;
            ts: any;
            message: any;
            data: any;
            error: undefined;
        }>;
        update: ({ channel, ts, text }: {
            channel: string;
            ts: string;
            text: string;
        }) => Promise<{
            ok: false;
            ts: string;
            error: any;
            data: any;
        } | {
            ok: true;
            ts: any;
            error: undefined;
            data: any;
        }>;
        delete: ({ channel, ts }: {
            channel: string;
            ts: string;
        }) => Promise<{
            ok: false;
            ts: string;
            error: any;
            data: any;
        } | {
            ok: true;
            ts: any;
            error: undefined;
            data: any;
        }>;
    };
    getBotUserId(): Promise<string>;
    /** The bot's bot_id (from auth.test), used to detect own bot_message events */
    _botId?: string;
    /**
     * Fetch user info from Slack API.
     * Returns user profile including guest status flags, email, display name, and timezone.
     */
    getUserInfo(userId: string): Promise<{
        ok: boolean;
        user?: {
            id: string;
            name?: string;
            real_name?: string;
            email?: string;
            is_restricted?: boolean;
            is_ultra_restricted?: boolean;
            is_bot?: boolean;
            is_app_user?: boolean;
            deleted?: boolean;
            tz?: string;
            tz_offset?: number;
        };
    }>;
    /**
     * Open a DM channel with a user.
     * Returns the DM channel ID.
     */
    /**
     * Resolve a channel name (e.g. "function-cve-alerts") to a channel ID.
     * Uses conversations.list with pagination. Results are cached for the process lifetime.
     */
    private channelNameCache;
    resolveChannelName(name: string): Promise<string | undefined>;
    openDM(userId: string): Promise<{
        ok: boolean;
        channel?: string;
    }>;
    fetchThreadReplies(channel: string, thread_ts: string, limit?: number): Promise<Array<{
        ts: string;
        user?: string;
        text?: string;
        bot_id?: string;
        thread_ts?: string;
        files?: any[];
        attachments?: any[];
    }>>;
    readonly files: {
        /**
         * Upload a file to Slack using files.uploadV2 API
         * @param options Upload options including file content, filename, channel, and thread_ts
         */
        uploadV2: ({ content, filename, channel, thread_ts, title, initial_comment, }: {
            content: Buffer;
            filename: string;
            channel: string;
            thread_ts?: string;
            title?: string;
            initial_comment?: string;
        }) => Promise<{
            ok: boolean;
            file?: {
                id: string;
                permalink?: string;
            };
        }>;
    };
    readonly views: {
        publish: ({ user_id, view, }: {
            user_id: string;
            view: Record<string, unknown>;
        }) => Promise<{
            ok: boolean;
            error?: string;
        }>;
    };
    getWebClient(): any;
    private api;
    /** Send a Slack API request as application/x-www-form-urlencoded (required by some file methods). */
    private apiForm;
}
//# sourceMappingURL=client.d.ts.map