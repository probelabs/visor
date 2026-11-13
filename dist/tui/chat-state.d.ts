/**
 * Chat State Manager for TUI
 *
 * Manages chat message history, processing state, and human-input waiting state.
 */
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    checkId?: string;
}
export interface WaitingState {
    checkId: string;
    prompt: string;
    placeholder?: string;
    multiline?: boolean;
    timeout?: number;
    defaultValue?: string;
    allowEmpty?: boolean;
}
export interface ChatStateManagerOptions {
    maxMessages?: number;
}
export declare class ChatStateManager {
    private _history;
    private _isProcessing;
    private _waitingState?;
    private _inputQueue;
    private _maxMessages;
    private _messageCounter;
    private _statusText;
    constructor(options?: ChatStateManagerOptions);
    get history(): ChatMessage[];
    get isProcessing(): boolean;
    get isWaiting(): boolean;
    get waitingState(): WaitingState | undefined;
    get hasQueuedInput(): boolean;
    get statusText(): string;
    setStatus(text: string): void;
    addMessage(role: 'user' | 'assistant' | 'system', content: string, checkId?: string): ChatMessage;
    setProcessing(processing: boolean): void;
    setWaiting(state: WaitingState | undefined): void;
    clearWaiting(): void;
    queueInput(input: string): void;
    dequeueInput(): string | undefined;
    clearQueue(): void;
    clearHistory(): void;
    getRecentMessages(count: number): ChatMessage[];
    formatMessageForDisplay(message: ChatMessage): string;
    private escapeTags;
    formatHistoryForDisplay(): string;
}
export declare function getChatStateManager(): ChatStateManager;
export declare function setChatStateManager(manager: ChatStateManager): void;
export declare function resetChatStateManager(): void;
//# sourceMappingURL=chat-state.d.ts.map