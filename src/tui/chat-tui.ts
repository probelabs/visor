/**
 * ChatTUI - Main Chat Interface Manager
 *
 * Provides a persistent chat interface similar to Claude Code/Codex.
 * Features:
 * - Always-visible input bar at bottom
 * - Scrollable chat history with user/assistant distinction
 * - Tab switching between chat and logs
 * - Status bar with mode indicators
 */
import blessed from 'blessed';
import { ChatBox } from './components/chat-box';
import { InputBar } from './components/input-bar';
import { StatusBar, StatusMode } from './components/status-bar';
import { TraceViewer } from './components/trace-viewer';
import { ChatStateManager, ChatMessage } from './chat-state';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;
type Log = blessed.Widgets.Log;

type ConsoleMethods = Pick<Console, 'log' | 'error' | 'warn' | 'info'>;

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

function splitLines(input: string): string[] {
  if (!input) return [];
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.split('\n');
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map(item => {
      if (typeof item === 'string') return item;
      try {
        return JSON.stringify(item, null, 2);
      } catch {
        return String(item);
      }
    })
    .join(' ');
}

export interface ChatTUIOptions {
  stateManager?: ChatStateManager;
  onMessageSubmit?: (message: string) => void | Promise<void>;
  onExit?: () => void;
  traceFilePath?: string;
}

export class ChatTUI {
  private screen?: Screen;
  private mainPane?: Box;
  private logsPane?: Box;
  private tracesPane?: Box;
  private chatBox?: ChatBox;
  private inputBar?: InputBar;
  private statusBar?: StatusBar;
  private logsStatusBar?: StatusBar;
  private tracesStatusBar?: StatusBar;
  private logsBox?: Log;
  private traceViewer?: TraceViewer;
  private activeTab: 'chat' | 'logs' | 'traces' = 'chat';

  private stateManager: ChatStateManager;
  private onMessageSubmit?: (message: string) => void | Promise<void>;
  private onExit?: () => void;
  private traceFilePath?: string;

  private consoleRestore?: () => void;
  private consoleExitHandler?: () => void;
  private processExitHandler?: () => void;
  private abortHandler?: () => void;

  private pendingLogs: string[] = [];
  private running = false;

  constructor(options: ChatTUIOptions = {}) {
    this.stateManager = options.stateManager ?? new ChatStateManager();
    this.onMessageSubmit = options.onMessageSubmit;
    this.onExit = options.onExit;
    this.traceFilePath = options.traceFilePath;
  }

  getStateManager(): ChatStateManager {
    return this.stateManager;
  }

  setTraceFile(path: string): void {
    this.traceFilePath = path;
    if (this.traceViewer) {
      this.traceViewer.setTraceFile(path);
    }
  }

