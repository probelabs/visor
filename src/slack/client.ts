// Lightweight Slack Web API wrapper implemented with fetch (no external deps).
// Only methods needed by SlackFrontend are implemented.

export class SlackClient {
  private token: string;

  constructor(botToken: string) {
    if (!botToken || typeof botToken !== 'string') {
      throw new Error('SlackClient: botToken is required');
    }
    this.token = botToken;
  }

  public readonly chat = {
    postMessage: async ({
      channel,
      text,
      thread_ts,
    }: {
      channel: string;
      text: string;
      thread_ts?: string;
    }) => {
      const resp: any = await this.api('chat.postMessage', { channel, text, thread_ts });
      if (!resp || resp.ok !== true)
        throw new Error(
          `Slack chat.postMessage failed: ${(resp && resp.error) || 'unknown_error'}`
        );
      // Normalize common fields for tests/frontend
      return {
        ts: resp.ts || (resp.message && resp.message.ts) || undefined,
        message: resp.message,
        data: resp,
      };
    },
    update: async ({ channel, ts, text }: { channel: string; ts: string; text: string }) => {
      const resp: any = await this.api('chat.update', { channel, ts, text });
      if (!resp || resp.ok !== true)
        throw new Error(`Slack chat.update failed: ${(resp && resp.error) || 'unknown_error'}`);
      return { ok: true, ts: resp.ts || ts };
    },
  };

  async getBotUserId(): Promise<string> {
    const resp: any = await this.api('auth.test', {});
    if (!resp || resp.ok !== true || !resp.user_id) throw new Error('auth.test failed');
    return String(resp.user_id);
  }

  async fetchThreadReplies(
    channel: string,
    thread_ts: string,
    limit: number = 40
  ): Promise<Array<{ ts: string; user?: string; text?: string; bot_id?: string; thread_ts?: string }>> {
    const resp: any = await this.api('conversations.replies', { channel, ts: thread_ts, limit });
    if (!resp || resp.ok !== true || !Array.isArray(resp.messages)) return [];
    return resp.messages.map((m: any) => ({
      ts: String(m.ts || ''),
      user: m.user,
      text: m.text,
      bot_id: m.bot_id,
      thread_ts: m.thread_ts,
    }));
  }

  getWebClient(): any {
    return {
      conversations: {
        history: async ({ channel, limit }: { channel: string; limit?: number }) =>
          (await this.api('conversations.history', { channel, limit })) as any,
        open: async ({ users }: { users: string }) =>
          (await this.api('conversations.open', { users })) as any,
        replies: async ({ channel, ts, limit }: { channel: string; ts: string; limit?: number }) =>
          (await this.api('conversations.replies', { channel, ts, limit })) as any,
      },
    };
  }

  private async api(method: string, body: Record<string, unknown>): Promise<unknown> {
    // Node 18+ global fetch
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    return (await res.json()) as unknown;
  }
}
