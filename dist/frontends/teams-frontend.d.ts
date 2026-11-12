/**
 * Microsoft Teams Frontend for Visor workflows.
 *
 * Mirrors the WhatsAppFrontend pattern:
 * - Sends AI replies as Teams text messages
 * - Uses standard Markdown (Teams renders it natively)
 * - No reaction equivalent (CheckScheduled is a no-op)
 */
import type { Frontend, FrontendContext } from './host';
type TeamsFrontendConfig = {
    appId?: string;
    appPassword?: string;
    tenantId?: string;
};
export declare class TeamsFrontend implements Frontend {
    readonly name = "teams";
    private subs;
    private cfg;
    private errorNotified;
    constructor(config?: TeamsFrontendConfig);
    start(ctx: FrontendContext): void;
    stop(): void;
    private getTeams;
    private getInboundTeamsPayload;
    private maybePostError;
    private maybePostDirectReply;
}
export {};
//# sourceMappingURL=teams-frontend.d.ts.map