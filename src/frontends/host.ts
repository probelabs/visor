import { EventBus } from '../event-bus/event-bus';

export interface FrontendContext {
  eventBus: EventBus;
  logger: {
    info: (...a: any[]) => void;
    warn: (...a: any[]) => void;
    error: (...a: any[]) => void;
  };
  config: unknown;
  run: { runId: string; workflowId?: string; repo?: string; pr?: number; headSha?: string };
}

export interface Frontend {
  readonly name: string;
  start(ctx: FrontendContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface FrontendSpec {
  name: string; // e.g., 'ndjson-sink', 'github', 'slack'
  package?: string; // external package name (future)
  config?: unknown;
}

export class FrontendsHost {
  private bus: EventBus;
  private log: FrontendContext['logger'];
  private frontends: Frontend[] = [];

  constructor(bus: EventBus, log: FrontendContext['logger']) {
    this.bus = bus;
    this.log = log;
  }

  async load(specs: FrontendSpec[]): Promise<void> {
    this.frontends = [];
    for (const spec of specs) {
      if (spec.name === 'ndjson-sink') {
        const { NdjsonSink } = await import('./ndjson-sink');
        this.frontends.push(new NdjsonSink(spec.config));
      } else {
        this.log.warn(`[FrontendsHost] Unknown frontend '${spec.name}', skipping`);
      }
    }
  }

  async startAll(ctxFactory: () => FrontendContext): Promise<void> {
    for (const f of this.frontends) {
      try {
        await f.start(ctxFactory());
        this.log.info(`[FrontendsHost] Started frontend '${f.name}'`);
      } catch (err) {
        this.log.error(`[FrontendsHost] Failed to start '${f.name}':`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const f of this.frontends) {
      try {
        await f.stop();
      } catch (err) {
        this.log.error(`[FrontendsHost] Failed to stop '${f.name}':`, err);
      }
    }
  }
}
