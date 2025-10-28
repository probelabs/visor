type AnyFunc = (...args: any[]) => Promise<any>;

export interface RecordedCall {
  provider: 'github';
  op: string; // e.g., issues.createComment
  args: Record<string, unknown>;
  ts: number;
}

/**
 * Very small Recording Octokit that implements only the methods we need for
 * discovery/MVP. It records all invocations in-memory.
 */
export class RecordingOctokit {
  public readonly calls: RecordedCall[] = [];

  public readonly rest: any;
  private readonly mode?: { errorCode?: number; timeoutMs?: number };

  constructor(opts?: { errorCode?: number; timeoutMs?: number }) {
    this.mode = opts;
    // Build a dynamic proxy for rest.* namespaces and methods so we don't
    // hardcode the surface of Octokit. Unknown ops still get recorded.
    const makeMethod = (opPath: string[]): AnyFunc => {
      const op = opPath.join('.');
      return async (args: Record<string, unknown> = {}) => {
        this.calls.push({ provider: 'github', op, args, ts: Date.now() });
        return this.stubResponse(op, args);
      };
    };

    // Top-level rest object with common namespaces proxied to functions
    this.rest = {} as any;
    // Common namespaces
    (this.rest as any).issues = new Proxy(
      {},
      {
        get: (_t, p: string | symbol) =>
          typeof p === 'string' ? makeMethod(['issues', p]) : undefined,
      }
    );
    (this.rest as any).pulls = new Proxy(
      {},
      {
        get: (_t, p: string | symbol) =>
          typeof p === 'string' ? makeMethod(['pulls', p]) : undefined,
      }
    );
    (this.rest as any).checks = new Proxy(
      {},
      {
        get: (_t, p: string | symbol) =>
          typeof p === 'string' ? makeMethod(['checks', p]) : undefined,
      }
    );
  }

  private stubResponse(op: string, args: Record<string, unknown>): any {
    if (this.mode?.errorCode) {
      const err: any = new Error(`Simulated GitHub error ${this.mode.errorCode}`);
      err.status = this.mode.errorCode;
      throw err;
    }
    if (this.mode?.timeoutMs) {
      return new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Simulated GitHub timeout ${this.mode!.timeoutMs}ms`)),
          this.mode!.timeoutMs
        )
      );
    }
    if (op === 'issues.createComment' || op === 'issues.updateComment') {
      return {
        data: {
          id: 1,
          body: String((args as any).body || ''),
          html_url: '',
          user: { login: 'bot' },
          created_at: new Date().toISOString(),
        },
      };
    }
    if (op === 'issues.addLabels') {
      return { data: { labels: (args as any).labels || [] } };
    }
    if (op.startsWith('checks.')) {
      return { data: { id: 123, status: 'completed', conclusion: 'success', url: '' } };
    }
    if (op === 'pulls.get') {
      return { data: { number: (args as any).pull_number || 1, state: 'open', title: 'Test PR' } };
    }
    if (op === 'pulls.listFiles') {
      return { data: [] };
    }
    return { data: {} };
  }
}
