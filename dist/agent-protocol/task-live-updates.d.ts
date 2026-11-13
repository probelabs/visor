import type { TaskLiveUpdatesConfig } from '../types/config';
import { type ProbeTaskSummary } from './trace-serializer';
export declare const DEFAULT_TASK_LIVE_UPDATE_INTERVAL_SECONDS = 10;
export declare const DEFAULT_TASK_LIVE_UPDATE_MAX_TRACE_CHARS = 12000;
export declare const DEFAULT_TASK_LIVE_UPDATE_FIRST_UPDATE_DELAY_SECONDS = 10;
export declare const DEFAULT_TASK_LIVE_UPDATE_METADATA_REFRESH_SECONDS = 5;
export declare const DEFAULT_TASK_LIVE_UPDATE_STALL_FALLBACK_SECONDS = 60;
export declare const DEFAULT_TASK_LIVE_UPDATE_MODEL = "gemini-3.1-flash-lite-preview";
export declare const DEFAULT_TASK_LIVE_UPDATE_PROMPT = "You are generating a short live progress update for a user while an AI task is still running.\n\nThis is NOT the final answer.\nDo NOT answer the user's original request.\nDo NOT write the final solution.\nDo NOT explain the topic in full.\nDo NOT provide a root cause, recommendation, summary of findings, or conclusion.\nEven if you think you already know the answer, do NOT give it here.\n\nYou will receive:\n- the user's original request\n- the previous progress update, if any\n- timing metadata for this run\n- the latest execution trace snapshot\n\nYour job is to produce a concise status update that tells the user only:\n- the overall progress so far\n- the last meaningful action that finished\n- what the agent is doing right now\n- what it is likely waiting on, if anything\n\nRules:\n- This is a STATUS UPDATE, not the final answer\n- Never answer the user's request directly\n- Never switch into explanation mode\n- Never write a complete answer, even partially\n- Keep it short: exactly 4 short bullet points\n- Use the exact bullet labels below\n- Do NOT generate timing metadata lines\n- Do NOT generate task_id lines\n- Timing metadata is provided only so you understand task pace and recency\n- The system will append timing and task metadata separately\n- Prefer concrete progress over generic wording\n- Mention the most recent completed action before the current action\n- Do not claim completion unless the task is actually done\n- Do not mention internal implementation details unless they help explain the current work\n- Avoid repeating the previous update verbatim\n- Do not use code fences\n- Plain markdown text only\n\nRequired output format:\n- Progress: <very short overall progress statement, not a final answer>\n- Last done: <most recent completed action>\n- Now: <current action in progress>\n- Waiting on: <tool, search, model, user input, or \"nothing blocking right now\">\n\nTrace interpretation rules:\n- Translate internal trace phases into user-meaningful progress, do not just repeat raw span names\n- If the trace shows routing or classify work, describe that as understanding the request and choosing the right path\n- If the trace shows setup-projects, build-config, or loading context, describe that as preparing the workspace or gathering context\n- If the trace shows search, extract, code-explorer, or file inspection, describe that as investigating the codebase\n- If the trace shows engineer work, edits, tests, PR creation, or command execution, describe that as implementing or verifying changes\n- If the trace shows completion prompts, final answer generation, summarization, final validation, or output rendering, describe that as validating findings and preparing the final response\n- If the trace shows waiting on a long AI request, delegate, tool call, or sandboxed child task, describe that as waiting for analysis or validation to finish\n\nIf you are tempted to answer the user's question, stop and convert that into:\n- what was learned so far\n- what was just completed\n- what is still being checked\n\nBad update example:\n- \"API rate limiting works by...\"\n\nGood update example:\n- \"Progress: identified the gateway components involved in rate limiting\"\n- \"Last done: found the middleware files and session manager entry points\"\n- \"Now: tracing the enforcement path through the gateway\"\n- \"Waiting on: search results for the limiter implementation details\"";
export interface TaskLiveUpdateSink {
    readonly kind: string;
    start(): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    update(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    complete(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    fail(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
}
export interface TaskLiveUpdateDeps {
    summarizeProgress?: (input: TaskProgressSummaryInput) => Promise<string | null>;
    serializeTrace?: (traceRef: string, maxChars: number, traceId?: string) => Promise<string | undefined>;
    extractSkillMetadata?: (traceRef: string, traceId?: string) => Promise<TaskLiveUpdateSkillMetadata | undefined>;
}
export interface TaskProgressSummaryInput {
    requestText: string;
    previousUpdate?: string;
    traceSnapshot: string;
    config: RequiredTaskLiveUpdatesConfig;
    startedAt: Date;
    now: Date;
    elapsedSeconds: number;
    previousUpdateAt?: Date;
    secondsSincePreviousUpdate?: number;
}
interface TaskLiveUpdateSkillMetadata {
    activatedSkills?: string[];
    taskSummary?: ProbeTaskSummary;
}
export interface TaskLiveUpdateContext {
    taskId: string;
    requestText: string;
    traceRef?: string;
    traceId?: string;
    includeTraceId?: boolean;
    resolveTraceState?: () => {
        traceRef?: string;
        traceId?: string;
    };
    sink: TaskLiveUpdateSink;
    config: RequiredTaskLiveUpdatesConfig;
    onPostedRef?: (ref: Record<string, unknown>) => void;
    appendHistory?: (text: string, stage: 'started' | 'progress' | 'completed' | 'failed') => void;
}
export interface RequiredTaskLiveUpdatesConfig {
    enabled: boolean;
    intervalSeconds: number;
    model: string;
    provider?: string;
    prompt: string;
    initialMessage: string;
    maxTraceChars: number;
}
export declare function resolveTaskLiveUpdatesConfig(config?: boolean | TaskLiveUpdatesConfig | null): RequiredTaskLiveUpdatesConfig | null;
export declare function isFrontendLiveUpdatesEnabled(config: boolean | TaskLiveUpdatesConfig | null | undefined, frontend: 'slack' | 'telegram' | 'teams' | 'whatsapp'): boolean;
export declare class TaskLiveUpdateManager {
    private readonly ctx;
    private readonly deps;
    private timer?;
    private firstTickTimer?;
    private metadataRefreshTimer?;
    private running;
    private inflightTick?;
    private inflightMetadataRefresh?;
    private readonly inflightPublishes;
    private started;
    private completed;
    private readonly startedAt;
    private lastUpdateText?;
    private lastUpdateAt?;
    private lastTraceSnapshot?;
    private lastPostedMessage?;
    private lastStallFallbackAt?;
    private lastUpdateKind;
    private lastSkillMetadata?;
    constructor(ctx: TaskLiveUpdateContext, deps?: TaskLiveUpdateDeps);
    start(): Promise<void>;
    complete(finalText: string): Promise<void>;
    fail(finalText: string): Promise<void>;
    stop(): void;
    tick(): Promise<void>;
    private runTick;
    private runFirstTick;
    private waitForInflightSinkPublishes;
    private recordSinkRef;
    private trackPublish;
    private getTraceState;
    private decorateText;
    private decorateProgressText;
    private scheduleMetadataRefresh;
    private refreshProgressMetadata;
    private maybePublishStallFallback;
}
export declare function summarizeTaskProgress(input: TaskProgressSummaryInput): Promise<string | null>;
export declare function extractTraceSkillMetadata(traceRef: string, traceId?: string): Promise<TaskLiveUpdateSkillMetadata | undefined>;
export {};
//# sourceMappingURL=task-live-updates.d.ts.map