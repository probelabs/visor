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

// Blessed (unmaintained since 2017) crashes during screen.destroy() because its
// layout getters access this.parent properties on elements whose parent is already
// null. This monkey-patch guards all six layout methods against null parent.
const BlessedElement = (blessed as any).widget?.Element?.prototype;
if (BlessedElement) {
  for (const method of [
    '_getWidth',
    '_getHeight',
    '_getLeft',
    '_getRight',
    '_getTop',
    '_getBottom',
  ]) {
    const orig = BlessedElement[method];
    if (typeof orig === 'function') {
      BlessedElement[method] = function (this: any, ...args: any[]) {
        if (!this.parent) return 0;
        return orig.apply(this, args);
      };
    }
  }
}

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
  private mouseEnabled = true; // Mouse enabled for scrolling, hold Shift to select text
  private _renderScheduled = false;
  private static readonly MAX_PENDING_LOGS = 5000;

  constructor(options: ChatTUIOptions = {}) {
    this.stateManager = options.stateManager ?? new ChatStateManager();
    this.onMessageSubmit = options.onMessageSubmit;
    this.onExit = options.onExit;
    this.traceFilePath = options.traceFilePath;
  }

  getStateManager(): ChatStateManager {
    return this.stateManager;
  }

  /**
   * Coalesce all render requests into at most one per 50ms to prevent
   * the TUI from freezing under heavy output (AI streaming, MCP calls, etc.).
   */
  private _scheduleRender(): void {
    if (this._renderScheduled || !this.screen) return;
    this._renderScheduled = true;
    setTimeout(() => {
      this._renderScheduled = false;
      this.screen?.render();
    }, 50);
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

    // Create input bar (with resize callback to adjust chat box height)
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
      onResize: (height: number) => {
        // Adjust chat box height: screen height - inputBar height - status bar (1)
        this.chatBox?.setHeight(`100%-${height + 1}`);
        this._scheduleRender();
      },
    });

    // Create logs box (leave room for status bar at bottom)
    this.logsBox = blessed.log({
      parent: this.logsPane,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-1',
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      tags: false,
      wrap: true,
      scrollbar: {
        ch: ' ',
      },
    });

    // Create trace viewer (leave room for status bar at bottom)
    this.traceViewer = new TraceViewer({
      parent: this.tracesPane!,
      traceFilePath: this.traceFilePath,
    });

    // Create single screen-level status bar (visible across all panes)
    this.statusBar = new StatusBar({
      parent: this.screen,
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

    // Tab switching (Shift+Tab to cycle)
    this.screen.key(['S-tab'], () => this.toggleTab());

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

    // Toggle mouse mode (m) - allows text selection when disabled
    this.screen.key(['m'], () => {
      this.toggleMouseMode();
    });

    // Screen resize
    this.screen.on('resize', () => {
      this.updateLayout();
      this.updateStatusBar();
      this._scheduleRender();
    });

    // Re-focus input on any click within the main pane
    this.mainPane?.on('click', () => {
      if (this.activeTab === 'chat' && this.inputBar && !this.running) {
        this.inputBar.focus();
      }
    });
  }

  stop(): void {
    if (this.processExitHandler) {
      process.removeListener('exit', this.processExitHandler);
      this.processExitHandler = undefined;
    }
    // Clean up chat box progress timer
    if (this.chatBox) {
      this.chatBox.hideProgress();
    }
    // Clean up status bar
    if (this.statusBar) {
      this.statusBar.destroy();
      this.statusBar = undefined;
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
      const program = (this.screen as any).program;
      try {
        this.screen.destroy();
      } catch {
        try {
          program?.destroy();
        } catch {}
      }
      this.screen = undefined;
    }

    // Restore console AFTER screen.destroy() so blessed's cleanup
    // writes (which go through our patched program._owrite → original
    // stdout) still work during destroy.
    if (this.consoleRestore) {
      this.consoleRestore();
      this.consoleRestore = undefined;
    }

    // Write reset sequences directly to fd — at this point stdout.write
    // is restored to the original, so this is safe and guaranteed to
    // reach the terminal regardless of any remaining blessed state.
    const reset =
      '\x1b[?1000l' + // Disable normal mouse tracking
      '\x1b[?1002l' + // Disable button-event mouse tracking
      '\x1b[?1003l' + // Disable any-event mouse tracking
      '\x1b[?1006l' + // Disable SGR extended mouse mode
      '\x1b[?1049l' + // Exit alternate screen buffer
      '\x1b[?25h' + // Show cursor
      '\x1b[0m' + // Reset SGR attributes
      '\x1bc'; // Full terminal reset (RIS)
    try {
      process.stdout.write(reset);
    } catch {}
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (running) {
      this.statusBar?.setMode('processing');
      this.inputBar?.disable();
      this.chatBox?.showProgress();
    } else {
      this.statusBar?.setMode('ready');
      this.chatBox?.hideProgress();
      this.inputBar?.enable();
      this.inputBar?.focus();
    }
    this.updateStatusBar();
  }

  private toggleMouseMode(): void {
    this.mouseEnabled = !this.mouseEnabled;

    // Toggle mouse tracking at the program level
    const program = (this.screen as any)?.program;
    if (program) {
      if (this.mouseEnabled) {
        program.enableMouse();
      } else {
        program.disableMouse();
      }
    }

    // Show status message
    const status = this.mouseEnabled
      ? 'Mouse scroll ON (Shift+drag to select text)'
      : 'Mouse scroll OFF (use PgUp/PgDn to scroll)';
    this.setStatus(status);
    this._scheduleRender();
  }

  setProcessing(processing: boolean): void {
    this.stateManager.setProcessing(processing);
    if (processing) {
      this.statusBar?.setMode('processing');
      this.inputBar?.disable();
      this.chatBox?.showProgress();
    } else if (this.stateManager.isWaiting) {
      this.statusBar?.setMode('waiting');
      this.chatBox?.hideProgress();
      this.inputBar?.enable();
      this.inputBar?.focus();
    } else {
      this.statusBar?.setMode('ready');
      this.chatBox?.hideProgress();
      this.inputBar?.enable();
      this.inputBar?.focus();
    }
    this._scheduleRender();
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
    this._scheduleRender();
  }

  setStatus(text: string): void {
    this.stateManager.setStatus(text);
    this.statusBar?.setStatus(text);
    this._scheduleRender();
  }

  setAbortHandler(handler?: () => void): void {
    this.abortHandler = handler;
  }

  addUserMessage(content: string): ChatMessage {
    const message = this.stateManager.addMessage('user', content);
    this.chatBox?.appendMessage(message);
    this._scheduleRender();
    return message;
  }

  addAssistantMessage(content: string, checkId?: string): ChatMessage {
    const message = this.stateManager.addMessage('assistant', content, checkId);
    this.chatBox?.appendMessage(message);
    this._scheduleRender();
    return message;
  }

  addSystemMessage(content: string): ChatMessage {
    const message = this.stateManager.addMessage('system', content);
    this.chatBox?.appendMessage(message);
    this._scheduleRender();
    return message;
  }

  refreshChat(): void {
    const content = this.stateManager.formatHistoryForDisplay();
    this.chatBox?.setContent(content);
    this._scheduleRender();
  }

  appendLog(line: string): void {
    if (!line) return;
    const lines = splitLines(stripAnsi(line));
    if (!this.logsBox) {
      this.pendingLogs.push(...lines);
      if (this.pendingLogs.length > ChatTUI.MAX_PENDING_LOGS) {
        this.pendingLogs = this.pendingLogs.slice(-ChatTUI.MAX_PENDING_LOGS);
      }
      return;
    }
    // Buffer logs when not viewing the logs tab to avoid blessed's
    // Log.log() triggering screen.render() on every line, which
    // corrupts the chat pane under heavy output.
    if (this.activeTab !== 'logs') {
      this.pendingLogs.push(...lines.filter(l => l.length > 0));
      if (this.pendingLogs.length > ChatTUI.MAX_PENDING_LOGS) {
        this.pendingLogs = this.pendingLogs.slice(-ChatTUI.MAX_PENDING_LOGS);
      }
      return;
    }
    for (const item of lines) {
      if (item.length === 0) continue;
      this.logsBox.log(item);
    }
    this._scheduleRender();
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

    // Intercept raw stdout/stderr writes (MCP libs, debug modules, etc.)
    // Blessed owns stdout for rendering — any foreign write corrupts the screen.
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    // Blessed renders via program._owrite → this.output.write(text) where
    // output === process.stdout. We re-route blessed to call the saved
    // original directly, then replace process.stdout.write with our
    // interceptor so every other caller gets captured.
    const program = (this.screen as any)?.program;
    if (program) {
      program._owrite = program.write = function (text: string) {
        if (!program.output?.writable) return;
        return origStdoutWrite(text);
      };
    }

    const makeInterceptor = (
      _origWrite: typeof process.stdout.write
    ): typeof process.stdout.write => {
      return function (this: any, chunk: any, encodingOrCb?: any, cb?: any): boolean {
        // Redirect to the logs buffer
        const text =
          typeof chunk === 'string'
            ? chunk
            : chunk.toString(typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8');
        if (text.trim()) {
          toLog(text);
        }
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (callback) callback();
        return true;
      } as typeof process.stdout.write;
    };

    process.stdout.write = makeInterceptor(origStdoutWrite);
    process.stderr.write = makeInterceptor(origStderrWrite);

    // Patch MCP SDK's StdioClientTransport to never inherit stderr.
    // Child processes with stdio:'inherit' write directly to fd 1/2,
    // bypassing our Node.js write() interceptors and corrupting blessed.
    let origStdioStart: ((...args: any[]) => any) | undefined;
    try {
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
      if (StdioClientTransport?.prototype?.start) {
        origStdioStart = StdioClientTransport.prototype.start;
        // Patch: force stderr to 'pipe' before start() spawns the child
        StdioClientTransport.prototype.start = function (...args: any[]) {
          if (this._serverParams && !this._serverParams.stderr) {
            this._serverParams.stderr = 'pipe';
            // Must also set up the PassThrough stream (normally done in constructor)
            if (!this._stderrStream) {
              const { PassThrough } = require('stream');
              this._stderrStream = new PassThrough();
            }
          }
          return origStdioStart!.apply(this, args);
        };
      }
    } catch {}

    let restored = false;
    this.consoleRestore = () => {
      if (restored) return;
      restored = true;
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      console.info = original.info;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      // Restore original StdioClientTransport.start
      if (origStdioStart) {
        try {
          const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
          StdioClientTransport.prototype.start = origStdioStart;
        } catch {}
      }
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

      this._scheduleRender();
    });
  }

  private _originalSubmitHandler?: (message: string) => void | Promise<void>;

  private handleInputSubmit(value: string): void {
    if (!value.trim()) return;

    // Add user message to chat
    this.addUserMessage(value);

    // Call the submit handler
    this.onMessageSubmit?.(value);

    // Re-focus input on next tick — must not call readInput() from within
    // blessed's _done/submit event chain to avoid re-entrancy issues
    if (!this.running && this.activeTab === 'chat') {
      process.nextTick(() => {
        this.inputBar?.focus();
      });
    }
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

    // Update the status bar to show the current view name
    this.statusBar?.setActiveTab(tab);

    if (this.mainPane && this.logsPane && this.tracesPane) {
      // Hide all panes first
      this.mainPane.hide();
      this.logsPane.hide();
      this.tracesPane.hide();

      // Show the active pane and manage input bar focus
      if (tab === 'chat') {
        this.mainPane.show();
        this.inputBar?.resume();
      } else if (tab === 'logs') {
        this.inputBar?.pause();
        this.logsPane.show();
        this._flushPendingLogs();
        this.logsBox?.focus();
        this.screen?.program?.hideCursor();
      } else {
        this.inputBar?.pause();
        this.tracesPane.show();
        this.traceViewer?.focus();
      }
    }

    // Force full screen redraw to clear artifacts
    this.screen?.realloc();
    this.screen?.render();
  }

  private _flushPendingLogs(): void {
    if (!this.logsBox || this.pendingLogs.length === 0) return;
    // Use pushLine instead of log() to avoid N separate screen.render() callbacks.
    // Then do a single scroll + render at the end.
    for (const line of this.pendingLogs) {
      this.logsBox.pushLine(line);
    }
    this.pendingLogs = [];
    // Trim old lines to prevent blessed widget from growing without bound
    const maxLines = 10000;
    while ((this.logsBox as any).getLines().length > maxLines) {
      (this.logsBox as any).shiftLine(0);
    }
    (this.logsBox as any).setScrollPerc(100);
    this._scheduleRender();
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
    this._scheduleRender();
  }
}
