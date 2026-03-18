// Microsoft Teams webhook runner.
// Receives messages via Azure Bot Framework webhook, dispatches Visor engine runs.
// Mirrors the architecture of src/whatsapp/webhook-runner.ts.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createHash } from 'crypto';
import { ActivityTypes, TurnContext } from 'botbuilder';
import { logger } from '../logger';
import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { TeamsClient } from './client';
import { TeamsAdapter, type TeamsMessageInfo } from './adapter';
import { WorkspaceManager } from '../utils/workspace-manager';

export type TeamsWebhookConfig = {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  port?: number; // default: 3978
  host?: string; // default: '0.0.0.0'
  userAllowlist?: string[];
  workflow?: string;
};

export class TeamsWebhookRunner implements Runner {
  readonly name = 'teams';
  private client: TeamsClient;
  private adapter: TeamsAdapter;
  private engine: StateMachineExecutionEngine;
  private cfg: VisorConfig;
  private userAllowlist: Set<string>;
  private processedActivities: Map<string, number> = new Map(); // activityId -> timestamp
  private server?: Server;
  private port: number;
  private host: string;
  private taskStore?: import('../agent-protocol/task-store').TaskStore;
  private configPath?: string;
  private activeRequests = 0;

  constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: TeamsWebhookConfig) {
    const appId = opts.appId || process.env.TEAMS_APP_ID || '';
    const appPassword = opts.appPassword || process.env.TEAMS_APP_PASSWORD || '';
    if (!appId) throw new Error('TEAMS_APP_ID is required');
    if (!appPassword) throw new Error('TEAMS_APP_PASSWORD is required');

    this.client = new TeamsClient({
      appId,
      appPassword,
      tenantId: opts.tenantId || process.env.TEAMS_TENANT_ID,
    });
    this.adapter = new TeamsAdapter(appId);
    this.engine = engine;
    this.cfg = cfg;
    this.userAllowlist = new Set(opts.userAllowlist || []);
    this.port = opts.port || parseInt(process.env.TEAMS_WEBHOOK_PORT || '3978');
    this.host = opts.host || '0.0.0.0';
  }

  /** Get the TeamsClient instance (for shared access) */
  getClient(): TeamsClient {
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
    const botAdapter = this.client.getAdapter();

    // Error handler for the adapter
    botAdapter.onTurnError = async (_context, error) => {
      logger.error(
        `[TeamsWebhook] Turn error: ${error instanceof Error ? error.message : String(error)}`
      );
    };

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Only handle /api/messages (standard Bot Framework endpoint)
      if (url.pathname !== '/api/messages') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }

      // Let the CloudAdapter handle the request.
      // It validates the JWT bearer token and parses the Activity.
      try {
        await botAdapter.process(req as any, res as any, async (turnContext: TurnContext) => {
          const activity = turnContext.activity;

          // Only process message activities
          if (activity.type !== ActivityTypes.Message) return;

          const msgInfo = TeamsAdapter.parseActivity(activity);
          if (!msgInfo) return;

          // Process async (don't block the 200 response)
          this.handleMessage(msgInfo).catch(err => {
            logger.error(
              `[TeamsWebhook] handleMessage error: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        });
      } catch (err) {
        logger.error(
          `[TeamsWebhook] Adapter process error: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!res.headersSent) {
          res.writeHead(401);
          res.end('Unauthorized');
        }
      }
    });

    return new Promise<void>(resolve => {
      this.server!.listen(this.port, this.host, () => {
        logger.info(`[TeamsWebhook] Server listening on ${this.host}:${this.port}`);
        // Clean up stale workspace directories
        WorkspaceManager.cleanupStale().catch(() => {});
        resolve();
      });
    });
  }

  async stopListening(): Promise<void> {
    if (this.server) {
      const srv = this.server;
      if (typeof (srv as any).closeAllConnections === 'function') {
        (srv as any).closeAllConnections();
      }
      await new Promise<void>(resolve => srv.close(() => resolve()));
      this.server = undefined;
    }
    logger.info('[TeamsWebhook] Server closed');
  }

  async drain(timeoutMs = 0): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    logger.info(`[TeamsWebhook] Draining (${this.activeRequests} active)`);
    const startedAt = Date.now();
    while (this.activeRequests > 0) {
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        logger.warn(`[TeamsWebhook] Drain timeout with ${this.activeRequests} active request(s)`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    logger.info('[TeamsWebhook] Drain complete');
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise<void>(resolve => {
        this.server!.close(() => {
          logger.info('[TeamsWebhook] Server stopped');
          resolve();
        });
      });
    }
  }

  private async handleMessage(msg: TeamsMessageInfo): Promise<void> {
    this.activeRequests++;
    try {
      await this.handleMessageInner(msg);
    } finally {
      this.activeRequests--;
    }
  }

  private async handleMessageInner(msg: TeamsMessageInfo): Promise<void> {
    // 1. Skip empty text
    if (!msg.text) return;

    // 2. Skip bot's own messages
    if (this.adapter.isFromBot(msg)) return;

    // 3. Deduplication
    if (this.isDuplicate(msg.activityId)) return;

    // 4. User allowlist check
    if (this.userAllowlist.size > 0 && !this.userAllowlist.has(msg.from.id)) {
      return;
    }

    // 5. Build conversation context
    const conversation = this.adapter.buildConversationContext(msg);

    // 6. Build webhook data map
    const webhookData = new Map<string, unknown>();
    const endpoint = '/bots/teams/message';
    const payload = {
      event: {
        type: 'teams_message',
        conversation_id: msg.conversationId,
        conversation_type: msg.conversationType,
        activity_id: msg.activityId,
        text: msg.text,
        from_id: msg.from.id,
        from_name: msg.from.name,
        team_id: msg.teamId,
        channel_id: msg.channelId,
        tenant_id: msg.tenantId,
      },
      teams_conversation: conversation,
      teams_conversation_reference: msg.conversationReference,
    };
    webhookData.set(endpoint, payload);

    // 7. Prepare config for run (ensure teams frontend is enabled)
    const cfgForRun = this.prepareConfigForRun();

    // 8. Derive stable workspace name from conversation ID
    const hash = createHash('sha256').update(msg.conversationId).digest('hex').slice(0, 8);
    if (!(cfgForRun as any).workspace) (cfgForRun as any).workspace = {};
    (cfgForRun as any).workspace.name = `teams-${hash}`;
    (cfgForRun as any).workspace.cleanup_on_exit = false;

    // 9. Determine checks to run
    const allChecks = Object.keys(this.cfg.checks || {});
    if (allChecks.length === 0) return;

    try {
      const runEngine = new StateMachineExecutionEngine();

      // Inject Teams client into execution context
      try {
        const parentCtx: any = (this.engine as any).getExecutionContext?.() || {};
        const prevCtx: any = (runEngine as any).getExecutionContext?.() || {};
        (runEngine as any).setExecutionContext?.({
          ...parentCtx,
          ...prevCtx,
          teams: this.client,
          teamsClient: this.client,
        });
      } catch {}

      logger.info(
        `[TeamsWebhook] Dispatching engine run for ${msg.conversationType} conversation (${msg.from.name || msg.from.id})`
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
            source: 'teams',
            workflowId: allChecks.join(','),
            configPath: this.configPath,
            messageText: String(msg.text || 'Teams message'),
            metadata: {
              teams_conversation_id: msg.conversationId,
              teams_conversation_type: msg.conversationType,
              teams_from: msg.from.id,
            },
          },
          execFn
        );
      } else {
        await execFn();
      }
    } catch (e) {
      logger.error(
        `[TeamsWebhook] Engine execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Ensure teams frontend is in the config for this run */
  private prepareConfigForRun(): VisorConfig {
    try {
      const cfg = JSON.parse(JSON.stringify(this.cfg));
      const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];
      if (!fronts.some((f: any) => f && f.name === 'teams')) {
        fronts.push({ name: 'teams' });
      }
      cfg.frontends = fronts;
      return cfg;
    } catch {
      return this.cfg;
    }
  }

  /** Deduplication: track processed activities by ID */
  private isDuplicate(activityId: string): boolean {
    if (!activityId) return false;
    const now = Date.now();
    // Cleanup old entries
    for (const [k, t] of this.processedActivities.entries()) {
      if (now - t > 10000) this.processedActivities.delete(k);
    }
    if (this.processedActivities.has(activityId)) return true;
    this.processedActivities.set(activityId, now);
    return false;
  }
}
