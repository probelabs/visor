/**
 * Built-in AI tool for inspecting task progress via execution traces.
 *
 * When enabled (via skill or config), the AI can call this tool to:
 * - List active/recent tasks in the current thread
 * - Read the execution trace of a specific task to see what steps were taken
 *
 * This allows the AI to answer "what's your progress?" or "how is it going?"
 * by inspecting the live trace of running tasks.
 */
import type { CustomToolDefinition } from '../types/config';
export declare function getTaskProgressToolDefinition(): CustomToolDefinition;
export declare function isTaskProgressTool(toolName: string): boolean;
export interface TaskProgressContext {
    /** Slack channel ID (for filtering tasks to current context) */
    channelId?: string;
    /** Slack thread timestamp (for filtering to current thread) */
    threadTs?: string;
}
export interface TaskProgressResult {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function handleTaskProgressAction(args: {
    action: 'list' | 'trace';
    task_id?: string;
}, context: TaskProgressContext, taskStore: any): Promise<TaskProgressResult>;
//# sourceMappingURL=task-progress-tool.d.ts.map