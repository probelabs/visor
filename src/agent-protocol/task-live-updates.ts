import crypto from 'crypto';
import { logger } from '../logger';
import type { TaskLiveUpdatesConfig } from '../types/config';
import { fetchTraceSpans, serializeTraceForPrompt } from './trace-serializer';

export const DEFAULT_TASK_LIVE_UPDATE_INTERVAL_SECONDS = 10;
export const DEFAULT_TASK_LIVE_UPDATE_MAX_TRACE_CHARS = 12_000;
export const DEFAULT_TASK_LIVE_UPDATE_FIRST_UPDATE_DELAY_SECONDS = 10;
export const DEFAULT_TASK_LIVE_UPDATE_METADATA_REFRESH_SECONDS = 5;
export const DEFAULT_TASK_LIVE_UPDATE_STALL_FALLBACK_SECONDS = 60;
export const DEFAULT_TASK_LIVE_UPDATE_MODEL = 'gemini-3.1-flash-lite-preview';
const DEFAULT_TASK_LIVE_UPDATE_STALL_NOTICE =
  '_No new meaningful progress is visible yet. Some steps can stay quiet for up to 5 minutes before there is new news._';

export const DEFAULT_TASK_LIVE_UPDATE_PROMPT = `You are generating a short live progress update for a user while an AI task is still running.

This is NOT the final answer.
Do NOT answer the user's original request.
Do NOT write the final solution.
Do NOT explain the topic in full.
Do NOT provide a root cause, recommendation, summary of findings, or conclusion.
Even if you think you already know the answer, do NOT give it here.

You will receive:
- the user's original request
- the previous progress update, if any
- timing metadata for this run
- the latest execution trace snapshot

Your job is to produce a concise status update that tells the user only:
- the overall progress so far
- the last meaningful action that finished
- what the agent is doing right now
- what it is likely waiting on, if anything

Rules:
- This is a STATUS UPDATE, not the final answer
- Never answer the user's request directly
- Never switch into explanation mode
- Never write a complete answer, even partially
- Keep it short: exactly 4 short bullet points
- Use the exact bullet labels below
- Do NOT generate timing metadata lines
- Do NOT generate task_id lines
- Timing metadata is provided only so you understand task pace and recency
- The system will append timing and task metadata separately
- Prefer concrete progress over generic wording
- Mention the most recent completed action before the current action
- Do not claim completion unless the task is actually done
- Do not mention internal implementation details unless they help explain the current work
- Avoid repeating the previous update verbatim
- Do not use code fences
- Plain markdown text only

Required output format:
- Progress: <very short overall progress statement, not a final answer>
- Last done: <most recent completed action>
- Now: <current action in progress>
- Waiting on: <tool, search, model, user input, or "nothing blocking right now">

Trace interpretation rules:
- Translate internal trace phases into user-meaningful progress, do not just repeat raw span names
- If the trace shows routing or classify work, describe that as understanding the request and choosing the right path
- If the trace shows setup-projects, build-config, or loading context, describe that as preparing the workspace or gathering context
- If the trace shows search, extract, code-explorer, or file inspection, describe that as investigating the codebase
- If the trace shows engineer work, edits, tests, PR creation, or command execution, describe that as implementing or verifying changes
- If the trace shows completion prompts, final answer generation, summarization, final validation, or output rendering, describe that as validating findings and preparing the final response
- If the trace shows waiting on a long AI request, delegate, tool call, or sandboxed child task, describe that as waiting for analysis or validation to finish

If you are tempted to answer the user's question, stop and convert that into:
- what was learned so far
- what was just completed
- what is still being checked

Bad update example:
- "API rate limiting works by..."

Good update example:
- "Progress: identified the gateway components involved in rate limiting"
- "Last done: found the middleware files and session manager entry points"
- "Now: tracing the enforcement path through the gateway"
- "Waiting on: search results for the limiter implementation details"`;

