/**
 * ChatBox Component
 *
 * Displays scrollable chat message history with user/assistant distinction.
 */
import blessed from 'blessed';
import type { ChatMessage } from '../chat-state';
type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;
export interface ChatBoxOptions {
    parent: Box;
}
export declare class ChatBox {
    private box;
    private parent;
    private _progressTimer?;
    private _elapsedSeconds;
    private _baseContent;
    constructor(options: ChatBoxOptions);
    getElement(): Box;
    focus(): void;
    setContent(content: string): void;
    appendMessage(message: ChatMessage): void;
    showProgress(): void;
    hideProgress(): void;
    private _isProgressing;
    private _progressLine;
    private _renderProgress;
    scrollToBottom(): void;
    scrollUp(lines?: number): void;
    scrollDown(lines?: number): void;
    clear(): void;
    show(): void;
    hide(): void;
    private formatMessage;
    private escapeTags;
    setHeight(height: number | string): void;
    setTop(top: number | string): void;
    render(screen: Screen): void;
}
export {};
//# sourceMappingURL=chat-box.d.ts.map