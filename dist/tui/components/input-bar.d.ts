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
export interface InputBarOptions {
    parent: Box;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    onTab?: () => void;
    onAbort?: () => void;
    onResize?: (height: number) => void;
}
export declare class InputBar {
    private container;
    private topBorder;
    private bottomBorder;
    private input;
    private placeholder;
    private parent;
    private _disabled;
    private _paused;
    private _placeholderText;
    private _hasFocus;
    private _lastActivation;
    private _currentHeight;
    private onSubmit?;
    private onEscape?;
    private onTab?;
    private onAbort?;
    private onResize?;
    constructor(options: InputBarOptions);
    private _updateBorders;
    private _overrideInputListener;
    private setupEventHandlers;
    private _autoGrow;
    private _resetHeight;
    private _activateInput;
    /**
     * Re-acquire focus if the input was previously active.
     * Call this when the terminal window regains focus.
     */
    refocus(): void;
    getElement(): Box;
    getHeight(): number;
    focus(): void;
    blur(): void;
    /**
     * Pause the input bar completely (for non-chat tabs).
     * Prevents auto-reactivation, hides cursor, and releases focus.
     */
    pause(): void;
    /**
     * Resume the input bar (returning to chat tab).
     * Re-enables auto-reactivation and re-acquires focus.
     */
    resume(): void;
    clear(): void;
    getValue(): string;
    setValue(value: string): void;
    setPlaceholder(text: string): void;
    disable(): void;
    enable(): void;
    hasFocus(): boolean;
    isDisabled(): boolean;
    show(): void;
    hide(): void;
    setBottom(bottom: number | string): void;
    render(screen: Screen): void;
    destroy(): void;
}
export {};
//# sourceMappingURL=input-bar.d.ts.map