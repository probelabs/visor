// WhatsApp webhook runner.
// Receives messages via Meta webhook, dispatches Visor engine runs.
// Mirrors the architecture of src/telegram/polling-runner.ts.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createHash } from 'crypto';
import { logger } from '../logger';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { WhatsAppClient } from './client';
import { WhatsAppAdapter, type WhatsAppMessageInfo } from './adapter';
import { WorkspaceManager } from '../utils/workspace-manager';

export type WhatsAppWebhookConfig = {
  accessToken?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
  apiVersion?: string;
  port?: number; // default: 8443
  host?: string; // default: '0.0.0.0'
  phoneAllowlist?: string[];
  workflow?: string;
};

export class WhatsAppWebhookRunner {
  private client: WhatsAppClient;
  private adapter: WhatsAppAdapter;
  private engine: StateMachineExecutionEngine;
  private cfg: VisorConfig;
  private phoneAllowlist: Set<string>;
  private processedMessages: Map<string, number> = new Map(); // messageId -> timestamp
  private server?: Server;
  private port: number;
  private host: string;
  private taskStore?: import('../agent-protocol/task-store').TaskStore;
  private configPath?: string;

  constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: WhatsAppWebhookConfig) {
    const token = opts.accessToken || process.env.WHATSAPP_ACCESS_TOKEN || '';
    const phoneId = opts.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN is required');
    if (!phoneId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is required');

    this.client = new WhatsAppClient({
      accessToken: token,
      phoneNumberId: phoneId,
      appSecret: opts.appSecret || process.env.WHATSAPP_APP_SECRET,
      verifyToken: opts.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN,
      apiVersion: opts.apiVersion || 'v21.0',
    });
    this.adapter = new WhatsAppAdapter(phoneId);
    this.engine = engine;
    this.cfg = cfg;
    this.phoneAllowlist = new Set((opts.phoneAllowlist || []).map(p => p.replace(/\D/g, '')));
    this.port = opts.port || parseInt(process.env.WHATSAPP_WEBHOOK_PORT || '8443');
    this.host = opts.host || '0.0.0.0';
  }

  /** Get the WhatsAppClient instance (for shared access) */
  getClient(): WhatsAppClient {
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
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Only handle /webhooks/whatsapp
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (!url.pathname.startsWith('/webhooks/whatsapp')) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      if (req.method === 'GET') {
        const params: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          params[k] = v;
        });
        const result = await this.handleWebhookGet(params);
        res.writeHead(result.status, { 'Content-Type': 'text/plain' });
        res.end(result.body);
        return;
      }

      if (req.method === 'POST') {
        // Read body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks).toString('utf-8');

        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }

        const result = await this.handleWebhookPost(rawBody, headers);
        res.writeHead(result.status, { 'Content-Type': 'text/plain' });
        res.end(result.body);
        return;
      }

      res.writeHead(405);
      res.end('Method Not Allowed');
    });

    return new Promise<void>(resolve => {
      this.server!.listen(this.port, this.host, () => {
        logger.info(`[WhatsAppWebhook] Server listening on ${this.host}:${this.port}`);
        // Clean up stale workspace directories
        WorkspaceManager.cleanupStale().catch(() => {});
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise<void>(resolve => {
        this.server!.close(() => {
          logger.info('[WhatsAppWebhook] Server stopped');
          resolve();
        });
      });
    }
  }

  /** Handle GET webhook verification */
  async handleWebhookGet(query: Record<string, string>): Promise<{ status: number; body: string }> {
    const result = this.client.verifyChallenge(query);
    if (result.ok && result.challenge) {
      logger.info('[WhatsAppWebhook] Challenge verified');
      return { status: 200, body: result.challenge };
    }
    logger.warn('[WhatsAppWebhook] Challenge verification failed');
    return { status: 403, body: 'Forbidden' };
  }

  /** Handle POST webhook messages */
  async handleWebhookPost(
    body: string,
    headers: Record<string, string>
  ): Promise<{ status: number; body: string }> {
    // Verify signature
    const signature = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'] || '';
    if (!this.client.verifyWebhookSignature(body, signature)) {
      logger.warn('[WhatsAppWebhook] Invalid webhook signature');
      return { status: 403, body: 'Forbidden' };
    }

    // Parse payload
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return { status: 400, body: 'Bad Request' };
    }

    // Respond 200 immediately (Meta requires fast acknowledgment)
    // Process messages asynchronously
    const messages = WhatsAppAdapter.parseWebhookPayload(payload);
    for (const msg of messages) {
      this.handleMessage(msg).catch(err => {
        logger.error(
          `[WhatsAppWebhook] handleMessage error: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }

    return { status: 200, body: 'OK' };
  }

  private async handleMessage(msg: WhatsAppMessageInfo): Promise<void> {
    // 1. Skip messages without text content
    if (!msg.text && !msg.caption) return;

    // 2. Skip bot's own messages (shouldn't happen with webhooks, but safety check)
    if (this.adapter.isFromBot(msg)) return;

    // 3. Deduplication
    if (this.isDuplicate(msg.messageId)) return;

    // 4. Phone allowlist check
    const normalizedFrom = msg.from.replace(/\D/g, '');
    if (this.phoneAllowlist.size > 0 && !this.phoneAllowlist.has(normalizedFrom)) {
      return;
    }

    // 5. Mark message as read
    this.client.markAsRead(msg.messageId).catch(() => {});

    // 6. Build conversation context
    const conversation = this.adapter.buildConversationContext(msg);

    // 7. Build webhook data map
    const webhookData = new Map<string, unknown>();
    const endpoint = '/bots/whatsapp/message';
    const payload = {
      event: {
        type: 'whatsapp_message',
        from: msg.from,
        message_id: msg.messageId,
        text: msg.text || msg.caption || '',
        display_name: msg.displayName,
        context: msg.context,
        phone_number_id: msg.phoneNumberId,
      },
      whatsapp_conversation: conversation,
    };
    webhookData.set(endpoint, payload);

    // 8. Prepare config for run (ensure whatsapp frontend is enabled)
    const cfgForRun = this.prepareConfigForRun();

    // 9. Derive stable workspace name from phone number
    const hash = createHash('sha256').update(msg.from).digest('hex').slice(0, 8);
    if (!(cfgForRun as any).workspace) (cfgForRun as any).workspace = {};
    (cfgForRun as any).workspace.name = `whatsapp-${hash}`;
    (cfgForRun as any).workspace.cleanup_on_exit = false;

    // 10. Determine checks to run
    const allChecks = Object.keys(this.cfg.checks || {});
    if (allChecks.length === 0) return;

    try {
      const runEngine = new StateMachineExecutionEngine();

      // Inject WhatsApp client into execution context
      try {
        const parentCtx: any = (this.engine as any).getExecutionContext?.() || {};
        const prevCtx: any = (runEngine as any).getExecutionContext?.() || {};
        (runEngine as any).setExecutionContext?.({
          ...parentCtx,
          ...prevCtx,
          whatsapp: this.client,
          whatsappClient: this.client,
        });
      } catch {}

      logger.info(
        `[WhatsAppWebhook] Dispatching engine run for ${msg.from} (${msg.displayName || 'unknown'})`
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
            source: 'whatsapp',
            workflowId: allChecks.join(','),
            configPath: this.configPath,
            messageText: String(msg.text || msg.caption || 'WhatsApp message'),
            metadata: {
              whatsapp_from: msg.from,
              whatsapp_display_name: msg.displayName || 'unknown',
            },
          },
          execFn
        );
      } else {
        await execFn();
      }
    } catch (e) {
      logger.error(
        `[WhatsAppWebhook] Engine execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Ensure whatsapp frontend is in the config for this run */
  private prepareConfigForRun(): VisorConfig {
    try {
      const cfg = JSON.parse(JSON.stringify(this.cfg));
      const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];
      if (!fronts.some((f: any) => f && f.name === 'whatsapp')) {
        fronts.push({ name: 'whatsapp' });
      }
      cfg.frontends = fronts;
      return cfg;
    } catch {
      return this.cfg;
    }
  }

  /** Deduplication: track processed messages by message ID */
  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    // Cleanup old entries
    for (const [k, t] of this.processedMessages.entries()) {
      if (now - t > 10000) this.processedMessages.delete(k);
    }
    if (this.processedMessages.has(messageId)) return true;
    this.processedMessages.set(messageId, now);
    return false;
  }
}