  start(): void {
    if (this.screen) return;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Visor Chat',
      dockBorders: true,
    });

    // Main pane for chat view
    this.mainPane = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
    });

    // Logs pane (hidden by default)
    this.logsPane = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      hidden: true,
    });

    // Traces pane (hidden by default)
    this.tracesPane = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      hidden: true,
    });

    // Create chat box
    this.chatBox = new ChatBox({
      parent: this.mainPane,
    });

    // Create input bar
    this.inputBar = new InputBar({
      parent: this.mainPane,
      onSubmit: (value: string) => this.handleInputSubmit(value),
      onEscape: () => this.handleInputEscape(),
      onTab: () => this.toggleTab(),
      onAbort: () => {
        if (this.abortHandler) {
          this.abortHandler();
        } else {
          this.stop();
          process.exit(0);
        }
      },
    });

    // Create status bar
    this.statusBar = new StatusBar({
      parent: this.mainPane,
    });

    // Create logs box (leave room for status bar at bottom)
    this.logsBox = blessed.log({
      parent: this.logsPane,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-1',
      label: ' Logs ',
      border: { type: 'line' },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      tags: false,
      wrap: true,
      scrollbar: {
        ch: ' ',
      },
    });

    // Create status bar for logs pane
    this.logsStatusBar = new StatusBar({
      parent: this.logsPane,
    });

    // Create trace viewer (leave room for status bar at bottom)
    this.traceViewer = new TraceViewer({
      parent: this.tracesPane!,
      traceFilePath: this.traceFilePath,
    });

    // Create status bar for traces pane
    this.tracesStatusBar = new StatusBar({
      parent: this.tracesPane,
    });

    // Start watching the trace file if path is provided
    if (this.traceFilePath) {
      this.traceViewer.startWatching();
    }

    // Setup key bindings
    this.setupKeyBindings();

    // Setup exit handlers
    // Note: Don't register processExitHandler during workflow - it interferes with normal exit
    // this.processExitHandler = () => this.stop();
    // process.once('exit', this.processExitHandler);

    // Show initial content
    this.chatBox.setContent(this.stateManager.formatHistoryForDisplay());
    this.updateStatusBar();

    // Process pending logs
    if (this.pendingLogs.length > 0) {
      for (const line of this.pendingLogs) {
        this.appendLog(line);
      }
      this.pendingLogs = [];
    }

    // Focus input bar
    this.inputBar.focus();
    this.screen.render();
  }

  private setupKeyBindings(): void {
    if (!this.screen) return;

    // Tab switching (Shift+Tab to cycle, number keys for direct access)
    this.screen.key(['S-tab'], () => this.toggleTab());
    this.screen.key(['1'], () => this.setActiveTab('chat'));
    this.screen.key(['2'], () => this.setActiveTab('logs'));
    this.screen.key(['3'], () => this.setActiveTab('traces'));

    // Trace viewer controls (only active when on traces tab)
    this.screen.key(['e'], () => {
      if (this.activeTab === 'traces' && this.traceViewer) {
        this.traceViewer.toggleEngineStates();
      }
    });

    // Exit handling
    this.screen.key(['q'], () => {
      if (this.running) {
        this.setStatus('Still running. Press Ctrl+C to abort.');
        return;
      }
      this.onExit?.();
    });

    this.screen.key(['C-c'], () => {
      if (this.abortHandler) {
        this.abortHandler();
        return;
      }
      this.stop();
      process.exit(0);
    });

    // Screen resize
    this.screen.on('resize', () => {
      this.updateLayout();
      this.updateStatusBar();
      this.screen?.render();
    });
  }

  stop(): void {
    if (this.consoleRestore) {
      this.consoleRestore();
      this.consoleRestore = undefined;
    }
    if (this.processExitHandler) {
      process.removeListener('exit', this.processExitHandler);
      this.processExitHandler = undefined;
    }
    // Clean up trace viewer to stop file watching
    if (this.traceViewer) {
      this.traceViewer.destroy();
      this.traceViewer = undefined;
    }
    // Clean up input bar to cancel any active input sessions
    if (this.inputBar) {
      this.inputBar.destroy();
      this.inputBar = undefined;
    }
    if (this.screen) {
      this.screen.destroy();
      this.screen = undefined;
    }
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (running) {
      this.statusBar?.setMode('processing');
      this.inputBar?.disable();
    } else {
      this.statusBar?.setMode('ready');
      this.inputBar?.enable();
      this.inputBar?.focus();
    }
    this.updateStatusBar();
  }

  setProcessing(processing: boolean): void {
    this.stateManager.setProcessing(processing);
    if (processing) {
      this.statusBar?.setMode('processing');
      this.inputBar?.disable();
    } else if (this.stateManager.isWaiting) {
      this.statusBar?.setMode('waiting');
      this.inputBar?.enable();
      this.inputBar?.focus();
    } else {
      this.statusBar?.setMode('ready');
      this.inputBar?.enable();
      this.inputBar?.focus();
    }
    this.screen?.render();
  }

  setWaiting(waiting: boolean, prompt?: string): void {
    if (waiting && prompt) {
      this.stateManager.setWaiting({
        checkId: '',
        prompt,
      });
      this.statusBar?.setMode('waiting');
      this.inputBar?.setPlaceholder(prompt);
      this.inputBar?.enable();
      this.inputBar?.focus();
    } else {
      this.stateManager.clearWaiting();
      this.statusBar?.setMode('ready');
      this.inputBar?.setPlaceholder('Type a message...');
    }
    this.screen?.render();
  }

  setStatus(text: string): void {
    this.stateManager.setStatus(text);
    this.statusBar?.setStatus(text);
    this.screen?.render();
  }

  setAbortHandler(handler?: () => void): void {
    this.abortHandler = handler;
  }

  addUserMessage(content: string): ChatMessage {
    const message = this.stateManager.addMessage('user', content);
    this.chatBox?.appendMessage(message);
    this.screen?.render();
    return message;
  }

  addAssistantMessage(content: string, checkId?: string): ChatMessage {
    const message = this.stateManager.addMessage('assistant', content, checkId);
    this.chatBox?.appendMessage(message);
    this.screen?.render();
    return message;
  }

  addSystemMessage(content: string): ChatMessage {
    const message = this.stateManager.addMessage('system', content);
    this.chatBox?.appendMessage(message);
    this.screen?.render();
    return message;
  }

  refreshChat(): void {
    const content = this.stateManager.formatHistoryForDisplay();
    this.chatBox?.setContent(content);
    this.screen?.render();
  }

  appendLog(line: string): void {
    if (!line) return;
    const lines = splitLines(stripAnsi(line));
    if (!this.logsBox) {
      this.pendingLogs.push(...lines);
      return;
    }
    for (const item of lines) {
      if (item.length === 0) continue;
      this.logsBox.log(item);
    }
    this.screen?.render();
  }

  captureConsole(): () => void {
    const original: ConsoleMethods = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };

    if (this.consoleRestore) return this.consoleRestore;

    const toLog = (...args: unknown[]) => this.appendLog(formatConsoleArgs(args));

    console.log = (...args: unknown[]) => toLog(...args);
    console.error = (...args: unknown[]) => toLog(...args);
    console.warn = (...args: unknown[]) => toLog(...args);
    console.info = (...args: unknown[]) => toLog(...args);

    let restored = false;
    this.consoleRestore = () => {
      if (restored) return;
      restored = true;
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      console.info = original.info;
      if (this.consoleExitHandler) {
        process.removeListener('exit', this.consoleExitHandler);
        this.consoleExitHandler = undefined;
      }
    };

    this.consoleExitHandler = () => {
      if (this.consoleRestore) this.consoleRestore();
    };
    process.once('exit', this.consoleExitHandler);

    return this.consoleRestore;
  }

  waitForExit(timeoutMs?: number): Promise<void> {
    if (!this.screen) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.stop();
        resolve();
      };

      // Store original onExit and wrap it
      const originalOnExit = this.onExit;
      this.onExit = () => {
        originalOnExit?.();
        finish();
      };

      if (timeoutMs !== undefined) {
        if (timeoutMs <= 0) {
          finish();
          return;
        }
        const timer = setTimeout(finish, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    });
  }

  /**
   * Prompt user for input and return the result.
   * This is used for human-input checks that require a response.
   */
  async promptUser(options: {
    prompt: string;
    placeholder?: string;
    multiline?: boolean;
    timeout?: number;
    defaultValue?: string;
    allowEmpty?: boolean;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.screen || !this.inputBar) {
        reject(new Error('TUI not initialized'));
        return;
      }

      this.setActiveTab('chat');

      // Set waiting state
      this.stateManager.setWaiting({
        checkId: 'prompt',
        prompt: options.prompt,
        placeholder: options.placeholder,
        multiline: options.multiline,
        timeout: options.timeout,
        defaultValue: options.defaultValue,
        allowEmpty: options.allowEmpty,
      });

      // Update UI
      this.statusBar?.setMode('waiting');
      this.inputBar?.setPlaceholder(options.placeholder || options.prompt);
      this.inputBar?.enable();
      this.inputBar?.focus();

      // Add prompt to chat as system message
      this.addSystemMessage(`[Prompt] ${options.prompt}`);

      let done = false;
      let timeoutId: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        this.stateManager.clearWaiting();
        this.statusBar?.setMode('ready');
        this.inputBar?.setPlaceholder('Type a message...');
        // Remove the temporary submit handler
        this.onMessageSubmit = this._originalSubmitHandler;
      };

      const finish = (value?: string, error?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve(value ?? '');
      };

      // Store original submit handler
      this._originalSubmitHandler = this.onMessageSubmit;

      // Set temporary submit handler for this prompt
      this.onMessageSubmit = async (value: string) => {
        const trimmed = (value || '').trim();
        if (!trimmed && !options.allowEmpty && options.defaultValue === undefined) {
          this.setStatus('Input required');
          return;
        }
        finish(trimmed || options.defaultValue || '');
      };

      // Set up timeout
      if (options.timeout && options.timeout > 0) {
        timeoutId = setTimeout(() => {
          if (options.defaultValue !== undefined) {
            finish(options.defaultValue);
          } else {
            finish(undefined, new Error('Input timeout'));
          }
        }, options.timeout);
        if (typeof (timeoutId as any).unref === 'function') {
          (timeoutId as any).unref();
        }
      }

      this.screen?.render();
    });
  }

  private _originalSubmitHandler?: (message: string) => void | Promise<void>;

  private handleInputSubmit(value: string): void {
    if (!value.trim()) return;

    // Add user message to chat
    this.addUserMessage(value);

    // Call the submit handler
    this.onMessageSubmit?.(value);

    // Note: Don't refocus here - the caller (promptUser or workflow) will manage focus
    // This prevents conflicts that cause input duplication
  }

  private handleInputEscape(): void {
    this.inputBar?.clear();
  }

  private toggleTab(): void {
    const tabs: Array<'chat' | 'logs' | 'traces'> = ['chat', 'logs', 'traces'];
    const currentIndex = tabs.indexOf(this.activeTab);
    const nextIndex = (currentIndex + 1) % tabs.length;
    this.setActiveTab(tabs[nextIndex]);
  }

  private setActiveTab(tab: 'chat' | 'logs' | 'traces'): void {
    this.activeTab = tab;

    // Update all status bars to show the current tab
    this.statusBar?.setActiveTab(tab);
    this.logsStatusBar?.setActiveTab(tab);
    this.tracesStatusBar?.setActiveTab(tab);

    if (this.mainPane && this.logsPane && this.tracesPane) {
      // Hide all panes first
      this.mainPane.hide();
      this.logsPane.hide();
      this.tracesPane.hide();

      // Show the active pane
      if (tab === 'chat') {
        this.mainPane.show();
        this.inputBar?.focus();
      } else if (tab === 'logs') {
        this.logsPane.show();
        this.logsBox?.focus();
      } else {
        this.tracesPane.show();
        this.traceViewer?.focus();
      }
    }

    // Force full screen redraw to clear artifacts
    this.screen?.realloc();
    this.screen?.render();
  }

  private updateLayout(): void {
    // Layout is handled by the components' relative positioning
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;

    const mode: StatusMode = this.stateManager.isProcessing
      ? 'processing'
      : this.stateManager.isWaiting
        ? 'waiting'
        : 'ready';

    this.statusBar.setMode(mode);
    this.statusBar.setStatus(this.stateManager.statusText);
    this.screen?.render();
  }
}
