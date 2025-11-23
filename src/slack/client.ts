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

  public readonly reactions = {
    add: async ({
      channel,
      timestamp,
      name,
    }: {
      channel: string;
      timestamp: string;
      name: string;
    }) => {
      const resp: any = await this.api('reactions.add', { channel, timestamp, name });
      if (!resp || resp.ok !== true) {
        // Non-fatal in CLI/test runs – log and continue
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(`Slack reactions.add failed (non-fatal): ${err}`);
        return { ok: false as const };
      }
      return { ok: true } as const;
    },
    remove: async ({
      channel,
      timestamp,
      name,
    }: {
      channel: string;
      timestamp: string;
      name: string;
    }) => {
      const resp: any = await this.api('reactions.remove', { channel, timestamp, name });
      if (!resp || resp.ok !== true) {
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(`Slack reactions.remove failed (non-fatal): ${err}`);
        return { ok: false as const };
      }
      return { ok: true } as const;
    },
  };

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
      if (!resp || resp.ok !== true) {
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(`Slack chat.postMessage failed (non-fatal): ${err}`);
        return {
          ts: undefined,
          message: undefined,
          data: resp,
        };
      }
      // Normalize common fields for tests/frontend
      return {
        ts: resp.ts || (resp.message && resp.message.ts) || undefined,
        message: resp.message,
        data: resp,
      };
    },
    update: async ({ channel, ts, text }: { channel: string; ts: string; text: string }) => {
      const resp: any = await this.api('chat.update', { channel, ts, text });
      if (!resp || resp.ok !== true) {
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(`Slack chat.update failed (non-fatal): ${err}`);
        return { ok: false as const, ts };
      }
      return { ok: true as const, ts: resp.ts || ts };
    },
  };

  async getBotUserId(): Promise<string> {
    const resp: any = await this.api('auth.test', {});
    if (!resp || resp.ok !== true || !resp.user_id) {
      console.warn('Slack auth.test failed (non-fatal); bot user id unavailable');
      return 'UNKNOWN_BOT';
    }
    return String(resp.user_id);
  }

  async fetchThreadReplies(
    channel: string,
    thread_ts: string,
    limit: number = 40
  ): Promise<
    Array<{ ts: string; user?: string; text?: string; bot_id?: string; thread_ts?: string }>
  > {
    try {
      // Use query-string GET semantics similar to Slack WebClient to avoid
      // subtle JSON/form encoding issues that can cause invalid_arguments
      const params = new URLSearchParams({
        channel,
        ts: thread_ts,
        limit: String(limit),
      });
      const res = await fetch(`https://slack.com/api/conversations.replies?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
      const resp: any = await res.json();
      if (!resp || resp.ok !== true || !Array.isArray(resp.messages)) {
        const err = (resp && resp.error) || 'unknown_error';
        console.warn(
          `Slack conversations.replies failed (non-fatal): ${err} (channel=${channel}, ts=${thread_ts}, limit=${limit})`
        );
        return [];
      }
      return resp.messages.map((m: any) => ({
        ts: String(m.ts || ''),
        user: m.user,
        text: m.text,
        bot_id: m.bot_id,
        thread_ts: m.thread_ts,
      }));
    } catch (e) {
      console.warn(
        `Slack conversations.replies failed (non-fatal): ${
          e instanceof Error ? e.message : String(e)
        } (channel=${channel}, ts=${thread_ts}, limit=${limit})`
      );
      return [];
    }
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
