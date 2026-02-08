/**
 * TUI Chat Runner
 *
 * Handles user input from the ChatTUI, creates webhook context,
 * and triggers workflow execution via StateMachineExecutionEngine.
 *
 * Similar to SlackSocketRunner but adapted for terminal environment.
 */
import { logger } from '../logger';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { ChatTUI } from './chat-tui';
import { ChatStateManager, setChatStateManager } from './chat-state';
import { TuiFrontend } from './tui-frontend';
import { withActiveSpan } from '../telemetry/trace-helpers';

export interface TuiChatRunnerConfig {
  engine?: StateMachineExecutionEngine;
  config: VisorConfig;
  stateManager?: ChatStateManager;
  endpoint?: string;
  debug?: boolean;
}

export class TuiChatRunner {
  private cfg: VisorConfig;
  private stateManager: ChatStateManager;
  private chatTui?: ChatTUI;
  private tuiFrontend?: TuiFrontend;
  private endpoint: string;
  private debug: boolean;
  private messageCounter = 0;
  private isRunning = false;
  private currentExecution?: Promise<void>;

  constructor(config: TuiChatRunnerConfig) {
    this.cfg = config.config;
    this.stateManager = config.stateManager ?? new ChatStateManager();
    this.endpoint = config.endpoint ?? '/tui/chat';
    this.debug = config.debug ?? false;

    // Set as global state manager
    setChatStateManager(this.stateManager);
  }

  async start(): Promise<void> {
    // Create ChatTUI
    this.chatTui = new ChatTUI({
      stateManager: this.stateManager,
      onMessageSubmit: (message: string) => this.handleUserMessage(message),
      onExit: () => this.stop(),
    });

    // Create and configure TUI frontend
    this.tuiFrontend = new TuiFrontend({
      chatTui: this.chatTui,
    });

    // Start the TUI
    this.chatTui.start();
    this.chatTui.captureConsole();

    // Add welcome message
    this.chatTui.addSystemMessage('Welcome to Visor Chat. Type a message to start...');

    logger.info('[TuiChatRunner] Chat TUI started');
    this.isRunning = true;
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.tuiFrontend) {
      this.tuiFrontend.stop();
      this.tuiFrontend = undefined;
    }

    if (this.chatTui) {
      this.chatTui.stop();
      this.chatTui = undefined;
    }

    logger.info('[TuiChatRunner] Chat TUI stopped');
  }

  getChatTUI(): ChatTUI | undefined {
    return this.chatTui;
  }

  getStateManager(): ChatStateManager {
    return this.stateManager;
  }

  getTuiFrontend(): TuiFrontend | undefined {
    return this.tuiFrontend;
  }

  private async handleUserMessage(message: string): Promise<void> {
    if (!message.trim()) return;

    const messageId = `msg-${++this.messageCounter}`;

    try {
      // Check if we're waiting for human input
      const waitingState = this.stateManager.waitingState;
      if (waitingState) {
        // Resume from waiting state
        await this.resumeFromWaiting(message, waitingState);
        return;
      }

      // Start new execution
      await this.executeWorkflow(message, messageId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TuiChatRunner] Error handling message: ${errorMessage}`);
      this.chatTui?.addSystemMessage(`Error: ${errorMessage}`);
      this.chatTui?.setProcessing(false);
    }
  }

  private async resumeFromWaiting(message: string, _waitingState: any): Promise<void> {
    // Clear waiting state
    this.stateManager.clearWaiting();

    // The human-input check should be resumed through the engine
    // This is typically done via snapshot resume or the human-input provider
    logger.info(`[TuiChatRunner] Resuming with user input: ${message.substring(0, 50)}...`);

    // For now, trigger a new execution with the message
    // In full implementation, this would resume from a snapshot
    await this.executeWorkflow(message, `resume-${this.messageCounter}`);
  }

  private async executeWorkflow(message: string, messageId: string): Promise<void> {
    if (this.currentExecution) {
      // Queue the message if an execution is already running
      this.stateManager.queueInput(message);
      logger.info('[TuiChatRunner] Message queued, execution in progress');
      return;
    }

    this.chatTui?.setProcessing(true);
    this.stateManager.setProcessing(true);

    // Build webhook context with user message
    const webhookData = new Map<string, unknown>();
    const tuiPayload = {
      type: 'tui_message',
      message_id: messageId,
      text: message,
      timestamp: new Date().toISOString(),
      user: {
        id: 'tui-user',
        name: process.env.USER || 'user',
      },
    };
    webhookData.set(this.endpoint, tuiPayload);

    // Ensure TUI frontend is enabled
    const cfgForRun = this.prepareConfigForRun();

    // Determine checks to run
    const allChecks = Object.keys(cfgForRun.checks || {});
    if (allChecks.length === 0) {
      this.chatTui?.addSystemMessage('No checks configured in workflow');
      this.chatTui?.setProcessing(false);
      return;
    }

    // Create a new engine instance for this execution
    const runEngine = new StateMachineExecutionEngine();

    // Set execution context with TUI hooks
    try {
      const ctx: any = {
        tuiChatRunner: this,
        hooks: {
          onHumanInput: async (request: any) => {
            if (!this.chatTui) throw new Error('TUI not available');
            return this.chatTui.promptUser({
              prompt: request.prompt,
              placeholder: request.placeholder,
              multiline: request.multiline,
              timeout: request.timeout,
              defaultValue: request.default,
              allowEmpty: request.allowEmpty,
            });
          },
          onCheckComplete: () => {
            // Handled by TuiFrontend
          },
        },
      };
      (runEngine as any).setExecutionContext?.(ctx);
    } catch {}

    logger.info(`[TuiChatRunner] Executing workflow for message: ${messageId}`);

    this.currentExecution = withActiveSpan(
      'visor.run',
      {
        'visor.run.source': 'tui',
        'tui.message_id': messageId,
      },
      async () => {
        try {
          await runEngine.executeChecks({
            checks: allChecks,
            showDetails: true,
            outputFormat: 'json',
            config: cfgForRun,
            webhookContext: { webhookData, eventType: 'manual' },
            debug: this.debug,
          } as any);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[TuiChatRunner] Workflow execution failed: ${errorMessage}`);
          this.chatTui?.addSystemMessage(`Workflow error: ${errorMessage}`);
        } finally {
          this.currentExecution = undefined;
          this.chatTui?.setProcessing(false);
          this.stateManager.setProcessing(false);

          // Process any queued messages
          const queuedMessage = this.stateManager.dequeueInput();
          if (queuedMessage) {
            logger.info('[TuiChatRunner] Processing queued message');
            await this.handleUserMessage(queuedMessage);
          }
        }
      }
    );

    await this.currentExecution;
  }

  private prepareConfigForRun(): VisorConfig {
    try {
      const cfg = JSON.parse(JSON.stringify(this.cfg));
      const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];

      // Ensure TUI frontend is enabled
      if (!fronts.some((f: any) => f && f.name === 'tui')) {
        fronts.push({ name: 'tui' });
      }

      cfg.frontends = fronts;
      return cfg;
    } catch {
      return this.cfg;
    }
  }

  async waitForExit(timeoutMs?: number): Promise<void> {
    if (!this.chatTui) return;
    await this.chatTui.waitForExit(timeoutMs);
  }
}

/**
 * Create and start a TuiChatRunner with the given configuration.
 */
export async function startChatTUI(config: TuiChatRunnerConfig): Promise<TuiChatRunner> {
  const runner = new TuiChatRunner(config);
  await runner.start();
  return runner;
}
