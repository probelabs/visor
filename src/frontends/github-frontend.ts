import type { Frontend, FrontendContext } from './host';
import { logger } from '../logger';

/**
 * Skeleton GitHub frontend.
 * - Subscribes to engine events via EventBus when present
 * - Maps key events to debug logs for now (no side effects)
 * - Real implementation will upsert checks and manage grouped PR comments
 */
type SectionState = {
  status: 'queued' | 'in_progress' | 'completed' | 'errored';
  conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
  issues?: number;
  lastUpdated: string;
  error?: string;
  content?: string;
};

export class GitHubFrontend implements Frontend {
  public readonly name = 'github';
  private subs: Array<{ unsubscribe(): void }> = [];
  private checkRunIds: Map<string, number> = new Map();
  private revision = 0;
  private cachedCommentId?: string; // legacy single-thread id (kept for compatibility)
  // Group → (checkId → SectionState)
  private stepStatusByGroup: Map<string, Map<string, SectionState>> = new Map();

  // Debounce/coalescing state
  private debounceMs: number = 400;
  private maxWaitMs: number = 2000;
  private _timer: NodeJS.Timeout | null = null;
  private _lastFlush: number = 0;
  private _pendingIds: Set<string> = new Set<string>();

  // Mutex for serializing comment updates per group
  private updateLocks: Map<string, Promise<void>> = new Map();
  public minUpdateDelayMs: number = 1000; // Minimum delay between updates (public for testing)

