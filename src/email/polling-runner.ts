// Email polling runner.
// Mirrors the architecture of src/telegram/polling-runner.ts:
// - IMAP mode: connect, poll/IDLE for new messages
// - Resend polling mode: poll GET /emails/receiving for new inbound emails
// - Resend webhook mode: webhook handler for inbound emails (legacy)
// - Filters by sender allowlist, dedup by Message-ID
// - Dispatches engine runs with injected webhook context

import { logger } from '../logger';
import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { EmailClient, type EmailMessage } from './client';
import { EmailAdapter } from './adapter';
import { createHash } from 'crypto';
import { WorkspaceManager } from '../utils/workspace-manager';

export type EmailPollingConfig = {
  receive?: {
    type?: 'imap' | 'resend';
    host?: string;
    port?: number;
    auth?: { user?: string; pass?: string };
    secure?: boolean;
    poll_interval?: number;
    folder?: string;
    mark_read?: boolean;
    api_key?: string;
    webhook_secret?: string;
  };
  send?: {
    type?: 'smtp' | 'resend';
    host?: string;
    port?: number;
    auth?: { user?: string; pass?: string };
    secure?: boolean;
    from?: string;
    api_key?: string;
  };
  allowlist?: string[];
  workflow?: string;
};

export class EmailPollingRunner implements Runner {
  readonly name = 'email';
  private client: EmailClient;
  private adapter: EmailAdapter;
  private engine: StateMachineExecutionEngine;
  private cfg: VisorConfig;
  private senderAllowlist: Set<string>;
  private pollInterval: number; // ms
  private pollTimer?: ReturnType<typeof setInterval>;
  private processedMessageIds: Map<string, number> = new Map(); // Message-ID -> timestamp
  private stopped = false;
  private taskStore?: import('../agent-protocol/task-store').TaskStore;
  private configPath?: string;
  private receiveType: 'imap' | 'resend';
  private sendConfig?: EmailPollingConfig['send'];
  private resendLastSeenId?: string; // cursor for Resend polling
  private hasWebhookSecret: boolean;
  private activeProcessing = 0;

  constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: EmailPollingConfig) {
    this.receiveType = (opts.receive?.type as 'imap' | 'resend') || 'imap';

    this.client = new EmailClient({
      receive: opts.receive as any,
      send: opts.send as any,
    });
    this.adapter = new EmailAdapter(this.client.getFromAddress());
    this.engine = engine;
    this.cfg = cfg;
    this.senderAllowlist = new Set((opts.allowlist || []).map(a => a.toLowerCase().trim()));
    this.pollInterval = (opts.receive?.poll_interval || 30) * 1000;
    this.sendConfig = opts.send;
    this.hasWebhookSecret = !!(opts.receive?.webhook_secret || process.env.RESEND_WEBHOOK_SECRET);
  }

  /** Get the EmailClient instance (for shared access) */
  getClient(): EmailClient {
    return this.client;
  }

  /** Set shared task store for execution tracking */
  setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void {
    this.taskStore = store;
    this.configPath = configPath;
  }

  /** Hot-swap config for future requests */
  updateConfig(cfg: VisorConfig): void {
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    if (this.receiveType === 'imap') {
      await this.startImapPolling();
    } else if (this.hasWebhookSecret) {
      logger.info(
        '[EmailPolling] Resend webhook mode — register POST /webhooks/email/resend on your HTTP server'
      );
      logger.info('[EmailPolling] Call handleResendWebhook() when webhook events arrive');
    } else {
      await this.startResendPolling();
    }

    // Clean up stale workspace directories
    WorkspaceManager.cleanupStale().catch(() => {});
  }

  async stopListening(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    logger.info('[EmailPolling] Polling stopped');
  }

  async drain(timeoutMs = 0): Promise<void> {
    if (!this.stopped) {
      await this.stopListening();
    }
    logger.info(`[EmailPolling] Draining (${this.activeProcessing} active)`);

    const startedAt = Date.now();
    while (this.activeProcessing > 0) {
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        logger.warn(`[EmailPolling] Drain timeout with ${this.activeProcessing} active processing`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await this.client.disconnectImap();
    logger.info('[EmailPolling] Drain complete');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.client.disconnectImap();
    logger.info('[EmailPolling] Stopped');
  }

  // ─── IMAP Polling ───

  private async startImapPolling(): Promise<void> {
    try {
      await this.client.connectImap();
      logger.info('[EmailPolling] IMAP connected');
    } catch (err) {
      logger.error(
        `[EmailPolling] IMAP connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }

    // Initial fetch
    await this.pollOnce();

    // Set up interval polling
    this.pollTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error(
          `[EmailPolling] Poll error: ${err instanceof Error ? err.message : String(err)}`
        );
        // Try to reconnect
        try {
          await this.client.disconnectImap();
          await this.client.connectImap();
          logger.info('[EmailPolling] IMAP reconnected');
        } catch (reconnectErr) {
          logger.error(
            `[EmailPolling] IMAP reconnect failed: ${reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)}`
          );
        }
      }
    }, this.pollInterval);

    logger.info(`[EmailPolling] IMAP polling every ${this.pollInterval / 1000}s`);
  }

  private async pollOnce(): Promise<void> {
    const messages = await this.client.fetchNewMessages();
    for (const msg of messages) {
      if (this.stopped) break;
      await this.handleMessage(msg);
    }
    // Periodic cleanup
    this.cleanupDedup();
    this.adapter.cleanupOldThreads();
  }

  // ─── Resend Polling ───

  private async startResendPolling(): Promise<void> {
    logger.info('[EmailPolling] Resend polling mode — checking for new inbound emails');

    // Initial fetch — get current state and set cursor
    await this.pollResendOnce();

    // Set up interval polling
    this.pollTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        await this.pollResendOnce();
      } catch (err) {
        logger.error(
          `[EmailPolling] Resend poll error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, this.pollInterval);

    logger.info(`[EmailPolling] Resend polling every ${this.pollInterval / 1000}s`);
  }

  private async pollResendOnce(): Promise<void> {
    const result = await this.client.listReceivedEmails({
      limit: 20,
      after: this.resendLastSeenId,
    });

    for (const summary of result.emails) {
      if (this.stopped) break;
      // Skip already processed (check only, don't mark — handleMessage does authoritative dedup)
      if (this.processedMessageIds.has(summary.message_id || summary.id)) continue;

      // Fetch full email content
      const msg = await this.client.fetchResendEmail(summary.id);
      if (!msg) continue;

      await this.handleMessage(msg);
    }

    // Advance cursor
    if (result.lastId) {
      this.resendLastSeenId = result.lastId;
    }

    // Periodic cleanup
    this.cleanupDedup();
    this.adapter.cleanupOldThreads();
  }

  // ─── Resend Webhook Handler ───

  /**
   * Handle inbound Resend webhook event.
   * Call this from your HTTP server when POST /webhooks/email/resend arrives.
   */
  async handleResendWebhook(
    body: string,
    headers: Record<string, string>
  ): Promise<{ ok: boolean; error?: string }> {
    // Verify signature
    const verified = await this.client.verifyResendWebhook(body, headers);
    if (!verified) {
      return { ok: false, error: 'Invalid webhook signature' };
    }

    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      return { ok: false, error: 'Invalid JSON' };
    }

    // Only handle email.received events
    if (event.type !== 'email.received') {
      return { ok: true }; // Acknowledge but ignore
    }

    const emailId = event.data?.email_id;
    if (!emailId) {
      return { ok: false, error: 'Missing email_id in webhook' };
    }

    // Fetch full email content from Resend API
    const msg = await this.client.fetchResendEmail(emailId);
    if (!msg) {
      return { ok: false, error: `Failed to fetch email ${emailId}` };
    }

    await this.handleMessage(msg);
    return { ok: true };
  }

  // ─── Shared Message Processing ───

  private async handleMessage(msg: EmailMessage): Promise<void> {
    this.activeProcessing++;
    try {
      await this.handleMessageInner(msg);
    } finally {
      this.activeProcessing--;
    }
  }

  private async handleMessageInner(msg: EmailMessage): Promise<void> {
    // 1. Skip empty messages
    if (!msg.text && !msg.html) return;

    // 2. Skip own bot messages
    if (this.adapter.isFromBot(msg)) return;

    // 3. Deduplication by Message-ID
    if (this.isDuplicate(msg.messageId)) return;

    // 4. Sender allowlist check
    if (this.senderAllowlist.size > 0) {
      const from = EmailAdapter.extractEmail(msg.from);
      if (!this.senderAllowlist.has(from)) return;
    }

    // 5. Build conversation context
    const conversation = this.adapter.buildConversationContext(msg);

    // 6. Build webhook data map
    const webhookData = new Map<string, unknown>();
    const endpoint = '/bots/email/message';
    const payload = {
      event: {
        type: 'email_message',
        from: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        messageId: msg.messageId,
        inReplyTo: msg.inReplyTo,
        references: msg.references,
        date: msg.date.toISOString(),
        chat_id: conversation.thread.id, // thread ID for workspace naming
      },
      email_conversation: conversation,
      sendConfig: this.sendConfig,
    };
    webhookData.set(endpoint, payload);

    // 7. Prepare config for run
    const cfgForRun = this.prepareConfigForRun();

    // 8. Derive stable workspace name from thread identity
    const thread = this.adapter.getThreadByMessageId(msg.messageId);
    const threadKey = thread?.threadId || conversation.thread.id;
    const hash = createHash('sha256').update(threadKey).digest('hex').slice(0, 8);
    if (!(cfgForRun as any).workspace) (cfgForRun as any).workspace = {};
    (cfgForRun as any).workspace.name = `email-${hash}`;
    (cfgForRun as any).workspace.cleanup_on_exit = false;

    // 9. Determine checks to run
    const allChecks = Object.keys(this.cfg.checks || {});
    if (allChecks.length === 0) return;

    try {
      const runEngine = new StateMachineExecutionEngine();

      // Inject email client into execution context
      try {
        const parentCtx: any = (this.engine as any).getExecutionContext?.() || {};
        const prevCtx: any = (runEngine as any).getExecutionContext?.() || {};
        (runEngine as any).setExecutionContext?.({
          ...parentCtx,
          ...prevCtx,
          emailClient: this.client,
        });
      } catch {}

      logger.info(
        `[EmailPolling] Dispatching engine run for thread ${threadKey} from ${EmailAdapter.extractEmail(msg.from)}`
      );

      const execFn = () =>
        runEngine.executeChecks({
          checks: allChecks,
          showDetails: true,
          outputFormat: 'json',
          config: cfgForRun,
          webhookContext: { webhookData, eventType: 'manual' },
          debug: process.env.VISOR_DEBUG === 'true',
        } as any);

      if (this.taskStore) {
        const { trackExecution } = await import('../agent-protocol/track-execution');
        await trackExecution(
          {
            taskStore: this.taskStore,
            source: 'email',
            workflowId: allChecks.join(','),
            configPath: this.configPath,
            messageText: `Email from ${msg.from}: ${msg.subject}`,
            metadata: {
              email_from: msg.from,
              email_subject: msg.subject,
              email_thread_id: threadKey,
            },
          },
          execFn
        );
      } else {
        await execFn();
      }
    } catch (e) {
      logger.error(
        `[EmailPolling] Engine execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Ensure email frontend is in the config for this run */
  private prepareConfigForRun(): VisorConfig {
    try {
      const cfg = JSON.parse(JSON.stringify(this.cfg));
      const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];
      if (!fronts.some((f: any) => f && f.name === 'email')) {
        fronts.push({ name: 'email' });
      }
      cfg.frontends = fronts;
      return cfg;
    } catch {
      return this.cfg;
    }
  }

  /** Deduplication: track processed messages by Message-ID */
  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    if (this.processedMessageIds.has(messageId)) return true;
    this.processedMessageIds.set(messageId, now);
    return false;
  }

  /** Clean up old dedup entries */
  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, ts] of this.processedMessageIds.entries()) {
      if (now - ts > 3600000) this.processedMessageIds.delete(key); // 1 hour TTL
    }
  }
}
