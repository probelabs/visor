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

export class ChatBox {
  private box: Box;
  private parent: Box;

  constructor(options: ChatBoxOptions) {
    this.parent = options.parent;

    this.box = blessed.box({
      parent: this.parent,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-3', // Leave room for input bar and status bar
      label: ' Chat ',
      border: { type: 'line' },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      tags: false,
      wrap: true,
      scrollbar: {
        ch: ' ',
        style: { bg: 'gray' },
      },
      style: {
        border: { fg: 'blue' },
        label: { fg: 'white', bold: true },
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
    this.box.setContent(content);
    this.scrollToBottom();
  }

  appendMessage(message: ChatMessage): void {
    const formatted = this.formatMessage(message);
    const current = this.box.getContent() || '';
    const separator = current ? '\n\n' : '';
    this.box.setContent(current + separator + formatted);
    this.scrollToBottom();
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

    const roleLabel = message.role === 'user' ? 'You' : 'Assistant';
    const header = `${roleLabel}: [${time}]`;

    return `${header}\n${message.content}`;
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
