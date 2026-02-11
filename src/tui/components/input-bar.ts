/**
 * InputBar Component
 *
 * Persistent input bar at the bottom of the chat interface.
 * Features a top border separator, multiline textarea with auto-grow,
 * Enter to submit, and Shift+Enter for newline.
 */
import blessed from 'blessed';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;
type Textarea = blessed.Widgets.TextareaElement;

const MIN_HEIGHT = 3; // 1 top border + 1 input line + 1 bottom border
const MAX_HEIGHT = 10;

export interface InputBarOptions {
  parent: Box;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  onTab?: () => void;
  onAbort?: () => void;
  onResize?: (height: number) => void;
}

export class InputBar {
  private container: Box;
  private topBorder: Box;
  private bottomBorder: Box;
  private input: Textarea;
  private placeholder: Box;
  private parent: Box;
  private _disabled = false;
  private _placeholderText = 'Type a message...';
  private _hasFocus = false;
  private _lastActivation = 0;
  private _currentHeight = MIN_HEIGHT;
  private onSubmit?: (value: string) => void;
  private onEscape?: () => void;
  private onTab?: () => void;
  private onAbort?: () => void;
  private onResize?: (height: number) => void;

  constructor(options: InputBarOptions) {
    this.parent = options.parent;
    this.onSubmit = options.onSubmit;
    this.onEscape = options.onEscape;
    this.onTab = options.onTab;
    this.onAbort = options.onAbort;
    this.onResize = options.onResize;

    // Container box for the input area
    this.container = blessed.box({
      parent: this.parent,
      bottom: 1, // Leave room for status bar
      left: 0,
      width: '100%',
      height: MIN_HEIGHT,
    });

    // Top border line
    this.topBorder = blessed.box({
      parent: this.container,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'gray' },
    });

    // Bottom border line
    this.bottomBorder = blessed.box({
      parent: this.container,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'gray' },
    });

    this._updateBorders();

    // Prompt indicator
    blessed.box({
      parent: this.container,
      top: 1,
      left: 0,
      width: 3,
      height: 1,
      content: ' > ',
      style: { fg: 'green', bold: true },
    });

    // Placeholder text (shown when input is empty)
    this.placeholder = blessed.box({
      parent: this.container,
      top: 1,
      left: 3,
      width: '100%-3',
      height: 1,
      content: this._placeholderText,
      style: { fg: 'gray' },
    });

    // Actual input field (textarea for multiline support)
    this.input = blessed.textarea({
      parent: this.container,
      top: 1,
      left: 3,
      width: '100%-3',
      height: MIN_HEIGHT - 2, // minus top and bottom borders
      mouse: true,
      keys: true,
      inputOnFocus: false,
      style: {
        fg: 'white',
        bold: true,
        bg: 'default',
        focus: {
          fg: 'white',
          bold: true,
          bg: 'default',
        },
      },
    });

    // Override textarea's _listener ONCE before readInput is ever called.
    // When readInput() later creates __listener = _listener.bind(this),
    // it will use our override — no extra listeners, no double characters.
    this._overrideInputListener();

    this.setupEventHandlers();
  }

  private _updateBorders(): void {
    const width =
      typeof this.container.width === 'number'
        ? this.container.width
        : (this.parent.width as number) || 80;
    const line = '─'.repeat(width);
    this.topBorder.setContent(line);
    this.bottomBorder.setContent(line);
  }

  private _overrideInputListener(): void {
    const input = this.input as any;
    const origListener = input._listener; // from Textarea prototype

    // Shadow the prototype method on this instance
    input._listener = function (ch: string, key: any) {
      // Enter without Shift → submit (call _done for proper blessed cleanup)
      if (key.name === 'return' && !key.shift) {
        input._done(null, input.value);
        return;
      }
      // Shift+Enter → insert newline (delegate as regular return)
      if (key.name === 'return' && key.shift) {
        return origListener.call(input, ch, { ...key, shift: false });
      }
      return origListener.call(input, ch, key);
    };
  }

  private setupEventHandlers(): void {
    // Handle submit on Enter (via our patched listener)
    this.input.on('submit', (value: string) => {
      const trimmed = (value || '').trim();
      this._hasFocus = false;

      if (trimmed && !this._disabled) {
        this.onSubmit?.(trimmed);
        this.clear();
        this._resetHeight();
      }
    });

    // Handle cancel — emitted by blessed's _done when the readInput session
    // ends via blur (window lost focus) or Escape. Re-activate so the user
    // can keep typing when they return.
    this.input.on('cancel', () => {
      this._hasFocus = false;
      if (!this._disabled) {
        process.nextTick(() => {
          if (!this._disabled && !this._hasFocus) {
            this._activateInput();
          }
        });
      }
    });

    // Handle Escape — clear input (cancel handler above re-activates)
    this.input.key(['escape'], () => {
      this.onEscape?.();
      this.clear();
      this._resetHeight();
    });

    // Handle Shift+Tab for switching tabs
    this.input.key(['S-tab'], () => {
      this.onTab?.();
    });

    // Handle Ctrl+C for abort
    this.input.key(['C-c'], () => {
      this.onAbort?.();
    });

    // Show/hide placeholder on keypress; auto-grow only when multiline
    this.input.on('keypress', () => {
      // Use nextTick (faster than setImmediate) for placeholder toggle
      process.nextTick(() => {
        const value = this.getValue();
        if (value.length > 0) {
          this.placeholder.hide();
        } else {
          this.placeholder.show();
        }
        // Only check auto-grow when content might have newlines
        if (value.includes('\n') || this._currentHeight > MIN_HEIGHT) {
          this._autoGrow();
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

    // Update border widths on parent resize
    this.parent.on('resize', () => {
      this._updateBorders();
    });
  }

  private _autoGrow(): void {
    const value = this.getValue();
    const lines = value.split('\n').length;
    // height = 2 (borders) + content lines, clamped to [MIN_HEIGHT, MAX_HEIGHT]
    const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, 2 + lines));

    if (newHeight !== this._currentHeight) {
      this._currentHeight = newHeight;
      this.container.height = newHeight;
      this.input.height = newHeight - 2; // minus top and bottom borders
      this.onResize?.(newHeight);
      this.parent.screen?.render();
    }
  }

  private _resetHeight(): void {
    if (this._currentHeight !== MIN_HEIGHT) {
      this._currentHeight = MIN_HEIGHT;
      this.container.height = MIN_HEIGHT;
      this.input.height = MIN_HEIGHT - 2;
      this.onResize?.(MIN_HEIGHT);
    }
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
      this._hasFocus = false;
    });

    // readInput attaches __listener in nextTick; show cursor + render then too
    // so the cursor is visible after blessed has fully set up the input session
    process.nextTick(() => {
      const program = this.parent.screen?.program;
      if (program) {
        program.showCursor();
        (this.input as any)._updateCursor?.();
      }
    });
  }

  /**
   * Re-acquire focus if the input was previously active.
   * Call this when the terminal window regains focus.
   */
  refocus(): void {
    if (this._disabled) return;
    // Force re-activation even if _hasFocus thinks it's focused
    this._hasFocus = false;
    this._lastActivation = 0;
    this._activateInput();
  }

  getElement(): Box {
    return this.container;
  }

  getHeight(): number {
    return this._currentHeight;
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
    (this.input.style as any).bold = true;
    this.setPlaceholder('Type a message...');
  }

  hasFocus(): boolean {
    return this._hasFocus;
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
