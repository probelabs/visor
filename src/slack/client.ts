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
