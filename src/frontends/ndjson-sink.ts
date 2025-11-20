import type { Frontend, FrontendContext } from './host';
import fs from 'fs';
import path from 'path';

type SinkConfig = { file?: string };

export class NdjsonSink implements Frontend {
  public readonly name = 'ndjson-sink';
  private cfg: SinkConfig;
  private unsub?: { unsubscribe(): void };
  private filePath?: string;

  constructor(config?: unknown) {
    this.cfg = (config as SinkConfig) || {};
  }

  start(ctx: FrontendContext): void {
    this.filePath = this.resolveFile(this.cfg.file || '.visor-events.ndjson');
    ctx.logger.info(`[ndjson-sink] Writing events to ${this.filePath}`);
    // Subscribe to all events
    this.unsub = ctx.eventBus.onAny(async (envelope: any) => {
      try {
        const line = JSON.stringify({
          id: (envelope && envelope.id) || undefined,
          ts: new Date().toISOString(),
          runId: ctx.run.runId,
          payload: (envelope && envelope.payload) || envelope,
          safe: true,
        });
        await fs.promises.appendFile(this.filePath!, line + '\n');
      } catch (err) {
        ctx.logger.error('[ndjson-sink] Failed to write event:', err);
      }
    });
  }

  stop(): void {
    this.unsub?.unsubscribe();
    this.unsub = undefined;
  }

  private resolveFile(p: string): string {
    if (path.isAbsolute(p)) return p;
    return path.join(process.cwd(), p);
  }
}
