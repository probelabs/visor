import type { Frontend, FrontendContext } from './host';
import { SlackClient } from '../slack/client';

type SectionState = {
  status: 'queued' | 'in_progress' | 'completed' | 'errored';
  conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
  issues?: number;
  lastUpdated: string;
  content?: string;
  error?: string;
};

type SlackFrontendConfig = {
  defaultChannel?: string;
  groupChannels?: Record<string, string>;
  debounceMs?: number;
  maxWaitMs?: number;
};

export class SlackFrontend implements Frontend {
  public readonly name = 'slack';
  private subs: Array<{ unsubscribe(): void }> = [];
  private stepStatusByGroup: Map<string, Map<string, SectionState>> = new Map();
  private messageTsByGroup: Map<string, string> = new Map();
  private cfg: SlackFrontendConfig;

  // Debounce state (per frontend)
  private debounceMs = 300;
  private maxWaitMs = 1500;
  private _timer: NodeJS.Timeout | null = null;
  private _lastFlush = 0;
  private _pendingGroups: Set<string> = new Set();

  constructor(config?: SlackFrontendConfig) {
    this.cfg = config || {};
    if (typeof this.cfg.debounceMs === 'number') this.debounceMs = this.cfg.debounceMs!;
    if (typeof this.cfg.maxWaitMs === 'number') this.maxWaitMs = this.cfg.maxWaitMs!;
  }

  start(ctx: FrontendContext): void {
    const bus = ctx.eventBus;

    if (process.env.VISOR_DEBUG === 'true') {
      try {
        const ch =
          this.getChannelForGroup('overview') || this.getChannelForGroup('review') || '(none)';
        const hasSlack = !!(
          (ctx as any).slack ||
          (ctx as any).slackClient ||
          (this.cfg as any)?.botToken ||
          process.env.SLACK_BOT_TOKEN
        );
        // eslint-disable-next-line no-console
        console.log(`[slack-frontend] start; hasClientHint=${hasSlack} anyChannel=${ch}`);
      } catch {}
    }

    // Listen to check lifecycle; we only post on completion/error (no queued placeholders)
    this.subs.push(
      bus.on('CheckCompleted', async (env: any) => {
        const ev = (env && env.payload) || env;
        const group = this.getGroupForCheck(ctx, ev.checkId);
        const issues = Array.isArray(ev.result?.issues) ? ev.result.issues.length : 0;
        const content = typeof ev.result?.content === 'string' ? ev.result.content : undefined;
        this.upsertSectionState(group, ev.checkId, {
          status: 'completed',
          conclusion: await this.mapConclusionFromFailIf(ctx, ev.checkId, ev.result),
          issues,
          lastUpdated: new Date().toISOString(),
          content,
        });
        this.scheduleUpdate(ctx, group);
      })
    );

    this.subs.push(
      bus.on('CheckErrored', async (env: any) => {
        const ev = (env && env.payload) || env;
        const group = this.getGroupForCheck(ctx, ev.checkId);
        this.upsertSectionState(group, ev.checkId, {
          status: 'errored',
          conclusion: 'failure',
          issues: 0,
          lastUpdated: new Date().toISOString(),
          error: ev.error?.message || 'Execution error',
        });
        this.scheduleUpdate(ctx, group);
      })
    );

    // Flush on terminal state to avoid leaving pending updates
    this.subs.push(
      bus.on('StateTransition', async (env: any) => {
        const ev = (env && env.payload) || env;
        if (ev && (ev.to === 'Completed' || ev.to === 'Error')) {
          for (const g of this.stepStatusByGroup.keys()) await this.flushNow(ctx, g);
        }
      })
    );
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._pendingGroups.clear();
  }

  private getSlack(ctx: FrontendContext): any | undefined {
    // Prefer injected fake client in tests: ctx.slack or ctx.slackClient
    const injected = (ctx as any).slack || (ctx as any).slackClient;
    if (injected) return injected;
    // Else try to lazy-create from env or frontend config
    try {
      const token = (this.cfg as any)?.botToken || process.env.SLACK_BOT_TOKEN;
      if (typeof token === 'string' && token.trim()) {
        return new SlackClient(token.trim());
      }
    } catch {}
    return undefined;
  }

  private getChannelForGroup(group: string): string | undefined {
    return (this.cfg.groupChannels && this.cfg.groupChannels[group]) || this.cfg.defaultChannel;
  }

