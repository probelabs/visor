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
  private _activeTab: 'chat' | 'logs' | 'traces' = 'chat';

  constructor(options: StatusBarOptions) {
    this.parent = options.parent;

    this.bar = blessed.box({
      parent: this.parent,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true, // Enable color tags
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

  setActiveTab(tab: 'chat' | 'logs' | 'traces'): void {
    this._activeTab = tab;
    this.render();
  }

  private render(): void {
    // Use bright colors for active tab (with brackets) and dim for inactive
    const chatLabel =
      this._activeTab === 'chat' ? '{bold}{white-bg}{black-fg}[1:Chat]{/}' : '{gray-fg} 1:Chat {/}';
    const logsLabel =
      this._activeTab === 'logs' ? '{bold}{white-bg}{black-fg}[2:Logs]{/}' : '{gray-fg} 2:Logs {/}';
    const tracesLabel =
      this._activeTab === 'traces'
        ? '{bold}{white-bg}{black-fg}[3:Traces]{/}'
        : '{gray-fg} 3:Traces {/}';
    const tabSection = `${chatLabel}${logsLabel}${tracesLabel}`;

    const modeIndicator = this.getModeIndicatorStyled();
    const statusSection = this._statusText ? ` | ${this._statusText}` : '';

    const hints = '{gray-fg}Shift+drag: select | Ctrl+C: exit{/}';

    // Build the status line with tags
    const content = `${tabSection} │ ${modeIndicator}${statusSection}  ${hints}`;

    this.bar.setContent(content);
  }

  private getModeIndicatorStyled(): string {
    switch (this._mode) {
      case 'ready':
        return '{green-fg}● Ready{/}';
      case 'processing':
        return '{yellow-fg}◌ Processing...{/}';
      case 'waiting':
        return '{cyan-fg}◉ Awaiting input{/}';
      case 'error':
        return '{red-fg}✖ Error{/}';
      default:
        return '{green-fg}● Ready{/}';
    }
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
