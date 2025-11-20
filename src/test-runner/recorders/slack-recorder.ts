export interface SlackRecordedCall {
  provider: 'slack';
  op: string; // e.g., chat.postMessage, chat.update
  args: Record<string, unknown>;
  ts: number;
}

/**
 * Minimal Slack recording client used in tests. It mimics a tiny subset of the
 * Slack Web API (`chat.postMessage`, `chat.update`) and keeps an in-memory log
 * of all invocations for assertions.
 */
export class RecordingSlack {
  public readonly calls: SlackRecordedCall[] = [];

  public readonly chat: any;

  constructor() {
    const makeMethod =
      (op: string) =>
      async (args: Record<string, unknown> = {}) => {
        this.calls.push({ provider: 'slack', op, args, ts: Date.now() });
        // Return minimal shapes similar to Slack Web API responses
        if (op === 'chat.postMessage') {
          return { ok: true, ts: '1000.1', message: { ts: '1000.1' } };
        }
        if (op === 'chat.update') {
          return { ok: true, ts: (args as any).ts || '1000.1' };
        }
        return { ok: true };
      };
    this.chat = new Proxy(
      {},
      {
        get: (_t, p: string | symbol) =>
          typeof p === 'string' ? makeMethod(`chat.${p}`) : undefined,
      }
    );
  }
}
