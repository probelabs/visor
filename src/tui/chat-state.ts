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

export class ChatStateManager {
  private _history: ChatMessage[] = [];
  private _isProcessing = false;
  private _waitingState?: WaitingState;
  private _inputQueue: string[] = [];
  private _maxMessages: number;
  private _messageCounter = 0;
  private _statusText = 'Ready';

  constructor(options: ChatStateManagerOptions = {}) {
    this._maxMessages = options.maxMessages ?? 1000;
  }

  get history(): ChatMessage[] {
    return [...this._history];
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get isWaiting(): boolean {
    return this._waitingState !== undefined;
  }

  get waitingState(): WaitingState | undefined {
    return this._waitingState;
  }

  get hasQueuedInput(): boolean {
    return this._inputQueue.length > 0;
  }

  get statusText(): string {
    return this._statusText;
  }

  setStatus(text: string): void {
    this._statusText = text;
  }

  addMessage(
    role: 'user' | 'assistant' | 'system',
    content: string,
    checkId?: string
  ): ChatMessage {
    const message: ChatMessage = {
      id: `msg-${++this._messageCounter}`,
      role,
      content,
      timestamp: new Date(),
      checkId,
    };

    this._history.push(message);

    // Trim history if it exceeds max
    while (this._history.length > this._maxMessages) {
      this._history.shift();
    }

    return message;
  }

  setProcessing(processing: boolean): void {
    this._isProcessing = processing;
    if (processing) {
      this._statusText = 'Processing...';
    } else if (!this._waitingState) {
      this._statusText = 'Ready';
    }
  }

  setWaiting(state: WaitingState | undefined): void {
    this._waitingState = state;
    if (state) {
      this._statusText = 'Awaiting input...';
    } else if (!this._isProcessing) {
      this._statusText = 'Ready';
    }
  }

  clearWaiting(): void {
    this._waitingState = undefined;
    if (!this._isProcessing) {
      this._statusText = 'Ready';
    }
  }

  queueInput(input: string): void {
    this._inputQueue.push(input);
  }

  dequeueInput(): string | undefined {
    return this._inputQueue.shift();
  }

  clearQueue(): void {
    this._inputQueue = [];
  }

  clearHistory(): void {
    this._history = [];
  }

  getRecentMessages(count: number): ChatMessage[] {
    return this._history.slice(-count);
  }

  formatMessageForDisplay(message: ChatMessage): string {
    const time = message.timestamp.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const roleLabel = message.role === 'user' ? 'You' : 'Assistant';
    return `${roleLabel}: [${time}]\n${message.content}`;
  }

  formatHistoryForDisplay(): string {
    if (this._history.length === 0) {
      return 'No messages yet. Type a message to start...';
    }

    const separator = '\n\n';
    return this._history.map(msg => this.formatMessageForDisplay(msg)).join(separator);
  }
}

// Singleton instance for global access
let globalStateManager: ChatStateManager | undefined;

export function getChatStateManager(): ChatStateManager {
  if (!globalStateManager) {
    globalStateManager = new ChatStateManager();
  }
  return globalStateManager;
}

export function setChatStateManager(manager: ChatStateManager): void {
  globalStateManager = manager;
}

export function resetChatStateManager(): void {
  globalStateManager = undefined;
}
