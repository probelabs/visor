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
            ts: any;
            message: any;
            data: any;
        }>;
        update: ({ channel, ts, text }: {
            channel: string;
            ts: string;
            text: string;
        }) => Promise<{
            ok: false;
            ts: string;
        } | {
            ok: true;
            ts: any;
        }>;
    };
    getBotUserId(): Promise<string>;
    fetchThreadReplies(channel: string, thread_ts: string, limit?: number): Promise<Array<{
        ts: string;
        user?: string;
        text?: string;
        bot_id?: string;
        thread_ts?: string;
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
    getWebClient(): any;
    private api;
}
//# sourceMappingURL=client.d.ts.map