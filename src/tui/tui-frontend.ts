/**
 * TUI Frontend for Visor workflows.
 *
 * Subscribes to EventBus events and updates the ChatTUI accordingly:
 * - CheckCompleted → Display AI response in chat
 * - HumanInputRequested → Set waiting state, update placeholder
 * - StateTransition → Update status bar
 * - CheckErrored → Display error message
 */
import type { Frontend, FrontendContext } from '../frontends/host';
import { ChatTUI } from './chat-tui';
import { getChatStateManager } from './chat-state';
import { extractTextFromJson } from '../utils/json-text-extractor';

export interface TuiFrontendConfig {
  chatTui?: ChatTUI;
}

export class TuiFrontend implements Frontend {
  public readonly name = 'tui';
  private subs: Array<{ unsubscribe(): void }> = [];
  private chatTui?: ChatTUI;

  constructor(config?: TuiFrontendConfig) {
    this.chatTui = config?.chatTui;
  }

  setChatTUI(tui: ChatTUI): void {
    this.chatTui = tui;
  }

  start(ctx: FrontendContext): void {
    const bus = ctx.eventBus;

    // Info-level boot log
    try {
      ctx.logger.info(`[tui-frontend] started; hasChatTui=${!!this.chatTui}`);
    } catch {}

    // Listen to check lifecycle
    this.subs.push(
      bus.on('CheckCompleted', async (env: any) => {
        try {
          const ev = (env && env.payload) || env;
          this.handleCheckCompleted(ctx, ev.checkId, ev.result);
        } catch {}
      })
    );

    this.subs.push(
      bus.on('CheckErrored', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Execution error';
        this.handleError(ctx, ev?.checkId, message);
      })
    );

    // Human input requests
    this.subs.push(
      bus.on('HumanInputRequested', async (env: any) => {
        const ev = (env && env.payload) || env;
        if (!ev || typeof ev.prompt !== 'string' || !ev.checkId) return;
        this.handleHumanInputRequested(ctx, ev);
      })
    );

    // State transitions
    this.subs.push(
      bus.on('StateTransition', async (env: any) => {
        const ev = (env && env.payload) || env;
        this.handleStateTransition(ctx, ev);
      })
    );

    // Shutdown events
    this.subs.push(
      bus.on('Shutdown', async (env: any) => {
        const ev = (env && env.payload) || env;
        const message = ev?.error?.message || 'Workflow completed';
        this.handleShutdown(ctx, message);
      })
    );
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  private handleCheckCompleted(
    ctx: FrontendContext,
    checkId: string,
    result: { output?: unknown; content?: string }
  ): void {
    try {
      if (!this.chatTui) return;

      const cfg: any = ctx.config || {};
      const checkCfg: any = cfg.checks?.[checkId];
      if (!checkCfg) return;

      // Skip internal steps
      if (checkCfg.criticality === 'internal') return;

      // Extract text from result
      let text: string | undefined;

      // Try extracting from output
      const out: any = result?.output;
      if (out) {
        // First try extractTextFromJson for structured outputs
        const extracted = extractTextFromJson(out);
        if (extracted) {
          text = extracted.trim();
        } else if (typeof out.text === 'string' && out.text.trim()) {
          text = out.text.trim();
        } else if (typeof out === 'string' && out.trim()) {
          text = out.trim();
        }
      }

      // Fall back to content
      if (!text && typeof result?.content === 'string' && result.content.trim()) {
        text = result.content.trim();
      }

      // Fall back to logOutput for log checks
      if (!text) {
        const logResult = result as any;
        if (typeof logResult?.logOutput === 'string' && logResult.logOutput.trim()) {
          text = logResult.logOutput.trim();
        }
      }

      if (!text) return;

      // Add message to chat
      this.chatTui.addAssistantMessage(text, checkId);

      try {
        ctx.logger.info(`[tui-frontend] displayed AI response for ${checkId}`);
      } catch {}
    } catch (err) {
      try {
        ctx.logger.warn(
          `[tui-frontend] handleCheckCompleted failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } catch {}
    }
  }

  private handleError(_ctx: FrontendContext, checkId: string | undefined, message: string): void {
    if (!this.chatTui) return;

    const errorText = checkId ? `[Error in ${checkId}] ${message}` : `[Error] ${message}`;

    this.chatTui.addSystemMessage(errorText);
    this.chatTui.setStatus('Error occurred');
  }

  private handleHumanInputRequested(_ctx: FrontendContext, ev: any): void {
    if (!this.chatTui) return;

    const stateManager = getChatStateManager();
    stateManager.setWaiting({
      checkId: String(ev.checkId),
      prompt: String(ev.prompt),
      placeholder: ev.placeholder,
      multiline: ev.multiline,
      timeout: ev.timeout,
      defaultValue: ev.default,
      allowEmpty: ev.allowEmpty,
    });

    this.chatTui.setWaiting(true, ev.prompt);
  }

  private handleStateTransition(_ctx: FrontendContext, ev: any): void {
    if (!this.chatTui) return;

    const to = ev?.to as string;

    if (to === 'Completed' || to === 'Error') {
      this.chatTui.setProcessing(false);
      this.chatTui.setStatus(to === 'Completed' ? 'Workflow completed' : 'Workflow failed');
    } else if (to === 'Running' || to === 'Executing') {
      this.chatTui.setProcessing(true);
      this.chatTui.setStatus('Processing...');
    } else if (to === 'Waiting') {
      // Handled by HumanInputRequested
    }
  }

  private handleShutdown(_ctx: FrontendContext, message: string): void {
    if (!this.chatTui) return;
    this.chatTui.setProcessing(false);
    this.chatTui.setStatus(message);
  }
}
