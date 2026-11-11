import type { ConversationContext, NormalizedMessage } from '../types/bot';
import type { EmailMessage } from './client';
/** Thread state tracking */
export interface EmailThread {
    threadId: string;
    rootMessageId: string;
    messageIds: string[];
    messages: NormalizedMessage[];
    participants: Set<string>;
    subject: string;
    lastActivity: Date;
}
export declare class EmailAdapter {
    private fromAddress;
    private threads;
    private messageIdToThread;
    constructor(fromAddress: string);
    /** Extract email address from "Name <email>" format */
    static extractEmail(addr: string): string;
    /** Check if a message is from the bot */
    isFromBot(msg: EmailMessage): boolean;
    /** Find or create a thread for a message */
    getOrCreateThread(msg: EmailMessage): EmailThread;
    /** Register a message in its thread and return updated thread */
    trackMessage(msg: EmailMessage): EmailThread;
    /** Normalize an EmailMessage to NormalizedMessage */
    normalizeMessage(msg: EmailMessage): NormalizedMessage;
    /** Build ConversationContext from an EmailMessage */
    buildConversationContext(msg: EmailMessage): ConversationContext;
    /** Get thread state by ID */
    getThread(threadId: string): EmailThread | undefined;
    /** Get thread by Message-ID */
    getThreadByMessageId(messageId: string): EmailThread | undefined;
    /** Clean up old threads to prevent memory leaks */
    cleanupOldThreads(maxAgeMs?: number): void;
}
//# sourceMappingURL=adapter.d.ts.map