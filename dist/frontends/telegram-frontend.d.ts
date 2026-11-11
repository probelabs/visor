/**
 * Telegram Frontend for Visor workflows.
 *
 * Mirrors the SlackFrontend pattern:
 * - Posts AI replies to Telegram chats
 * - Converts Markdown to Telegram HTML format
 * - Manages emoji reactions for acknowledgement (👀 → 👍)
 */
import type { Frontend, FrontendContext } from './host';
type TelegramFrontendConfig = {
    defaultChatId?: string | number;
    botToken?: string;
};
export declare class TelegramFrontend implements Frontend {
    readonly name = "telegram";
    private subs;
    private cfg;
    private acked;
    private ackRef;
    private errorNotified;
    constructor(config?: TelegramFrontendConfig);
    start(ctx: FrontendContext): void;
    stop(): void;
    private getTelegram;
    private getInboundTelegramPayload;
    private getInboundTelegramEvent;
    private ensureAcknowledgement;
    private finalizeReactions;
    private maybePostError;
    private maybePostDirectReply;
}
export {};
//# sourceMappingURL=telegram-frontend.d.ts.map