  start(ctx: FrontendContext): void {
    const log = ctx.logger;
    const bus = ctx.eventBus;
    const octokit = (ctx as any).octokit;
    const repo = ctx.run.repo;
    const pr = ctx.run.pr;
    const headSha = ctx.run.headSha;

    // Determine capabilities separately for comments vs check runs
    const canPostComments = !!(octokit && repo && pr);
    const canPostChecks = !!(octokit && repo && pr && headSha);

    // Create helpers if possible
    const svc = canPostChecks
      ? new (require('../github-check-service').GitHubCheckService)(octokit)
      : null;
    const CommentManager = require('../github-comments').CommentManager;
    const comments = canPostComments ? new CommentManager(octokit) : null;

    const threadKey =
      repo && pr && headSha
        ? `${repo.owner}/${repo.name}#${pr}@${(headSha || '').substring(0, 7)}`
        : ctx.run.runId;
    this.cachedCommentId = `visor-thread-${threadKey}`;

    // CheckScheduled → create queued check run
    this.subs.push(
      bus.on('CheckScheduled', async (env: any) => {
        const ev = (env && env.payload) || env;
        try {
          if (!canPostChecks || !svc) return;
          if (this.checkRunIds.has(ev.checkId)) return; // already created
          // Update local model only (no comment yet; wait for content)
          const group = this.getGroupForCheck(ctx, ev.checkId);
          this.upsertSectionState(group, ev.checkId, {
            status: 'queued',
            lastUpdated: new Date().toISOString(),
          });
          // Do not call updateGroupedComment here — avoid "queued" placeholder comments
          const res = await svc.createCheckRun(
            {
              owner: repo!.owner,
              repo: repo!.name,
              head_sha: headSha!,
              name: `Visor: ${ev.checkId}`,
              external_id: `visor:${ctx.run.runId}:${ev.checkId}`,
              engine_mode: 'state-machine',
            },
            { title: `${ev.checkId}`, summary: 'Queued' }
          );
          this.checkRunIds.set(ev.checkId, res.id);
        } catch (e) {
          log.warn(
            `[github-frontend] createCheckRun failed for ${ev.checkId}: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );

    // CheckCompleted → complete check run and update grouped comment
    this.subs.push(
      bus.on('CheckCompleted', async (env: any) => {
        const ev = (env && env.payload) || env;
        try {
          // Complete check run (only when we have headSha)
          if (canPostChecks && svc && this.checkRunIds.has(ev.checkId)) {
            const id = this.checkRunIds.get(ev.checkId)!;
            const issues = Array.isArray(ev.result?.issues) ? ev.result.issues : [];
            // Evaluate failure conditions so GitHub conclusion reflects actual pass/fail
            const failureResults = await this.evaluateFailureResults(ctx, ev.checkId, ev.result);
            await svc.completeCheckRun(
              repo!.owner,
              repo!.name,
              id,
              ev.checkId,
              failureResults,
              issues,
              undefined,
              undefined,
              pr!,
              headSha!
            );
          }

          // Update grouped summary comment
          if (canPostComments && comments) {
            const count = Array.isArray(ev.result?.issues) ? ev.result.issues.length : 0;
            const failureResults = await this.evaluateFailureResults(ctx, ev.checkId, ev.result);
            const failed = Array.isArray(failureResults)
              ? failureResults.some((r: any) => r && r.failed)
              : false;
            const group = this.getGroupForCheck(ctx, ev.checkId);
            this.upsertSectionState(group, ev.checkId, {
              status: 'completed',
              conclusion: failed ? 'failure' : 'success',
              issues: count,
              lastUpdated: new Date().toISOString(),
              content: (ev?.result as any)?.content,
            });
            await this.updateGroupedComment(ctx, comments, group, ev.checkId);
          }
        } catch (e) {
          log.warn(
            `[github-frontend] handle CheckCompleted failed: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );

    // CheckErrored → mark failure and update comment
    this.subs.push(
      bus.on('CheckErrored', async (env: any) => {
        const ev = (env && env.payload) || env;
        try {
          if (canPostChecks && svc && this.checkRunIds.has(ev.checkId)) {
            const id = this.checkRunIds.get(ev.checkId)!;
            await svc.completeCheckRun(
              repo!.owner,
              repo!.name,
              id,
              ev.checkId,
              [],
              [],
              ev.error?.message || 'Execution error',
              undefined,
              pr!,
              headSha!
            );
          }
          if (canPostComments && comments) {
            const group = this.getGroupForCheck(ctx, ev.checkId);
            this.upsertSectionState(group, ev.checkId, {
              status: 'errored',
              conclusion: 'failure',
              issues: 0,
              lastUpdated: new Date().toISOString(),
              error: ev.error?.message || 'Execution error',
            });
            await this.updateGroupedComment(ctx, comments, group, ev.checkId);
          }
        } catch (e) {
          log.warn(
            `[github-frontend] handle CheckErrored failed: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );

    // StateTransition: update summary on terminal
    this.subs.push(
      bus.on('StateTransition', async (env: any) => {
        const ev = (env && env.payload) || env;
        try {
          if (ev.to === 'Completed' || ev.to === 'Error') {
            if (canPostComments && comments) {
              for (const group of this.stepStatusByGroup.keys()) {
                await this.updateGroupedComment(ctx, comments, group);
              }
            }
          }
        } catch (e) {
          log.warn(
            `[github-frontend] handle StateTransition failed: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  private async buildFullBody(ctx: FrontendContext, group: string): Promise<string> {
    const header = this.renderThreadHeader(ctx, group);
    const sections = this.renderSections(ctx, group);
    return `${header}

${sections}

<!-- visor:thread-end key="${this.threadKeyFor(ctx)}" -->`;
  }

  private threadKeyFor(ctx: FrontendContext): string {
    const r = ctx.run;
    return r.repo && r.pr && r.headSha
      ? `${r.repo.owner}/${r.repo.name}#${r.pr}@${(r.headSha || '').substring(0, 7)}`
      : r.runId;
  }

  private renderThreadHeader(ctx: FrontendContext, group: string): string {
    const header = {
      key: this.threadKeyFor(ctx),
      runId: ctx.run.runId,
      workflowId: ctx.run.workflowId,
      revision: this.revision,
      group,
      generatedAt: new Date().toISOString(),
    } as any;
    return `<!-- visor:thread=${JSON.stringify(header)} -->`;
  }

  private renderSections(ctx: FrontendContext, group: string): string {
    const lines: string[] = [];
    const groupMap = this.stepStatusByGroup.get(group) || new Map<string, SectionState>();
    for (const [checkId, st] of groupMap.entries()) {
      const start = `<!-- visor:section=${JSON.stringify({ id: checkId, revision: this.revision })} -->`;
      const end = `<!-- visor:section-end id="${checkId}" -->`;
      const body =
        st.content && st.content.toString().trim().length > 0 ? st.content.toString().trim() : '';
      lines.push(`${start}
${body}
${end}`);
    }
    return lines.join('\\n\\n');
  }

  /**
   * Acquires a mutex lock for the given group and executes the update.
   * This ensures only one comment update happens at a time per group,
   * preventing race conditions where updates overwrite each other.
   */
  private async updateGroupedComment(
    ctx: FrontendContext,
    comments: any,
    group: string,
    changedIds?: string | string[]
  ) {
    // Wait for any existing update to complete for this group
    const existingLock = this.updateLocks.get(group);
    if (existingLock) {
      try {
        await existingLock;
      } catch (error) {
        logger.warn(
          `[github-frontend] Previous update for group ${group} failed: ${error instanceof Error ? error.message : error}`
        );
        // Continue with current update despite previous failure
      }
    }

    // Create a new lock for this update
    const updatePromise = this.performGroupedCommentUpdate(ctx, comments, group, changedIds);
    this.updateLocks.set(group, updatePromise);

    try {
      await updatePromise;
    } finally {
      // Clean up the lock if it's still ours
      if (this.updateLocks.get(group) === updatePromise) {
        this.updateLocks.delete(group);
      }
    }
  }

  /**
   * Performs the actual comment update with delay enforcement.
   */
  private async performGroupedCommentUpdate(
    ctx: FrontendContext,
    comments: any,
    group: string,
    changedIds?: string | string[]
  ) {
    try {
      if (!ctx.run.repo || !ctx.run.pr) return;

      // Check if PR comments are enabled (default to true if not specified)
      const config = ctx.config as any;
      const prCommentEnabled = config?.output?.pr_comment?.enabled !== false;
      if (!prCommentEnabled) {
        logger.debug(
          `[github-frontend] PR comments disabled in config, skipping comment for group: ${group}`
        );
        return;
      }

      // Enforce minimum delay between updates to prevent API rate limiting
      const timeSinceLastFlush = Date.now() - this._lastFlush;
      if (this._lastFlush > 0 && timeSinceLastFlush < this.minUpdateDelayMs) {
        const delay = this.minUpdateDelayMs - timeSinceLastFlush;
        logger.debug(`[github-frontend] Waiting ${delay}ms before next update to prevent rate limiting`);
        await this.sleep(delay);
      }

      this.revision++;
      const mergedBody = await this.mergeIntoExistingBody(ctx, comments, group, changedIds);
      await comments.updateOrCreateComment(
        ctx.run.repo.owner,
        ctx.run.repo.name,
        ctx.run.pr,
        mergedBody,
        {
          commentId: this.commentIdForGroup(ctx, group),
          triggeredBy: this.deriveTriggeredBy(ctx),
          commitSha: ctx.run.headSha,
        }
      );

      this._lastFlush = Date.now();
    } catch (e) {
      logger.debug(
        `[github-frontend] updateGroupedComment failed: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  private deriveTriggeredBy(ctx: FrontendContext): string {
    const ev = (ctx.run as any).event || '';
    const actor = (ctx.run as any).actor;
    const commentEvents = new Set([
      'issue_comment',
      'issue_comment_created',
      'pr_comment',
      'comment',
      'pull_request_review_comment',
    ]);
    if (commentEvents.has(ev) && actor) return actor;
    if (ev) return ev;
    return actor || 'unknown';
  }

  private async mergeIntoExistingBody(
    ctx: FrontendContext,
    comments: any,
    group: string,
    changedIds?: string | string[]
  ): Promise<string> {
    const repo = ctx.run.repo!;
    const pr = ctx.run.pr!;
    const existing = await comments.findVisorComment(
      repo.owner,
      repo.name,
      pr,
      this.commentIdForGroup(ctx, group)
    );
    if (!existing || !existing.body) return this.buildFullBody(ctx, group);
    const body = String(existing.body);
    const doc = this.parseSections(body);
    doc.header = {
      ...(doc.header || {}),
      key: this.threadKeyFor(ctx),
      revision: this.revision,
      group,
    } as any;
    if (changedIds) {
      const ids = Array.isArray(changedIds) ? changedIds : [changedIds];
      const fresh = this.renderSections(ctx, group);
      for (const id of ids) {
        const block = this.extractSectionById(fresh, id);
        if (block) doc.sections.set(id, block);
      }
    } else {
      // Add any missing new sections; leave others untouched to preserve text
      const fresh = this.renderSections(ctx, group);
      const map = this.stepStatusByGroup.get(group) || new Map<string, SectionState>();
      for (const [checkId] of map.entries()) {
        if (!doc.sections.has(checkId)) {
          const block = this.extractSectionById(fresh, checkId);
          if (block) doc.sections.set(checkId, block);
        }
      }
    }
    return this.serializeSections(doc);
  }

  private parseSections(body: string): { header?: any; sections: Map<string, string> } {
    const sections = new Map<string, string>();
    const headerRe = /<!--\s*visor:thread=(\{[\s\S]*?\})\s*-->/m;
    const startRe = /<!--\s*visor:section=(\{[\s\S]*?\})\s*-->/g;
    const endRe = /<!--\s*visor:section-end\s+id=\"([^\"]+)\"\s*-->/g;

    // Helper: safely parse JSON and pick only allowed keys
    const safePick = (obj: any, allowed: Record<string, 'string' | 'number'>) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
      const out: Record<string, unknown> = Object.create(null);
      for (const [k, t] of Object.entries(allowed)) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          const v = (obj as any)[k];
          if (t === 'string' && typeof v === 'string') out[k] = v;
          else if (t === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        }
      }
      return out;
    };

    const safeParse = (text: string) => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };

    let header: any;
    try {
      const h = headerRe.exec(body);
      if (h) {
        const parsed = safeParse(h[1]);
        const picked = safePick(parsed, {
          key: 'string',
          runId: 'string',
          workflowId: 'string',
          revision: 'number',
          group: 'string',
          generatedAt: 'string',
        });
        header = picked;
      }
    } catch {}

    let cursor = 0;
    while (true) {
      const s = startRe.exec(body);
      if (!s) break;
      const metaRaw = safeParse(s[1]);
      const meta = safePick(metaRaw, { id: 'string', revision: 'number' }) || { id: '' };
      const startIdx = startRe.lastIndex;
      endRe.lastIndex = startIdx;
      const e = endRe.exec(body);
      if (!e) break;
      const id =
        typeof (meta as any).id === 'string' && (meta as any).id
          ? String((meta as any).id)
          : String(e[1]);
      const content = body.substring(startIdx, e.index).trim();
      const block = `<!-- visor:section=${JSON.stringify(meta)} -->\n${content}\n<!-- visor:section-end id="${id}" -->`;
      sections.set(id, block);
      cursor = endRe.lastIndex;
      startRe.lastIndex = cursor;
    }
    return { header, sections };
  }

  private serializeSections(doc: { header?: any; sections: Map<string, string> }): string {
    const header = `<!-- visor:thread=${JSON.stringify({ ...(doc.header || {}), generatedAt: new Date().toISOString() })} -->`;
    const blocks = Array.from(doc.sections.values()).join('\n\n');
    const key = (doc.header && (doc.header as any).key) || '';
    return `${header}\n\n${blocks}\n\n<!-- visor:thread-end key="${key}" -->`;
  }

  private extractSectionById(rendered: string, id: string): string | undefined {
    const rx = new RegExp(
      `<!--\\s*visor:section=(\\{[\\s\\S]*?\\})\\s*-->[\\s\\S]*?<!--\\s*visor:section-end\\s+id=\\"${this.escapeRegExp(id)}\\"\\s*-->`,
      'm'
    );
    const m = rx.exec(rendered);
    return m ? m[0] : undefined;
  }

  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  }

  private getGroupForCheck(ctx: FrontendContext, checkId: string): string {
    try {
      const cfg: any = ctx.config || {};
      const g = cfg?.checks?.[checkId]?.group || cfg?.steps?.[checkId]?.group;
      if (typeof g === 'string' && g.trim().length > 0) return g;
    } catch {}
    return 'review';
  }

  private upsertSectionState(group: string, checkId: string, patch: Partial<SectionState>): void {
    let groupMap = this.stepStatusByGroup.get(group);
    if (!groupMap) {
      groupMap = new Map<string, SectionState>();
      this.stepStatusByGroup.set(group, groupMap);
    }
    const prev =
      groupMap.get(checkId) ||
      ({ status: 'queued', lastUpdated: new Date().toISOString() } as SectionState);
    groupMap.set(checkId, { ...prev, ...patch });
  }

  private commentIdForGroup(ctx: FrontendContext, group: string): string {
    // Stable per-PR per-group ID (does not include commit SHA)
    const r = ctx.run;
    const base = r.repo && r.pr ? `${r.repo.owner}/${r.repo.name}#${r.pr}` : r.runId;
    return `visor-thread-${group}-${base}`;
  }

  /**
   * Compute failure condition results for a completed check so Check Runs map to the
   * correct GitHub conclusion. This mirrors the engine's evaluation for fail_if.
   */
  private async evaluateFailureResults(
    ctx: FrontendContext,
    checkId: string,
    result: { issues?: any[]; output?: unknown }
  ): Promise<any[]> {
    try {
      const config: any = ctx.config || {};
      const checks = (config && config.checks) || {};
      const checkCfg = checks[checkId] || {};
      const checkSchema = typeof checkCfg.schema === 'string' ? checkCfg.schema : 'code-review';
      const checkGroup = checkCfg.group || 'default';

      const { FailureConditionEvaluator } = require('../failure-condition-evaluator');
      const evaluator = new FailureConditionEvaluator();
      const reviewSummary = { issues: Array.isArray(result?.issues) ? result.issues : [] };

      const failures: any[] = [];

      // Global fail_if
      if (config.fail_if) {
        const failed = await evaluator.evaluateSimpleCondition(
          checkId,
          checkSchema,
          checkGroup,
          reviewSummary,
          config.fail_if
        );
        failures.push({
          conditionName: 'global_fail_if',
          failed,
          expression: config.fail_if,
          severity: 'error',
          haltExecution: false,
        });
      }

      // Check-level fail_if
      if (checkCfg.fail_if) {
        const failed = await evaluator.evaluateSimpleCondition(
          checkId,
          checkSchema,
          checkGroup,
          reviewSummary,
          checkCfg.fail_if
        );
        failures.push({
          conditionName: `${checkId}_fail_if`,
          failed,
          expression: checkCfg.fail_if,
          severity: 'error',
          haltExecution: false,
        });
      }

      return failures;
    } catch {
      return [];
    }
  }

  // Debounce helpers
  private scheduleUpdate(ctx: FrontendContext, comments: any, group: string, id?: string) {
    if (id) this._pendingIds.add(id);
    const now = Date.now();
    const since = now - this._lastFlush;
    const remaining = this.maxWaitMs - since;
    if (this._timer) clearTimeout(this._timer);
    const wait = Math.max(0, Math.min(this.debounceMs, remaining));
    this._timer = setTimeout(async () => {
      const ids = Array.from(this._pendingIds);
      this._pendingIds.clear();
      this._timer = null;
      await this.updateGroupedComment(ctx, comments, group, ids.length > 0 ? ids : undefined);
      this._lastFlush = Date.now();
    }, wait);
  }

  private async flushNow(ctx: FrontendContext, comments: any, group: string) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const ids = Array.from(this._pendingIds);
    this._pendingIds.clear();
    await this.updateGroupedComment(ctx, comments, group, ids.length > 0 ? ids : undefined);
    this._lastFlush = Date.now();
  }

  /**
   * Sleep utility for enforcing delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
