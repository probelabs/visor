/**
 * TUI Frontend for Visor workflows.
 *
 * Subscribes to EventBus events and updates the ChatTUI accordingly:
 * - CheckCompleted → Display AI response in chat
 * - HumanInputRequested → Set waiting state, update placeholder
 * - StateTransition → Update status bar
 * - CheckErrored → Display error message
 */
import type { Frontend, FrontendContext } from '../frontends/host';
import { ChatTUI } from './chat-tui';
export interface TuiFrontendConfig {
    chatTui?: ChatTUI;
}
export declare class TuiFrontend implements Frontend {
    readonly name = "tui";
    private subs;
    private chatTui?;
    constructor(config?: TuiFrontendConfig);
    setChatTUI(tui: ChatTUI): void;
    start(ctx: FrontendContext): void;
    stop(): void;
    private handleCheckCompleted;
    private handleError;
    private handleHumanInputRequested;
    private handleStateTransition;
    private handleShutdown;
}
//# sourceMappingURL=tui-frontend.d.ts.map