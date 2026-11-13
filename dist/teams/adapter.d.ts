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
export declare class TeamsAdapter {
    private appId;
    constructor(appId: string);
    /** Check if a message is from the bot itself */
    isFromBot(msg: TeamsMessageInfo): boolean;
    /** Normalize a Teams message into Visor's shared format */
    normalizeMessage(msg: TeamsMessageInfo): NormalizedMessage;
    /** Build a ConversationContext from a Teams message */
    buildConversationContext(msg: TeamsMessageInfo): ConversationContext;
    /**
     * Parse a Bot Framework Activity into TeamsMessageInfo.
     * Returns null for non-message activities or empty text.
     */
    static parseActivity(activity: Activity): TeamsMessageInfo | null;
}
//# sourceMappingURL=adapter.d.ts.map