import blessed from 'blessed';

type ConsoleMethods = Pick<Console, 'log' | 'error' | 'warn' | 'info'>;

type Screen = blessed.Widgets.Screen;

type Box = blessed.Widgets.BoxElement;

type Log = blessed.Widgets.Log;

type Textbox = blessed.Widgets.TextboxElement;

type Textarea = blessed.Widgets.TextareaElement;

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

export class TuiManager {
  private screen?: Screen;
  private tabBar?: Box;
  private mainPane?: Box;
  private logsPane?: Box;
  private chatBox?: Box;
  private outputBox?: Box;
  private logsBox?: Log;
  private activeTab: 'main' | 'logs' = 'main';
  private hasChat = false;
  private status = 'Running';
  private running = false;
  private pendingLogs: string[] = [];
  private pendingOutput = '';
  private pendingChat = '';
  private exitResolver?: () => void;
  private consoleRestore?: () => void;
  private consoleExitHandler?: () => void;
  private processExitHandler?: () => void;
  private abortHandler?: () => void;
  private promptCleanup?: () => void;
  private inputPane?: Box;
  private inputPrompt?: Box;
  private inputHint?: Box;
  private inputError?: Box;
  private inputField?: Textarea | Textbox;
  private promptActive = false;
  private promptMultiline = false;

