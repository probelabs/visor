// Microsoft Teams Bot Framework API client.
// Wraps the botbuilder SDK for sending messages via Bot Framework.

import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  MessageFactory,
} from 'botbuilder';
import type { ConversationReference } from 'botbuilder';
import { chunkText } from './markdown';

export interface TeamsSendResult {
  ok: boolean;
  activityId?: string;
  error?: string;
}

export interface TeamsClientOptions {
  appId: string;
  appPassword: string;
  tenantId?: string;
}

export class TeamsClient {
  private appId: string;
  private appPassword: string;
  private tenantId?: string;
  private adapter: CloudAdapter;

  constructor(opts: TeamsClientOptions) {
    if (!opts.appId) throw new Error('TeamsClient: appId is required');
    if (!opts.appPassword) throw new Error('TeamsClient: appPassword is required');
    this.appId = opts.appId;
    this.appPassword = opts.appPassword;
    this.tenantId = opts.tenantId;

    const auth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.appId,
      MicrosoftAppPassword: this.appPassword,
      MicrosoftAppTenantId: this.tenantId || '',
    });
    this.adapter = new CloudAdapter(auth);
  }

  /** Get the underlying CloudAdapter (used by webhook runner for processing inbound) */
  getAdapter(): CloudAdapter {
    return this.adapter;
  }

  /** Get the configured App ID */
  getAppId(): string {
    return this.appId;
  }

  /**
   * Send a text message using a stored conversation reference.
   * Auto-chunks at 28000 characters.
   */
  async sendMessage(opts: {
    conversationReference: ConversationReference;
    text: string;
    replyToActivityId?: string;
  }): Promise<TeamsSendResult> {
    const chunks = chunkText(opts.text, 28000);
    let lastActivityId: string | undefined;

    for (const chunk of chunks) {
      try {
        await this.adapter.continueConversationAsync(
          this.appId,
          opts.conversationReference,
          async (turnContext: TurnContext) => {
            const activity = MessageFactory.text(chunk);
            if (opts.replyToActivityId) {
              activity.replyToId = opts.replyToActivityId;
            }
            const response = await turnContext.sendActivity(activity);
            lastActivityId = response?.id;
          }
        );
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: true, activityId: lastActivityId };
  }

  /**
   * Update an existing bot message.
   * For safety, only supports single-activity payloads. Oversized content returns msg_too_long.
   */
  async updateMessage(opts: {
    conversationReference: ConversationReference;
    activityId: string;
    text: string;
  }): Promise<TeamsSendResult> {
    const chunks = chunkText(opts.text, 28000);
    if (chunks.length > 1) {
      return { ok: false, error: 'msg_too_long' };
    }

    try {
      await this.adapter.continueConversationAsync(
        this.appId,
        opts.conversationReference,
        async (turnContext: TurnContext) => {
          const activity = MessageFactory.text(chunks[0] || '');
          activity.id = opts.activityId;
          await turnContext.updateActivity(activity);
        }
      );
      return { ok: true, activityId: opts.activityId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Delete a previously sent bot message.
   */
  async deleteMessage(opts: {
    conversationReference: ConversationReference;
    activityId: string;
  }): Promise<boolean> {
    try {
      await this.adapter.continueConversationAsync(
        this.appId,
        opts.conversationReference,
        async (turnContext: TurnContext) => {
          await turnContext.deleteActivity(opts.activityId);
        }
      );
      return true;
    } catch {
      return false;
    }
  }
}
