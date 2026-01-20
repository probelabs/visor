/**
 * Slack Frontend for Visor workflows.
 *
 * Features:
 * - Posts AI replies to Slack threads
 * - Converts Markdown to Slack mrkdwn format
 * - Renders mermaid diagrams to PNG and uploads as images
 * - Manages 👀/👍 reactions for acknowledgement
 * - Handles human input prompts via prompt-state
 *
 * Mermaid Diagram Rendering:
 * - Detects ```mermaid code blocks in AI responses
 * - Renders to PNG using @mermaid-js/mermaid-cli (mmdc)
 * - Uploads rendered images to Slack thread
 * - Replaces mermaid blocks with "_(See diagram above)_" placeholder
 *
 * Requirements for mermaid rendering:
 * - Node.js and npx in PATH
 * - Puppeteer/Chromium dependencies (mermaid-cli uses headless browser)
 * - On Linux: apt-get install chromium-browser libatk-bridge2.0-0 libgtk-3-0
 */
import type { Frontend, FrontendContext } from './host';
type SlackFrontendConfig = {
    defaultChannel?: string;
    groupChannels?: Record<string, string>;
    debounceMs?: number;
    maxWaitMs?: number;
    showRawOutput?: boolean;
    telemetry?: {
        enabled?: boolean;
    };
};
export declare class SlackFrontend implements Frontend {
    readonly name = "slack";
    private subs;
    private cfg;
    private acked;
    private ackRef;
    private ackName;
    private doneName;
    constructor(config?: SlackFrontendConfig);
    start(ctx: FrontendContext): void;
    stop(): void;
    private getSlack;
    private getInboundSlackPayload;
    private getInboundSlackEvent;
    private ensureAcknowledgement;
    private finalizeReactions;
    /**
     * Post direct replies into the originating Slack thread when appropriate.
     * This is independent of summary messages and is intended for chat-style flows
     * (e.g., AI answers and explicit chat/notify steps).
     */
    private maybePostDirectReply;
    private getTraceInfo;
}
export {};
//# sourceMappingURL=slack-frontend.d.ts.map