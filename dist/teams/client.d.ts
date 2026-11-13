import { CloudAdapter } from 'botbuilder';
import type { ConversationReference } from 'botbuilder';
export interface TeamsSendResult {
    ok: boolean;
    activityId?: string;
    error?: string;
}
export interface TeamsClientOptions {
    appId: string;
    appPassword: string;
    tenantId?: string;
}
export declare class TeamsClient {
    private appId;
    private appPassword;
    private tenantId?;
    private adapter;
    constructor(opts: TeamsClientOptions);
    /** Get the underlying CloudAdapter (used by webhook runner for processing inbound) */
    getAdapter(): CloudAdapter;
    /** Get the configured App ID */
    getAppId(): string;
    /**
     * Send a text message using a stored conversation reference.
     * Auto-chunks at 28000 characters.
     */
    sendMessage(opts: {
        conversationReference: ConversationReference;
        text: string;
        replyToActivityId?: string;
    }): Promise<TeamsSendResult>;
    /**
     * Update an existing bot message.
     * For safety, only supports single-activity payloads. Oversized content returns msg_too_long.
     */
    updateMessage(opts: {
        conversationReference: ConversationReference;
        activityId: string;
        text: string;
    }): Promise<TeamsSendResult>;
    /**
     * Delete a previously sent bot message.
     */
    deleteMessage(opts: {
        conversationReference: ConversationReference;
        activityId: string;
    }): Promise<boolean>;
}
//# sourceMappingURL=client.d.ts.map