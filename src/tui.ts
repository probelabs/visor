import blessed from 'blessed';

type ConsoleMethods = Pick<Console, 'log' | 'error' | 'warn' | 'info'>;

type Screen = blessed.Widgets.Screen;

type Box = blessed.Widgets.BoxElement;

type Log = blessed.Widgets.Log;

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

  private updateLayout(): void {
    if (!this.mainPane || !this.chatBox || !this.outputBox) return;

    if (this.hasChat) {
      this.chatBox.show();
      this.chatBox.height = '60%';
      this.outputBox.top = '60%';
      this.outputBox.height = '40%';
    } else {
      this.chatBox.hide();
      this.outputBox.top = 0;
      this.outputBox.height = '100%';
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
