import { SqliteTaskStore, type ListTasksFilter } from './task-store';
export declare class TasksTUI {
    private screen;
    private listBox;
    private detailBox;
    private statusBar;
    private store;
    private filter;
    private instanceId;
    private items;
    private total;
    private selectedIndex;
    private scrollOffset;
    private mode;
    private detailScrollOffset;
    private detailLines;
    private refreshInterval?;
    private destroyed;
    constructor(store: SqliteTaskStore, filter: ListTasksFilter);
    private setupKeyBindings;
    private getVisibleHeight;
    private moveSelection;
    private ensureVisible;
    private scrollDetail;
    private loadTasks;
    private enterDetail;
    private render;
    private renderDetail;
    private wrapText;
    start(): Promise<void>;
    destroy(): void;
}
export declare function runTasksTUI(filter: ListTasksFilter): Promise<void>;
//# sourceMappingURL=tasks-tui.d.ts.map