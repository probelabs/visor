/**
 * ChatBox Component
 *
 * Displays scrollable chat message history with user/assistant distinction.
 */
import blessed from 'blessed';
import type { ChatMessage } from '../chat-state';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;

export interface ChatBoxOptions {
  parent: Box;
}

const PROGRESS_TAG = '\n\n{yellow-fg}* working for ';
const PROGRESS_SUFFIX = 's{/yellow-fg}';

export class ChatBox {
  private box: Box;
  private parent: Box;
  private _progressTimer?: ReturnType<typeof setInterval>;
  private _elapsedSeconds = 0;
  private _baseContent = ''; // content without progress line

  constructor(options: ChatBoxOptions) {
    this.parent = options.parent;

    this.box = blessed.box({
      parent: this.parent,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-4', // Leave room for input bar (3 lines) and status bar (1 line)
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      tags: true,
      wrap: true,
      style: {
        fg: 'white',
      },
      scrollbar: {
        ch: ' ',
        style: { bg: 'gray' },
      },
    });
  }

  getElement(): Box {
    return this.box;
  }

  focus(): void {
    this.box.focus();
  }

  setContent(content: string): void {
    this._baseContent = content;
    this.box.setContent(this._isProgressing() ? content + this._progressLine() : content);
    this.scrollToBottom();
  }

  appendMessage(message: ChatMessage): void {
    const formatted = this.formatMessage(message);
    const separator = this._baseContent ? '\n\n' : '';
    this._baseContent += separator + formatted;
    this.box.setContent(
      this._isProgressing() ? this._baseContent + this._progressLine() : this._baseContent
    );
    this.scrollToBottom();
  }

  showProgress(): void {
    if (this._progressTimer) return;
    this._elapsedSeconds = 0;
    this._renderProgress();
    this._progressTimer = setInterval(() => {
      this._elapsedSeconds++;
      this._renderProgress();
    }, 1000);
    if (typeof (this._progressTimer as any).unref === 'function') {
      (this._progressTimer as any).unref();
    }
  }

  hideProgress(): void {
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = undefined;
    }
    this._elapsedSeconds = 0;
    // Remove progress line, show base content only
    this.box.setContent(this._baseContent);
    this.scrollToBottom();
    this.parent.screen?.render();
  }

  private _isProgressing(): boolean {
    return this._progressTimer !== undefined;
  }

  private _progressLine(): string {
    return `${PROGRESS_TAG}${this._elapsedSeconds}${PROGRESS_SUFFIX}`;
  }

  private _renderProgress(): void {
    this.box.setContent(this._baseContent + this._progressLine());
    this.scrollToBottom();
    this.parent.screen?.render();
  }

  scrollToBottom(): void {
    this.box.setScrollPerc(100);
  }

  scrollUp(lines = 1): void {
    this.box.scroll(-lines);
  }

  scrollDown(lines = 1): void {
    this.box.scroll(lines);
  }

  clear(): void {
    this.box.setContent('');
  }

  show(): void {
    this.box.show();
  }

  hide(): void {
    this.box.hide();
  }

  private formatMessage(message: ChatMessage): string {
    const time = message.timestamp.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    // Escape any blessed tags in content to prevent injection
    const content = this.escapeTags(message.content);

    if (message.role === 'user') {
      // User: subtle dark background, > prefix
      const header = `{black-bg}{bold} > You {/bold}[${time}]{/black-bg}`;
      const body = content
        .split('\n')
        .map(l => `{black-bg} ${l} {/black-bg}`)
        .join('\n');
      return `${header}\n${body}`;
    }

    if (message.role === 'assistant') {
      // Assistant: standard text, ● prefix
      const header = `{bold}{green-fg}●{/green-fg} Assistant{/bold} {gray-fg}[${time}]{/gray-fg}`;
      return `${header}\n${content}`;
    }

    // System/Visor messages: gray and subdued
    const header = `{gray-fg}⊘ Visor [${time}]`;
    return `${header}\n${content}{/gray-fg}`;
  }

  private escapeTags(text: string): string {
    // Escape blessed tag syntax: { → \{
    return text.replace(/\{/g, '\\{');
  }

  setHeight(height: number | string): void {
    this.box.height = height;
  }

  setTop(top: number | string): void {
    this.box.top = top;
  }

  render(screen: Screen): void {
    screen.render();
  }
}
