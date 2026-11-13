/**
 * Email Frontend for Visor workflows.
 *
 * Mirrors the TelegramFrontend pattern:
 * - Sends AI replies as threaded emails (In-Reply-To, References headers)
 * - Converts Markdown to email HTML format
 * - No reaction equivalent (CheckScheduled is a no-op)
 */
import type { Frontend, FrontendContext } from './host';
type EmailFrontendConfig = {
    send?: {
        type?: string;
        host?: string;
        port?: number;
        auth?: {
            user?: string;
            pass?: string;
        };
        secure?: boolean;
        from?: string;
        api_key?: string;
    };
};
export declare class EmailFrontend implements Frontend {
    readonly name = "email";
    private subs;
    private cfg;
    private errorNotified;
    constructor(config?: EmailFrontendConfig);
    start(ctx: FrontendContext): void;
    stop(): void;
    private getEmailClient;
    private getInboundEmailPayload;
    private maybePostError;
    private maybePostDirectReply;
}
export {};
//# sourceMappingURL=email-frontend.d.ts.map