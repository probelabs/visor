/**
 * InputBar Component
 *
 * Persistent input bar at the bottom of the chat interface.
 * Always visible, allows users to type messages at any time.
 */
import blessed from 'blessed';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;
type Textbox = blessed.Widgets.TextboxElement;

export interface InputBarOptions {
  parent: Box;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  onTab?: () => void;
  onAbort?: () => void;
}

export class InputBar {
  private container: Box;
  private input: Textbox;
  private placeholder: Box;
  private parent: Box;
  private _disabled = false;
  private _placeholderText = 'Type a message...';
  private _hasFocus = false;
  private _lastActivation = 0;
  private onSubmit?: (value: string) => void;
  private onEscape?: () => void;
  private onTab?: () => void;
  private onAbort?: () => void;

  constructor(options: InputBarOptions) {
    this.parent = options.parent;
    this.onSubmit = options.onSubmit;
    this.onEscape = options.onEscape;
    this.onTab = options.onTab;
    this.onAbort = options.onAbort;

    // Container box for the input area
    this.container = blessed.box({
      parent: this.parent,
      bottom: 1, // Leave room for status bar
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      style: {
        border: { fg: 'blue' },
      },
    });

    // Prompt indicator
    blessed.box({
      parent: this.container,
      top: 0,
      left: 0,
      width: 2,
      height: 1,
      content: '> ',
      style: { fg: 'green' },
    });

    // Placeholder text (shown when input is empty)
    this.placeholder = blessed.box({
      parent: this.container,
      top: 0,
      left: 2,
      width: '100%-4',
      height: 1,
      content: this._placeholderText,
      style: { fg: 'gray' },
    });

    // Actual input field
    this.input = blessed.textbox({
      parent: this.container,
      top: 0,
      left: 2,
      width: '100%-4',
      height: 1,
      mouse: true,
      keys: true,
      inputOnFocus: false, // We manage readInput manually
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle submit on Enter
    this.input.on('submit', (value: string) => {
      const trimmed = (value || '').trim();
      this._hasFocus = false;

      if (trimmed && !this._disabled) {
        this.onSubmit?.(trimmed);
        this.clear();
      }
      // Note: Don't auto-refocus here - let the caller (ChatTUI) manage focus
      // This prevents conflicts with workflow state management
    });

    // Handle cancel on Escape
    this.input.key(['escape'], () => {
      this.onEscape?.();
      this.clear();
    });

    // Handle Tab for switching tabs (pass through to parent)
    this.input.key(['tab', 'S-tab'], () => {
      this.onTab?.();
    });

    // Handle Ctrl+C for abort (pass through to parent)
    this.input.key(['C-c'], () => {
      this.onAbort?.();
    });

    // Show/hide placeholder based on input content
    this.input.on('keypress', () => {
      // Small delay to let the character be added
      setImmediate(() => {
        const value = this.getValue();
        if (value.length > 0) {
          this.placeholder.hide();
        } else {
          this.placeholder.show();
        }
      });
    });

    // Track focus state
    this.input.on('blur', () => {
      this._hasFocus = false;
      if (!this.getValue()) {
        this.placeholder.show();
      }
    });

    this.input.on('focus', () => {
      if (this.getValue()) {
        this.placeholder.hide();
      }
    });
  }

  private _activateInput(): void {
    if (this._disabled || this._hasFocus) return;

    // Debounce: prevent multiple activations within 20ms
    const now = Date.now();
    if (now - this._lastActivation < 20) return;
    this._lastActivation = now;

    this._hasFocus = true;
    this.input.focus();
    (this.input as any).readInput?.(() => {
      // Called when readInput ends (submit, cancel, or blur)
      this._hasFocus = false;
    });
  }

  getElement(): Box {
    return this.container;
  }

  focus(): void {
    if (this._disabled) return;
    this._activateInput();
  }

  blur(): void {
    if (this._hasFocus) {
      try {
        (this.input as any).cancel?.();
      } catch {}
      this._hasFocus = false;
    }
  }

  clear(): void {
    this.input.clearValue();
    this.input.setValue('');
    this.placeholder.show();
  }

  getValue(): string {
    return this.input.getValue() || '';
  }

  setValue(value: string): void {
    this.input.setValue(value);
    if (value) {
      this.placeholder.hide();
    } else {
      this.placeholder.show();
    }
  }

  setPlaceholder(text: string): void {
    this._placeholderText = text;
    this.placeholder.setContent(text);
  }

  disable(): void {
    this._disabled = true;
    this.blur();
    this.input.style.fg = 'gray';
    this.setPlaceholder('Processing...');
  }

  enable(): void {
    this._disabled = false;
    this.input.style.fg = 'white';
    this.setPlaceholder('Type a message...');
  }

  isDisabled(): boolean {
    return this._disabled;
  }

  show(): void {
    this.container.show();
  }

  hide(): void {
    this.container.hide();
  }

  setBottom(bottom: number | string): void {
    this.container.bottom = bottom;
  }

  render(screen: Screen): void {
    screen.render();
  }

  destroy(): void {
    this.blur();
    this.input.removeAllListeners();
    this.container.destroy();
  }
}