  private async updateGroupMessage(ctx: FrontendContext, group: string): Promise<void> {
    const slack = this.getSlack(ctx);
    const channel = this.getChannelForGroup(group);
    if (!slack || !channel) {
      try {
        if (process.env.VISOR_DEBUG === 'true') {
          // eslint-disable-next-line no-console
          console.log(`[slack-frontend] skip update: slack=${!!slack} channel=${channel || ''}`);
        }
      } catch {}
      return;
    }

    const text = this.renderGroupText(group);
    const existingTs = this.messageTsByGroup.get(group);
    if (!existingTs) {
      if (process.env.VISOR_DEBUG === 'true') {
        try {
          console.log(`[slack-frontend] postMessage channel=${channel} len=${text.length}`);
        } catch {}
      }
      const res = await slack.chat.postMessage({ channel, text });
      const ts = res?.ts || res?.message?.ts || res?.data?.ts;
      if (typeof ts === 'string') this.messageTsByGroup.set(group, ts);
    } else {
      if (process.env.VISOR_DEBUG === 'true') {
        try {
          console.log(
            `[slack-frontend] update channel=${channel} ts=${existingTs} len=${text.length}`
          );
        } catch {}
      }
      await slack.chat.update({ channel, ts: existingTs, text });
    }
  }

  private renderGroupText(group: string): string {
    const sections = this.stepStatusByGroup.get(group) || new Map<string, SectionState>();
    const lines: string[] = [];
    lines.push(`Visor ${group} summary`);
    for (const [checkId, st] of sections.entries()) {
      const statusEmoji =
        st.status === 'errored' ? '❌' : st.conclusion === 'failure' ? '❌' : '✅';
      const title = `${statusEmoji} ${checkId}`;
      const details = st.content && st.content.trim().length > 0 ? `\n${st.content.trim()}` : '';
      lines.push(`${title}${details}`);
    }
    return lines.join('\n\n');
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

  private async mapConclusionFromFailIf(
    ctx: FrontendContext,
    checkId: string,
    result: { issues?: any[]; output?: unknown }
  ): Promise<'success' | 'failure' | 'neutral' | 'skipped'> {
    try {
      const { FailureConditionEvaluator } = await import('../failure-condition-evaluator');
      const evaluator = new FailureConditionEvaluator();
      const config: any = ctx.config || {};
      const checks = (config && config.checks) || {};
      const checkCfg = checks[checkId] || {};
      const checkSchema = typeof checkCfg.schema === 'string' ? checkCfg.schema : 'code-review';
      const checkGroup = checkCfg.group || 'default';
      const reviewSummary = { issues: Array.isArray(result?.issues) ? result.issues : [] };

      const failures: any[] = [];
      if (config.fail_if) {
        const failed = await evaluator.evaluateSimpleCondition(
          checkId,
          checkSchema,
          checkGroup,
          reviewSummary,
          config.fail_if
        );
        failures.push({ failed });
      }
      if (checkCfg.fail_if) {
        const failed = await evaluator.evaluateSimpleCondition(
          checkId,
          checkSchema,
          checkGroup,
          reviewSummary,
          checkCfg.fail_if
        );
        failures.push({ failed });
      }
      const anyFailed = failures.some(f => f && f.failed);
      return anyFailed ? 'failure' : 'success';
    } catch {
      return 'neutral';
    }
  }

  // Debounce helpers (group-level)
  private scheduleUpdate(ctx: FrontendContext, group: string) {
    this._pendingGroups.add(group);
    if (this.debounceMs === 0) return void this.flushNow(ctx, group);
    const now = Date.now();
    const since = now - this._lastFlush;
    const remaining = this.maxWaitMs - since;
    if (this._timer) clearTimeout(this._timer);
    const wait = Math.max(0, Math.min(this.debounceMs, remaining));
    this._timer = setTimeout(async () => {
      const groups = Array.from(this._pendingGroups);
      this._pendingGroups.clear();
      this._timer = null;
      for (const g of groups) await this.updateGroupMessage(ctx, g);
      this._lastFlush = Date.now();
    }, wait);
  }

  private async flushNow(ctx: FrontendContext, group: string) {
    await this.updateGroupMessage(ctx, group);
    this._lastFlush = Date.now();
  }
}