  start(): void {
    if (this.screen) return;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Visor',
      dockBorders: true,
    });

    this.tabBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        fg: 'white',
        bg: 'blue',
      },
    });

    this.mainPane = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-1',
    });

    this.logsPane = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-1',
      hidden: true,
    });

    this.chatBox = blessed.box({
      parent: this.mainPane,
      top: 0,
      left: 0,
      width: '100%',
      height: '60%',
      label: ' Chat ',
      border: { type: 'line' },
      scrollable: true,
      alwaysScroll: false,
      keys: true,
      vi: true,
      mouse: true,
      tags: false,
      wrap: true,
      scrollbar: {
        ch: ' ',
      },
    });

    this.outputBox = blessed.box({
      parent: this.mainPane,
      top: '60%',
      left: 0,
      width: '100%',
      height: '40%',
      label: ' Output ',
      border: { type: 'line' },
      scrollable: true,
      alwaysScroll: false,
      keys: true,
      vi: true,
      mouse: true,
      tags: false,
      wrap: true,
      scrollbar: {
        ch: ' ',
      },
    });

    this.logsBox = blessed.log({
      parent: this.logsPane,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      label: ' Logs ',
      border: { type: 'line' },
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      tags: false,
      wrap: true,
      scrollbar: {
        ch: ' ',
      },
    });

    this.screen.key(['tab', 'S-tab', 'left', 'right'], () => this.toggleTab());
    this.screen.key(['1'], () => this.setActiveTab('main'));
    this.screen.key(['2'], () => this.setActiveTab('logs'));
    this.screen.key(['q'], () => {
      if (this.running) {
        this.setStatus('Still running. Press Ctrl+C to abort.');
        return;
      }
      if (this.exitResolver) this.exitResolver();
    });
    this.screen.key(['C-c'], () => {
      if (this.abortHandler) {
        this.abortHandler();
        return;
      }
      this.stop();
    });

    this.screen.on('resize', () => {
      this.updateLayout();
      this.renderTabs();
      this.screen?.render();
    });

    this.updateLayout();
    this.renderTabs();

    this.processExitHandler = () => this.stop();
    process.once('exit', this.processExitHandler);

    if (this.pendingOutput) this.setOutput(this.pendingOutput);
    if (this.pendingChat) this.setChatContent(this.pendingChat);
    if (this.pendingLogs.length > 0) {
      for (const line of this.pendingLogs) this.appendLog(line);
      this.pendingLogs = [];
    }

    this.outputBox.setContent('Running checks...');
    this.outputBox.focus();
    this.screen.render();
  }

  stop(): void {
    if (this.promptCleanup) this.promptCleanup();
    this.promptCleanup = undefined;
    if (this.consoleRestore) this.consoleRestore();
    this.consoleRestore = undefined;
    if (this.processExitHandler) {
      process.removeListener('exit', this.processExitHandler);
      this.processExitHandler = undefined;
    }
    if (this.screen) {
      this.screen.destroy();
      this.screen = undefined;
    }
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (!running) {
      this.setStatus('Done. Press q to exit.');
    }
    this.renderTabs();
  }

  setStatus(status: string): void {
    this.status = status;
    this.renderTabs();
    this.screen?.render();
  }

  setOutput(content: string): void {
    this.pendingOutput = content;
    if (!this.outputBox) return;
    this.outputBox.setContent(content || '');
    this.outputBox.setScrollPerc(0);
    this.screen?.render();
  }

  setChatContent(content: string): void {
    this.pendingChat = content;
    const trimmed = (content || '').trim();
    this.hasChat = trimmed.length > 0;
    if (!this.chatBox) return;
    if (this.hasChat) {
      this.chatBox.setContent(trimmed);
    } else {
      this.chatBox.setContent('No chat output.');
    }
    this.updateLayout();
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
    if (!this.screen) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.stop();
        resolve();
      };
      this.exitResolver = finish;
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

  setAbortHandler(handler?: () => void): void {
    this.abortHandler = handler;
  }

  async promptUser(options: {
    prompt: string;
    placeholder?: string;
    multiline?: boolean;
    timeout?: number;
    defaultValue?: string;
    allowEmpty?: boolean;
  }): Promise<string> {
    if (!this.screen) {
      throw new Error('TUI not initialized');
    }

    this.setActiveTab('main');

    if (this.promptActive) {
      throw new Error('Input prompt already active');
    }

    const screen = this.screen;
    const promptText = (options.prompt || 'Please provide input:').trim();
    const placeholder = options.placeholder || '';
    const multiline = options.multiline ?? false;
    const allowEmpty = options.allowEmpty ?? false;
    const defaultValue = options.defaultValue;

    this.promptActive = true;
    this.promptMultiline = multiline;

    return new Promise((resolve, reject) => {
      let done = false;
      let timeoutId: NodeJS.Timeout | undefined;
      const finish = (value?: string, error?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve(value ?? '');
      };

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        this.promptActive = false;
        this.promptMultiline = false;
        try {
          this.inputField?.destroy();
        } catch {}
        this.inputField = undefined;
        if (this.inputError) this.inputError.hide();
        if (this.inputPane) this.inputPane.hide();
        this.updateLayout();
        this.promptCleanup = undefined;
        this.outputBox?.focus();
        screen.render();
      };

      this.promptCleanup = () => finish(undefined, new Error('Input cancelled'));

      if (!this.inputPane && this.mainPane) {
        this.inputPane = blessed.box({
          parent: this.mainPane,
          top: 0,
          left: 0,
          width: '100%',
          height: 6,
          label: ' Input ',
          border: { type: 'line' },
          hidden: true,
        });
        this.inputPrompt = blessed.box({
          parent: this.inputPane,
          top: 0,
          left: 1,
          width: '100%-2',
          height: 1,
          tags: false,
        });
        this.inputHint = blessed.box({
          parent: this.inputPane,
          bottom: 0,
          left: 1,
          width: '100%-2',
          height: 1,
          style: { fg: 'gray' },
        });
        this.inputError = blessed.box({
          parent: this.inputPane,
          bottom: 1,
          left: 1,
          width: '100%-2',
          height: 1,
          style: { fg: 'red' },
          content: '',
        });
        this.inputError.hide();
      }

      const inputPane = this.inputPane;
      if (!inputPane) return finish(undefined, new Error('Input pane unavailable'));

      if (this.inputPrompt) {
        this.inputPrompt.setContent(
          placeholder ? `${promptText}  (${placeholder})` : promptText
        );
      }
      if (this.inputHint) {
        this.inputHint.setContent(
          multiline ? 'Ctrl+S to submit | Esc to cancel' : 'Enter to submit | Esc to cancel'
        );
      }
      if (this.inputError) this.inputError.hide();

      this.updateLayout();
      inputPane.show();

      const input = (multiline
        ? blessed.textarea({
            parent: inputPane,
            top: 1,
            left: 1,
            width: '100%-2',
            height: '100%-3',
            inputOnFocus: true,
            keys: true,
            mouse: true,
            vi: true,
            style: { fg: 'white', bg: 'black' },
          })
        : blessed.textbox({
            parent: inputPane,
            top: 1,
            left: 1,
            width: '100%-2',
            height: '100%-3',
            inputOnFocus: true,
            keys: true,
            mouse: true,
            vi: true,
            style: { fg: 'white', bg: 'black' },
          })) as Textarea | Textbox;
      this.inputField = input;

      if (defaultValue) {
        try {
          input.setValue(defaultValue);
        } catch {}
      }

      const submitValue = (value: string) => {
        const trimmed = (value || '').trim();
        if (!trimmed && !allowEmpty && defaultValue === undefined) {
          if (this.inputError) {
            this.inputError.setContent('Input required.');
            this.inputError.show();
          }
          screen.render();
          input.focus();
          return false;
        }
        finish(trimmed || defaultValue || '');
        return true;
      };

      input.key(['escape'], () => finish(undefined, new Error('Input cancelled')));
      if (multiline) {
        input.key(['C-s'], () => {
          try {
            submitValue((input as Textarea).getValue());
          } catch (err) {
            finish(undefined, err instanceof Error ? err : new Error(String(err)));
          }
        });
      }

      try {
        (input as any).readInput?.((err: Error | null, value: string) => {
          if (err) return finish(undefined, err);
          if (!multiline) {
            submitValue(value);
          }
        });
      } catch (err) {
        finish(undefined, err instanceof Error ? err : new Error(String(err)));
      }

      if (options.timeout && options.timeout > 0) {
        timeoutId = setTimeout(() => {
          if (defaultValue !== undefined) {
            return finish(defaultValue);
          }
          return finish(undefined, new Error('Input timeout'));
        }, options.timeout);
        if (typeof (timeoutId as any).unref === 'function') (timeoutId as any).unref();
      }

      input.focus();
      screen.render();
    });
  }

  private updateLayout(): void {
    if (!this.mainPane || !this.chatBox || !this.outputBox) return;

    const screenHeight =
      this.screen && typeof this.screen.height === 'number' ? this.screen.height : 24;
    const available = Math.max(6, screenHeight - 1);
    const requestedInput = this.promptActive ? (this.promptMultiline ? 10 : 6) : 0;
    const maxInput = Math.max(0, available - 3);
    const inputHeight = this.promptActive ? Math.min(requestedInput, maxInput) : 0;
    const bodyHeight = Math.max(3, available - inputHeight);

    if (this.hasChat) {
      this.chatBox.show();
      const chatHeight = Math.max(3, Math.floor(bodyHeight * 0.6));
      const outputHeight = Math.max(3, bodyHeight - chatHeight);
      this.chatBox.top = 0;
      this.chatBox.height = chatHeight;
      this.outputBox.top = chatHeight;
      this.outputBox.height = outputHeight;
    } else {
      this.chatBox.hide();
      this.outputBox.top = 0;
      this.outputBox.height = bodyHeight;
    }

    if (this.inputPane) {
      if (this.promptActive && inputHeight > 0) {
        this.inputPane.top = bodyHeight;
        this.inputPane.height = inputHeight;
        this.inputPane.show();
      } else {
        this.inputPane.hide();
      }
    }
  }

  private renderTabs(): void {
    if (!this.tabBar) return;
    const chatLabel = this.activeTab === 'main' ? '[Chat/Output]' : ' Chat/Output ';
    const logsLabel = this.activeTab === 'logs' ? '[Logs]' : ' Logs ';
    const hint = ' Tab: switch 1/2: jump q: quit ';
    const status = this.status ? ` ${this.status}` : '';
    const raw = `${chatLabel} ${logsLabel} |${hint}|${status}`;
    const width = this.screen && typeof this.screen.width === 'number' ? this.screen.width : 80;
    this.tabBar.setContent(raw.length > width ? raw.slice(0, width) : raw);
  }

  private toggleTab(): void {
    this.setActiveTab(this.activeTab === 'main' ? 'logs' : 'main');
  }

  private setActiveTab(tab: 'main' | 'logs'): void {
    this.activeTab = tab;
    if (this.mainPane && this.logsPane) {
      if (tab === 'main') {
        this.mainPane.show();
        this.logsPane.hide();
        this.outputBox?.focus();
      } else {
        this.mainPane.hide();
        this.logsPane.show();
        this.logsBox?.focus();
      }
    }
    this.renderTabs();
    this.screen?.render();
  }
}
