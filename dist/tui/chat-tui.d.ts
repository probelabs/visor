import { ChatStateManager, ChatMessage } from './chat-state';
export interface ChatTUIOptions {
    stateManager?: ChatStateManager;
    onMessageSubmit?: (message: string) => void | Promise<void>;
    onExit?: () => void;
    traceFilePath?: string;
}
export declare class ChatTUI {
    private screen?;
    private mainPane?;
    private logsPane?;
    private tracesPane?;
    private chatBox?;
    private inputBar?;
    private statusBar?;
    private logsBox?;
    private traceViewer?;
    private activeTab;
    private stateManager;
    private onMessageSubmit?;
    private onExit?;
    private traceFilePath?;
    private consoleRestore?;
    private consoleExitHandler?;
    private processExitHandler?;
    private abortHandler?;
    private pendingLogs;
    private running;
    private mouseEnabled;
    private _renderScheduled;
    private static readonly MAX_PENDING_LOGS;
    constructor(options?: ChatTUIOptions);
    getStateManager(): ChatStateManager;
    /**
     * Coalesce all render requests into at most one per 50ms to prevent
     * the TUI from freezing under heavy output (AI streaming, MCP calls, etc.).
     */
    private _scheduleRender;
    setTraceFile(path: string): void;
    start(): void;
    private setupKeyBindings;
    stop(): void;
    setRunning(running: boolean): void;
    private toggleMouseMode;
    setProcessing(processing: boolean): void;
    setWaiting(waiting: boolean, prompt?: string): void;
    setStatus(text: string): void;
    setAbortHandler(handler?: () => void): void;
    addUserMessage(content: string): ChatMessage;
    addAssistantMessage(content: string, checkId?: string): ChatMessage;
    addSystemMessage(content: string): ChatMessage;
    refreshChat(): void;
    appendLog(line: string): void;
    captureConsole(): () => void;
    waitForExit(timeoutMs?: number): Promise<void>;
    /**
     * Prompt user for input and return the result.
     * This is used for human-input checks that require a response.
     */
    promptUser(options: {
        prompt: string;
        placeholder?: string;
        multiline?: boolean;
        timeout?: number;
        defaultValue?: string;
        allowEmpty?: boolean;
    }): Promise<string>;
    private _originalSubmitHandler?;
    private handleInputSubmit;
    private handleInputEscape;
    private toggleTab;
    private setActiveTab;
    private _flushPendingLogs;
    private updateLayout;
    private updateStatusBar;
}
//# sourceMappingURL=chat-tui.d.ts.map