/**
 * StatusBar Component
 *
 * Status line at the very bottom showing mode indicators and keyboard hints.
 */
import blessed from 'blessed';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;

export type StatusMode = 'ready' | 'processing' | 'waiting' | 'error';

export interface StatusBarOptions {
  parent: Box;
}

export class StatusBar {
  private bar: Box;
  private parent: Box;
  private _mode: StatusMode = 'ready';
  private _statusText = '';
  private _activeTab: 'chat' | 'logs' = 'chat';

  constructor(options: StatusBarOptions) {
    this.parent = options.parent;

    this.bar = blessed.box({
      parent: this.parent,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        fg: 'white',
        bg: 'blue',
      },
    });

    this.render();
  }

  getElement(): Box {
    return this.bar;
  }

  setMode(mode: StatusMode): void {
    this._mode = mode;
    this.render();
  }

  setStatus(text: string): void {
    this._statusText = text;
    this.render();
  }

  setActiveTab(tab: 'chat' | 'logs'): void {
    this._activeTab = tab;
    this.render();
  }

  private getModeIndicator(): string {
    switch (this._mode) {
      case 'ready':
        return '● Ready';
      case 'processing':
        return '◌ Processing...';
      case 'waiting':
        return '◉ Awaiting input';
      case 'error':
        return '✖ Error';
      default:
        return '● Ready';
    }
  }

  private getModeColor(): string {
    switch (this._mode) {
      case 'ready':
        return 'green';
      case 'processing':
        return 'yellow';
      case 'waiting':
        return 'cyan';
      case 'error':
        return 'red';
      default:
        return 'green';
    }
  }

  private render(): void {
    const chatLabel = this._activeTab === 'chat' ? '[Chat]' : ' Chat ';
    const logsLabel = this._activeTab === 'logs' ? '[Logs]' : ' Logs ';
    const tabSection = `${chatLabel} ${logsLabel}`;

    const modeIndicator = this.getModeIndicator();
    const statusSection = this._statusText ? ` | ${this._statusText}` : '';

    const hints = ' Enter: send | Tab: switch | Ctrl+C: exit';

    // Get available width
    const screenWidth = this.bar.screen?.width;
    const width = typeof screenWidth === 'number' ? screenWidth : 80;

    // Build the status line
    const leftPart = `${tabSection} | ${modeIndicator}${statusSection}`;
    const availableForHints = width - leftPart.length - 2;

    let content: string;
    if (availableForHints >= hints.length) {
      const padding = width - leftPart.length - hints.length;
      content = leftPart + ' '.repeat(Math.max(0, padding)) + hints;
    } else {
      content = leftPart;
    }

    // Truncate if too long
    if (content.length > width) {
      content = content.slice(0, width);
    }

    this.bar.setContent(content);
  }

  show(): void {
    this.bar.show();
  }

  hide(): void {
    this.bar.hide();
  }

  update(screen: Screen): void {
    this.render();
    screen.render();
  }
}
