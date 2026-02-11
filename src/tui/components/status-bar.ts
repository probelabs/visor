/**
 * StatusBar Component
 *
 * Status line at the very bottom showing mode indicator, current view name,
 * and a hint for tab cycling. No background color — minimal design.
 */
import blessed from 'blessed';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;

export type StatusMode = 'ready' | 'processing' | 'waiting' | 'error';

export interface StatusBarOptions {
  parent: Box | Screen;
}

export class StatusBar {
  private bar: Box;
  private parent: Box | Screen;
  private _mode: StatusMode = 'ready';
  private _statusText = '';
  private _activeTab: 'chat' | 'logs' | 'traces' = 'chat';

  constructor(options: StatusBarOptions) {
    this.parent = options.parent;

    this.bar = blessed.box({
      parent: this.parent as any,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: {
        fg: 'white',
        bg: 'default',
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
    const viewLabel = this.getViewLabel();
    const modeIndicator = this.getModeIndicatorStyled();
    const statusSection = this._statusText ? `  ${this._statusText}` : '';
    const hint = '{gray-fg}(shift+tab to cycle){/}';

    // Layout: view label first (prominent), then mode indicator, then hint
    const content = `${viewLabel}  ${modeIndicator}${statusSection}  ${hint}`;

    this.bar.setContent(content);
  }

  private getViewLabel(): string {
    switch (this._activeTab) {
      case 'chat':
        return '{bold}{cyan-fg}◆ Chat{/}';
      case 'logs':
        return '{bold}{cyan-fg}≡ Logs{/}';
      case 'traces':
        return '{bold}{cyan-fg}◇ Traces{/}';
      default:
        return '{bold}{cyan-fg}◆ Chat{/}';
    }
  }

  private getModeIndicatorStyled(): string {
    switch (this._mode) {
      case 'ready':
        return '{green-fg}●{/}';
      case 'processing':
        return '{yellow-fg}● Working{/}';
      case 'waiting':
        return '{cyan-fg}◉ Awaiting input{/}';
      case 'error':
        return '{red-fg}✖ Error{/}';
      default:
        return '{green-fg}●{/}';
    }
  }

  show(): void {
    this.bar.show();
  }

  hide(): void {
    this.bar.hide();
  }

  destroy(): void {
    // no-op; kept for interface compatibility
  }

  update(screen: Screen): void {
    this.render();
    screen.render();
  }
}
