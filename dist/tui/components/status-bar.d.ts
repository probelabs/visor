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
export declare class StatusBar {
    private bar;
    private parent;
    private _mode;
    private _statusText;
    private _activeTab;
    constructor(options: StatusBarOptions);
    getElement(): Box;
    setMode(mode: StatusMode): void;
    setStatus(text: string): void;
    setActiveTab(tab: 'chat' | 'logs' | 'traces'): void;
    private render;
    private getViewLabel;
    private getModeIndicatorStyled;
    show(): void;
    hide(): void;
    destroy(): void;
    update(screen: Screen): void;
}
export {};
//# sourceMappingURL=status-bar.d.ts.map