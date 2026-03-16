// Telegram long-polling runner using grammy's @grammyjs/runner.
// Mirrors the architecture of src/slack/socket-runner.ts:
// - Receives Telegram updates via long polling
// - Filters by chat allowlist, mention requirements, etc.
// - Dispatches engine runs with injected webhook context

import { logger } from '../logger';
import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { TelegramClient } from './client';
import { TelegramAdapter, type TelegramMessageInfo } from './adapter';
import { createHash } from 'crypto';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { WorkspaceManager } from '../utils/workspace-manager';

export type TelegramPollingConfig = {
  botToken?: string;
  pollingTimeout?: number; // getUpdates timeout in seconds (default: 30)
  chatAllowlist?: (string | number)[]; // chat IDs to respond in
  requireMention?: boolean; // in groups, only respond when @mentioned or replied to (default: true)
  workflow?: string;
};

export class TelegramPollingRunner implements Runner {
  readonly name = 'telegram';
  private client: TelegramClient;
  private adapter: TelegramAdapter;
  private engine: StateMachineExecutionEngine;
  private cfg: VisorConfig;
  private chatAllowlist: Set<string>;
  private requireMention: boolean;
  private runnerHandle?: RunnerHandle;
  private processedUpdates: Map<number, number> = new Map(); // update_id -> timestamp
  private activeChats = new Set<string>();
  private taskStore?: import('../agent-protocol/task-store').TaskStore;
  private configPath?: string;

  constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: TelegramPollingConfig) {
    const token = opts.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

    this.client = new TelegramClient(token);
    this.adapter = new TelegramAdapter(this.client);
    this.engine = engine;
    this.cfg = cfg;
    this.chatAllowlist = new Set((opts.chatAllowlist || []).map(String));
    this.requireMention = opts.requireMention ?? true;
  }

  /** Get the TelegramClient instance (for shared access) */
  getClient(): TelegramClient {
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
    // Initialize bot info
    await this.adapter.initialize();
    const username = this.adapter.getBotUsername();
    logger.info(`[TelegramPolling] Bot initialized: @${username || 'unknown'}`);

    const bot = this.client.getBot();

    // Register message handler
    bot.on(['message', 'channel_post'], async ctx => {
      const msg = ctx.message || ctx.channelPost;
      if (!msg) return;

      // Build TelegramMessageInfo from grammy context
      const msgInfo: TelegramMessageInfo = {
        message_id: msg.message_id,
        from: msg.from
          ? {
              id: msg.from.id,
              is_bot: msg.from.is_bot,
              first_name: msg.from.first_name,
              username: msg.from.username,
            }
          : undefined,
        chat: {
          id: msg.chat.id,
          type: msg.chat.type as TelegramMessageInfo['chat']['type'],
          title: (msg.chat as any).title,
          username: (msg.chat as any).username,
        },
        date: msg.date,
        text: (msg as any).text,
        caption: (msg as any).caption,
        reply_to_message: (msg as any).reply_to_message
          ? {
              message_id: (msg as any).reply_to_message.message_id,
              from: (msg as any).reply_to_message.from,
              chat: (msg as any).reply_to_message.chat,
              date: (msg as any).reply_to_message.date,
              text: (msg as any).reply_to_message.text,
            }
          : undefined,
        message_thread_id: (msg as any).message_thread_id,
      };

      await this.handleMessage(msgInfo);
    });

    // Error handler
    bot.catch(err => {
      logger.error(`[TelegramPolling] Bot error: ${err.message || String(err)}`);
    });

    // Start polling with @grammyjs/runner for concurrent processing
    this.runnerHandle = run(bot);
    logger.info('[TelegramPolling] Polling started');

    // Clean up stale workspace directories
    WorkspaceManager.cleanupStale().catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.runnerHandle) {
      this.runnerHandle.stop();
      logger.info('[TelegramPolling] Polling stopped');
    }
  }

  private async handleMessage(msg: TelegramMessageInfo): Promise<void> {
    // 1. Skip messages without text content
    if (!msg.text && !msg.caption) return;

    // 2. Skip own bot messages
    const botId = this.adapter.getBotUserId();
    if (msg.from?.id === botId) return;

    // 3. Deduplication
    if (this.isDuplicate(msg.message_id, msg.chat.id)) return;

    // 4. Chat allowlist check
    if (this.chatAllowlist.size > 0 && !this.chatAllowlist.has(String(msg.chat.id))) {
      return;
    }

    // 5. Mention gating in groups/supergroups
    if (
      !this.adapter.isPrivateChat(msg.chat) &&
      !this.adapter.isChannelPost(msg.chat) &&
      this.requireMention
    ) {
      const text = msg.text || msg.caption || '';
      const isMentioned = this.adapter.isBotMentioned(text);
      const isReplyToBot = msg.reply_to_message?.from?.id === botId;
      if (!isMentioned && !isReplyToBot) return;
    }

    // 6. Build conversation context
    const conversation = this.adapter.buildConversationContext(msg);

    // 7. Build webhook data map (same pattern as Slack)
    const webhookData = new Map<string, unknown>();
    const endpoint = '/bots/telegram/message';
    const payload = {
      event: {
        type: msg.chat.type === 'channel' ? 'channel_post' : 'message',
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        text: msg.text || msg.caption || '',
        from: msg.from,
        chat: msg.chat,
        reply_to_message: msg.reply_to_message,
        message_thread_id: msg.message_thread_id,
      },
      telegram_conversation: conversation,
    };
    webhookData.set(endpoint, payload);

    // 8. Prepare config for run (ensure telegram frontend is enabled)
    const cfgForRun = this.prepareConfigForRun();

    // 9. Derive stable workspace name from chat identity
    const chatKey = `${msg.chat.id}:${msg.message_thread_id || 'root'}`;
    const hash = createHash('sha256').update(chatKey).digest('hex').slice(0, 8);
    if (!(cfgForRun as any).workspace) (cfgForRun as any).workspace = {};
    (cfgForRun as any).workspace.name = `telegram-${hash}`;
    (cfgForRun as any).workspace.cleanup_on_exit = false;

    // 10. Determine checks to run
    const allChecks = Object.keys(this.cfg.checks || {});
    if (allChecks.length === 0) return;

    const chatTrackKey = this.trackChat(String(msg.chat.id));
    try {
      const runEngine = new StateMachineExecutionEngine();

      // Inject Telegram client into execution context
      try {
        const parentCtx: any = (this.engine as any).getExecutionContext?.() || {};
        const prevCtx: any = (runEngine as any).getExecutionContext?.() || {};
        (runEngine as any).setExecutionContext?.({
          ...parentCtx,
          ...prevCtx,
          telegram: this.client,
          telegramClient: this.client,
        });
      } catch {}

      logger.info(
        `[TelegramPolling] Dispatching engine run for chat ${msg.chat.id} (${msg.chat.type})`
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
            source: 'telegram',
            workflowId: allChecks.join(','),
            configPath: this.configPath,
            messageText: String(msg.text || msg.caption || 'Telegram message'),
            metadata: {
              telegram_chat_id: String(msg.chat.id),
              telegram_chat_type: msg.chat.type,
              telegram_user: msg.from ? String(msg.from.id) : 'unknown',
            },
          },
          execFn
        );
      } else {
        await execFn();
      }
    } catch (e) {
      logger.error(
        `[TelegramPolling] Engine execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      if (chatTrackKey) this.untrackChat(chatTrackKey);
    }
  }

  /** Ensure telegram frontend is in the config for this run */
  private prepareConfigForRun(): VisorConfig {
    try {
      const cfg = JSON.parse(JSON.stringify(this.cfg));
      const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];
      if (!fronts.some((f: any) => f && f.name === 'telegram')) {
        fronts.push({ name: 'telegram' });
      }
      cfg.frontends = fronts;
      return cfg;
    } catch {
      return this.cfg;
    }
  }

  /** Deduplication: track processed updates by chat_id:message_id */
  private isDuplicate(messageId: number, chatId: number): boolean {
    const key = chatId * 1000000 + messageId; // simple composite key
    const now = Date.now();
    // Cleanup old entries
    for (const [k, t] of this.processedUpdates.entries()) {
      if (now - t > 10000) this.processedUpdates.delete(k);
    }
    if (this.processedUpdates.has(key)) return true;
    this.processedUpdates.set(key, now);
    return false;
  }

  private trackChat(chatId: string): string {
    this.activeChats.add(chatId);
    return chatId;
  }

  private untrackChat(chatId: string): void {
    this.activeChats.delete(chatId);
  }
}