export interface TaskLiveUpdateSink {
  readonly kind: string;
  start(): Promise<{ ref?: Record<string, unknown> } | null>;
  update(text: string): Promise<{ ref?: Record<string, unknown> } | null>;
  complete(text: string): Promise<{ ref?: Record<string, unknown> } | null>;
  fail(text: string): Promise<{ ref?: Record<string, unknown> } | null>;
}

export interface TaskLiveUpdateDeps {
  summarizeProgress?: (input: TaskProgressSummaryInput) => Promise<string | null>;
  serializeTrace?: (
    traceRef: string,
    maxChars: number,
    traceId?: string
  ) => Promise<string | undefined>;
  extractSkillMetadata?: (
    traceRef: string,
    traceId?: string
  ) => Promise<TaskLiveUpdateSkillMetadata | undefined>;
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

interface ProgressTimingMetadata {
  elapsedSeconds: number;
  previousUpdateAt?: Date;
  secondsSincePreviousUpdate?: number;
  activatedSkills?: string[];
}

interface TaskLiveUpdateSkillMetadata {
  activatedSkills?: string[];
}

export interface TaskLiveUpdateContext {
  taskId: string;
  requestText: string;
  traceRef?: string;
  traceId?: string;
  includeTraceId?: boolean;
  resolveTraceState?: () => { traceRef?: string; traceId?: string };
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

export function resolveTaskLiveUpdatesConfig(
  config?: boolean | TaskLiveUpdatesConfig | null
): RequiredTaskLiveUpdatesConfig | null {
  if (!config) return null;
  if (config === true) {
    return {
      enabled: true,
      intervalSeconds: DEFAULT_TASK_LIVE_UPDATE_INTERVAL_SECONDS,
      model: DEFAULT_TASK_LIVE_UPDATE_MODEL,
      prompt: DEFAULT_TASK_LIVE_UPDATE_PROMPT,
      initialMessage: '',
      maxTraceChars: DEFAULT_TASK_LIVE_UPDATE_MAX_TRACE_CHARS,
    };
  }

  if (config.enabled === false) return null;

  return {
    enabled: true,
    intervalSeconds: Math.max(
      1,
      Math.floor(config.interval_seconds || DEFAULT_TASK_LIVE_UPDATE_INTERVAL_SECONDS)
    ),
    model: config.model || DEFAULT_TASK_LIVE_UPDATE_MODEL,
    provider: config.provider,
    prompt: config.prompt || DEFAULT_TASK_LIVE_UPDATE_PROMPT,
    initialMessage: config.initial_message || '',
    maxTraceChars: Math.max(
      1000,
      Math.floor(config.max_trace_chars || DEFAULT_TASK_LIVE_UPDATE_MAX_TRACE_CHARS)
    ),
  };
}

export function isFrontendLiveUpdatesEnabled(
  config: boolean | TaskLiveUpdatesConfig | null | undefined,
  frontend: 'slack' | 'telegram' | 'teams' | 'whatsapp'
): boolean {
  if (!config) return false;
  if (config === true) return true;
  if (config.enabled === false) return false;
  const frontendCfg = config.frontends?.[frontend];
  if (frontendCfg?.enabled === false) return false;
  return true;
}

export class TaskLiveUpdateManager {
  private readonly deps: Required<TaskLiveUpdateDeps>;
  private timer?: ReturnType<typeof setInterval>;
  private firstTickTimer?: ReturnType<typeof setTimeout>;
  private metadataRefreshTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private started = false;
  private completed = false;
  private readonly startedAt = new Date();
  private lastUpdateText?: string;
  private lastUpdateAt?: Date;
  private lastTraceSnapshot?: string;
  private lastPostedMessage?: string;
  private lastStallFallbackAt?: Date;
  private lastUpdateKind: 'semantic' | 'stall' = 'semantic';
  private lastSkillMetadata?: TaskLiveUpdateSkillMetadata;

