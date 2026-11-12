/**
 * WhatsApp Frontend for Visor workflows.
 *
 * Mirrors the TelegramFrontend pattern:
 * - Sends AI replies as WhatsApp text messages
 * - Converts Markdown to WhatsApp format
 * - No reaction equivalent (CheckScheduled is a no-op)
 */
import type { Frontend, FrontendContext } from './host';
type WhatsAppFrontendConfig = {
    accessToken?: string;
    phoneNumberId?: string;
};
export declare class WhatsAppFrontend implements Frontend {
    readonly name = "whatsapp";
    private subs;
    private cfg;
    private errorNotified;
    constructor(config?: WhatsAppFrontendConfig);
    start(ctx: FrontendContext): void;
    stop(): void;
    private getWhatsApp;
    private getInboundWhatsAppPayload;
    private maybePostError;
    private maybePostDirectReply;
}
export {};
//# sourceMappingURL=whatsapp-frontend.d.ts.map