  constructor(
    private readonly ctx: TaskLiveUpdateContext,
    deps?: TaskLiveUpdateDeps
  ) {
    this.deps = {
      summarizeProgress: deps?.summarizeProgress || summarizeTaskProgress,
      serializeTrace: deps?.serializeTrace || defaultSerializeTrace,
      extractSkillMetadata: deps?.extractSkillMetadata || extractTraceSkillMetadata,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const started = await this.ctx.sink.start();
      this.recordSinkRef(started);
      logger.info(
        `[TaskLiveUpdates] Started for task ${this.ctx.taskId}; first update in ${DEFAULT_TASK_LIVE_UPDATE_FIRST_UPDATE_DELAY_SECONDS}s, interval=${this.ctx.config.intervalSeconds}s, provider=${this.ctx.config.provider || 'default'}, model=${this.ctx.config.model}`
      );
    } catch (err) {
      logger.warn(
        `[TaskLiveUpdates] Failed to initialize live updates for task ${this.ctx.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    this.firstTickTimer = setTimeout(() => {
      void this.runFirstTick();
    }, DEFAULT_TASK_LIVE_UPDATE_FIRST_UPDATE_DELAY_SECONDS * 1000);
    if (typeof (this.firstTickTimer as any)?.unref === 'function') {
      (this.firstTickTimer as any).unref();
    }
  }

  async complete(finalText: string): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    this.stop();
    try {
      logger.info(`[TaskLiveUpdates] Publishing final success update for task ${this.ctx.taskId}`);
      const result = await this.ctx.sink.complete(this.decorateText(finalText));
      this.recordSinkRef(result);
      this.ctx.appendHistory?.(finalText, 'completed');
    } catch (err) {
      logger.warn(
        `[TaskLiveUpdates] Failed to publish final update for task ${this.ctx.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async fail(finalText: string): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    this.stop();
    try {
      logger.info(`[TaskLiveUpdates] Publishing final failure update for task ${this.ctx.taskId}`);
      const result = await this.ctx.sink.fail(this.decorateText(finalText));
      this.recordSinkRef(result);
      this.ctx.appendHistory?.(finalText, 'failed');
    } catch (err) {
      logger.warn(
        `[TaskLiveUpdates] Failed to publish failure update for task ${this.ctx.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  stop(): void {
    if (this.firstTickTimer) {
      clearTimeout(this.firstTickTimer);
      this.firstTickTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.metadataRefreshTimer) {
      clearInterval(this.metadataRefreshTimer);
      this.metadataRefreshTimer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.completed || this.running) return;
    const traceState = this.getTraceState();
    if (!traceState.traceRef && !traceState.traceId) {
      logger.debug(
        `[TaskLiveUpdates] Skipping tick for task ${this.ctx.taskId}: no trace reference available yet`
      );
      return;
    }
    this.running = true;
    try {
      const traceRef = traceState.traceRef || traceState.traceId!;
      const traceSnapshot = await this.deps.serializeTrace(
        traceRef,
        this.ctx.config.maxTraceChars,
        traceState.traceId
      );
      if (this.completed) {
        logger.debug(
          `[TaskLiveUpdates] Aborting in-flight tick for task ${this.ctx.taskId}: task already completed`
        );
        return;
      }
      if (!traceSnapshot || traceSnapshot === '(no trace data available)') {
        logger.debug(
          `[TaskLiveUpdates] Skipping tick for task ${this.ctx.taskId}: no trace data available yet (traceRef=${traceRef})`
        );
        return;
      }
      if (traceSnapshot === this.lastTraceSnapshot) {
        await this.maybePublishStallFallback(traceSnapshot, traceState.traceId);
        logger.debug(
          `[TaskLiveUpdates] Skipping tick for task ${this.ctx.taskId}: trace snapshot unchanged`
        );
        return;
      }

      const summary = await this.deps.summarizeProgress({
        requestText: this.ctx.requestText,
        previousUpdate: this.lastUpdateText,
        traceSnapshot,
        config: this.ctx.config,
        startedAt: this.startedAt,
        now: new Date(),
        elapsedSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt.getTime()) / 1000)),
        previousUpdateAt: this.lastUpdateAt,
        secondsSincePreviousUpdate: this.lastUpdateAt
          ? Math.max(0, Math.floor((Date.now() - this.lastUpdateAt.getTime()) / 1000))
          : undefined,
      });
      if (this.completed) {
        logger.debug(
          `[TaskLiveUpdates] Aborting in-flight tick for task ${this.ctx.taskId}: task already completed after summarization`
        );
        return;
      }
      const cleaned = summary?.trim();
      if (!cleaned || cleaned === this.lastUpdateText) {
        await this.maybePublishStallFallback(traceSnapshot, traceState.traceId);
        logger.debug(
          `[TaskLiveUpdates] Skipping tick for task ${this.ctx.taskId}: summary empty or unchanged`
        );
        this.lastTraceSnapshot = traceSnapshot;
        return;
      }

      logger.info(
        `[TaskLiveUpdates] Publishing progress update for task ${this.ctx.taskId}: ${cleaned.slice(0, 160)}`
      );
      this.lastSkillMetadata = await this.deps.extractSkillMetadata(traceRef, traceState.traceId);
      this.lastUpdateKind = 'semantic';
      const message = this.decorateProgressText(
        cleaned,
        {
          elapsedSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt.getTime()) / 1000)),
          previousUpdateAt: this.lastUpdateAt,
          secondsSincePreviousUpdate: this.lastUpdateAt
            ? Math.max(0, Math.floor((Date.now() - this.lastUpdateAt.getTime()) / 1000))
            : undefined,
          activatedSkills: this.lastSkillMetadata?.activatedSkills,
        },
        traceState.traceId
      );
      const result = await this.ctx.sink.update(message);
      this.recordSinkRef(result);
      this.ctx.appendHistory?.(cleaned, 'progress');
      this.lastUpdateText = cleaned;
      this.lastUpdateAt = new Date();
      this.lastTraceSnapshot = traceSnapshot;
      this.lastPostedMessage = message;
      this.lastStallFallbackAt = undefined;
    } catch (err) {
      logger.warn(
        `[TaskLiveUpdates] Progress update failed for task ${this.ctx.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      this.running = false;
    }
  }

  private async runFirstTick(): Promise<void> {
    if (this.completed) return;
    logger.debug(`[TaskLiveUpdates] Running first scheduled tick for task ${this.ctx.taskId}`);
    await this.tick();
    if (this.completed) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.ctx.config.intervalSeconds * 1000);
    if (typeof (this.timer as any)?.unref === 'function') {
      (this.timer as any).unref();
    }
    this.metadataRefreshTimer = setInterval(() => {
      void this.refreshProgressMetadata();
    }, DEFAULT_TASK_LIVE_UPDATE_METADATA_REFRESH_SECONDS * 1000);
    if (typeof (this.metadataRefreshTimer as any)?.unref === 'function') {
      (this.metadataRefreshTimer as any).unref();
    }
  }

  private recordSinkRef(result: { ref?: Record<string, unknown> } | null | undefined): void {
    if (result?.ref) this.ctx.onPostedRef?.(result.ref);
  }

  private getTraceState(): { traceRef?: string; traceId?: string } {
    const resolved = this.ctx.resolveTraceState?.();
    return {
      traceRef: resolved?.traceRef || this.ctx.traceRef,
      traceId: resolved?.traceId || this.ctx.traceId,
    };
  }

  private decorateText(text: string, _traceId?: string): string {
    if (!this.ctx.includeTraceId) return text;
    if (text.includes(`task_id: ${this.ctx.taskId}`)) return text;
    return `${text}\n\n\`task_id: ${this.ctx.taskId}\``;
  }

  private decorateProgressText(
    text: string,
    timing: ProgressTimingMetadata,
    traceId?: string
  ): string {
    const normalized = normalizeProgressSummary(text);
    const blocks = [
      '*Live Update*',
      '_Current task is still running. This message updates in place until the final answer is ready._',
      this.lastUpdateKind === 'stall' ? DEFAULT_TASK_LIVE_UPDATE_STALL_NOTICE : '',
      normalized,
      formatProgressMetadata(timing),
    ].filter(Boolean);
    return this.decorateText(blocks.join('\n\n'), traceId);
  }

  private async refreshProgressMetadata(): Promise<void> {
    if (this.completed || this.running || !this.lastUpdateText) return;
    const traceState = this.getTraceState();
    const message = this.decorateProgressText(
      this.lastUpdateText,
      {
        elapsedSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt.getTime()) / 1000)),
        previousUpdateAt: this.lastUpdateAt,
        secondsSincePreviousUpdate: this.lastUpdateAt
          ? Math.max(0, Math.floor((Date.now() - this.lastUpdateAt.getTime()) / 1000))
          : undefined,
        activatedSkills: this.lastSkillMetadata?.activatedSkills,
      },
      traceState.traceId
    );
    if (!message || message === this.lastPostedMessage) return;
    if (this.completed) return;
    try {
      logger.debug(
        `[TaskLiveUpdates] Refreshing metadata-only live update for task ${this.ctx.taskId}`
      );
      const result = await this.ctx.sink.update(message);
      this.recordSinkRef(result);
      this.lastPostedMessage = message;
    } catch (err) {
      logger.warn(
        `[TaskLiveUpdates] Metadata refresh failed for task ${this.ctx.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private async maybePublishStallFallback(traceSnapshot: string, traceId?: string): Promise<void> {
    if (this.completed) return;
    const now = new Date();
    if (
      this.lastStallFallbackAt &&
      now.getTime() - this.lastStallFallbackAt.getTime() <
        DEFAULT_TASK_LIVE_UPDATE_STALL_FALLBACK_SECONDS * 1000
    ) {
      return;
    }
    if (
      this.lastUpdateAt &&
      now.getTime() - this.lastUpdateAt.getTime() <
        DEFAULT_TASK_LIVE_UPDATE_STALL_FALLBACK_SECONDS * 1000
    ) {
      return;
    }
    this.lastSkillMetadata = await this.deps.extractSkillMetadata(
      this.getTraceState().traceRef || traceId || '',
      traceId
    );

    const fallback = buildStallFallbackSummary(traceSnapshot, this.lastUpdateText);
    const baseText = this.lastUpdateText || fallback;
    if (!baseText) return;

    logger.info(
      `[TaskLiveUpdates] Publishing stall notice for task ${this.ctx.taskId}: ${baseText.slice(0, 160)}`
    );
    this.lastUpdateKind = 'stall';
    if (this.completed) return;
    const message = this.decorateProgressText(
      baseText,
      {
        elapsedSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt.getTime()) / 1000)),
        previousUpdateAt: this.lastUpdateAt,
        secondsSincePreviousUpdate: this.lastUpdateAt
          ? Math.max(0, Math.floor((Date.now() - this.lastUpdateAt.getTime()) / 1000))
          : undefined,
        activatedSkills: this.lastSkillMetadata?.activatedSkills,
      },
      traceId
    );
    if (message === this.lastPostedMessage) {
      this.lastStallFallbackAt = now;
      return;
    }
    const result = await this.ctx.sink.update(message);
    this.recordSinkRef(result);
    if (!this.lastUpdateText) {
      this.ctx.appendHistory?.(baseText, 'progress');
      this.lastUpdateText = baseText;
      this.lastUpdateAt = now;
    }
    this.lastPostedMessage = message;
    this.lastStallFallbackAt = now;
  }
}

async function defaultSerializeTrace(
  traceRef: string,
  maxChars: number,
  traceId?: string
): Promise<string | undefined> {
  logger.debug(
    `[TaskLiveUpdates] Serializing trace for progress update (traceRef=${traceRef}, traceId=${traceId || '-'}, sink=${process.env.VISOR_TELEMETRY_SINK || 'auto'})`
  );
  return serializeTraceForPrompt(traceRef, maxChars, undefined, undefined, traceId);
}

export async function summarizeTaskProgress(
  input: TaskProgressSummaryInput
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ProbeAgent } = require('@probelabs/probe');

  const agentOptions: Record<string, unknown> = {
    sessionId: `visor-task-progress-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    systemPrompt: input.config.prompt,
    maxIterations: 1,
    disableTools: true,
  };
  if (input.config.model) agentOptions.model = input.config.model;
  if (input.config.provider) agentOptions.provider = input.config.provider;

  const agent = new ProbeAgent(agentOptions);
  if (typeof agent.initialize === 'function') {
    await agent.initialize();
  }

  const userPrompt = [
    `<user_request>\n${input.requestText}\n</user_request>`,
    input.previousUpdate
      ? `<previous_update>\n${input.previousUpdate}\n</previous_update>`
      : '<previous_update>(none)</previous_update>',
    `<timing>\nstarted_at: ${input.startedAt.toISOString()}\nnow: ${input.now.toISOString()}\nelapsed: ${formatDuration(input.elapsedSeconds)}\nlast_update_at: ${input.previousUpdateAt ? input.previousUpdateAt.toISOString() : '(none)'}\ntime_since_last_update: ${
      input.previousUpdateAt ? formatDuration(input.secondsSincePreviousUpdate || 0) : '(none)'
    }\n</timing>`,
    `<execution_trace>\n${input.traceSnapshot}\n</execution_trace>`,
  ].join('\n\n');

  const response = await agent.answer(userPrompt);
  const cleaned = response
    .replace(/^```(?:markdown|md|text)?\s*\n?/i, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  return cleaned || null;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0 || parts.length === 0) parts.push(`${remainingSeconds}s`);
  return parts.join(' ');
}

function normalizeProgressSummary(text: string): string {
  const wantedLabels = ['Progress', 'Last done', 'Now', 'Waiting on'];
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const matched = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^-?\s*(Progress|Last done|Now|Waiting on|Timing)\s*:\s*(.+)$/i);
    if (!match) continue;
    const label = match[1].toLowerCase();
    if (label === 'timing') continue;
    const canonical = wantedLabels.find(item => item.toLowerCase() === label);
    if (canonical && !matched.has(canonical)) {
      matched.set(canonical, match[2].trim());
    }
  }

  if (matched.size === wantedLabels.length) {
    return wantedLabels.map(label => `- ${label}: ${matched.get(label)}`).join('\n');
  }

  const withoutTiming = lines.filter(line => !/^-?\s*(Timing|Metadata|Trace)\s*:/i.test(line));
  return withoutTiming.join('\n');
}

function formatProgressMetadata(timing: ProgressTimingMetadata): string {
  const parts = [`elapsed ${formatDuration(timing.elapsedSeconds)}`];
  if (timing.previousUpdateAt) {
    parts.push(`previous update ${formatDuration(timing.secondsSincePreviousUpdate || 0)} ago`);
    parts.push(`at ${timing.previousUpdateAt.toISOString()}`);
  } else {
    parts.push('first live update');
  }
  if (timing.activatedSkills && timing.activatedSkills.length > 0) {
    parts.push(`activated skills ${formatSkillList(timing.activatedSkills)}`);
  }
  return `_Metadata: ${parts.join(' | ')}_`;
}

function formatSkillList(skills: string[]): string {
  const normalized = dedupeStrings(skills);
  if (normalized.length <= 4) return normalized.join(', ');
  return `${normalized.slice(0, 4).join(', ')} +${normalized.length - 4} more`;
}

function dedupeStrings(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

async function extractTraceSkillMetadata(
  traceRef: string,
  traceId?: string
): Promise<TaskLiveUpdateSkillMetadata | undefined> {
  if (!traceRef && !traceId) return undefined;
  try {
    const spans = await fetchTraceSpans(traceId || traceRef);
    if (!spans.length) return undefined;

    const routeIntentSpan = spans.find(
      span => span.attributes['visor.check.id'] === 'route-intent'
    );
    const buildConfigSpan = spans.find(
      span => span.attributes['visor.check.id'] === 'build-config'
    );
    const classifySpan = spans.find(span => span.attributes['visor.check.id'] === 'classify');

    const routeIntentOutput = parseJsonAttribute(routeIntentSpan?.attributes['visor.check.output']);
    const classifyOutput = parseJsonAttribute(classifySpan?.attributes['visor.check.output']);
    const buildConfigOutput = parseJsonAttribute(buildConfigSpan?.attributes['visor.check.output']);

    const activatedSkills = dedupeStrings(
      Array.isArray(buildConfigOutput?.activated_skills)
        ? buildConfigOutput.activated_skills
        : undefined
    );

    const fallbackActivatedSkills = dedupeStrings(
      (Array.isArray(routeIntentOutput?.skills) ? routeIntentOutput.skills : undefined) ||
        (Array.isArray(classifyOutput?.skills) ? classifyOutput.skills : undefined)
    );

    const finalActivatedSkills =
      activatedSkills.length > 0 ? activatedSkills : fallbackActivatedSkills;
    if (!finalActivatedSkills.length) return undefined;
    return { activatedSkills: finalActivatedSkills };
  } catch (err) {
    logger.debug(
      `[TaskLiveUpdates] Failed to extract skill metadata from trace: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return undefined;
  }
}

function parseJsonAttribute(value: unknown): Record<string, any> | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildStallFallbackSummary(traceSnapshot: string, previousUpdate?: string): string {
  const lastDone =
    extractProgressField(previousUpdate, 'Last done') ||
    'continuing from the last completed analysis step';

  const lower = traceSnapshot.toLowerCase();
  let now = 'waiting for the current analysis step to finish';
  let waitingOn = 'the current analysis step to complete';

  if (
    lower.includes('search.delegate') ||
    lower.includes('tool: search') ||
    lower.includes('search(')
  ) {
    now = 'running or waiting on the current code search step';
    waitingOn = 'search results and downstream analysis to finish';
  } else if (lower.includes('extract(') || lower.includes('tool: extract')) {
    now = 'extracting the relevant code or documentation context';
    waitingOn = 'the extract step to finish and be interpreted';
  } else if (lower.includes('engineer-task') || lower.includes('engineer')) {
    now = 'waiting on the current implementation or validation step';
    waitingOn = 'the engineer workflow to finish the current step';
  } else if (
    lower.includes('ai.request') ||
    lower.includes('gemini') ||
    lower.includes('claude') ||
    lower.includes('openai')
  ) {
    now = 'waiting on the current model analysis step';
    waitingOn = 'the active model response to finish';
  } else if (lower.includes('bash(') || lower.includes('go test') || lower.includes('npm test')) {
    now = 'running or waiting on command-based validation';
    waitingOn = 'the current command or test run to finish';
  } else if (lower.includes('setup-projects') || lower.includes('build-config')) {
    now = 'preparing the workspace and loading the required context';
    waitingOn = 'workspace setup and context loading to finish';
  }

  return [
    '- Progress: still working through the same step; no new completed action yet',
    `- Last done: ${lastDone}`,
    `- Now: ${now}`,
    `- Waiting on: ${waitingOn}`,
  ].join('\n');
}

function extractProgressField(text: string | undefined, label: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(new RegExp(`(?:^|\\n)-?\\s*${escapeRegExp(label)}\\s*:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
