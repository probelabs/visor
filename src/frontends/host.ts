import { EventBus } from '../event-bus/event-bus';

export interface FrontendContext {
  eventBus: EventBus;
  logger: {
    info: (...a: any[]) => void;
    warn: (...a: any[]) => void;
    error: (...a: any[]) => void;
  };
  config: unknown;
  run: {
    runId: string;
    workflowId?: string;
    repo?: { owner: string; name: string };
    pr?: number;
    headSha?: string;
    event?: string;
    actor?: string;
  };
  octokit?: any;
  // Optional webhook context (e.g., Slack Events API payload injected by socket runner)
  webhookContext?: { webhookData?: Map<string, unknown>; eventType?: string };
  // Optional engine reference for frontends that spawn their own execution runs (e.g., A2A)
  engine?: any;
  // Optional full VisorConfig for frontends that need access to checks/workflows
  visorConfig?: any;
}

export interface Frontend {
  readonly name: string;
  start(ctx: FrontendContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

/** Frontends that can trigger their own engine executions (e.g., A2A). */
export interface ActiveFrontend extends Frontend {
  setEngine(engine: any): void;
  setVisorConfig(config: any): void;
}

/** Type guard for ActiveFrontend (duck-typed). */
export function isActiveFrontend(f: Frontend): f is ActiveFrontend {
  return (
    typeof (f as any).setEngine === 'function' && typeof (f as any).setVisorConfig === 'function'
  );
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
      } else if (spec.name === 'github') {
        const { GitHubFrontend } = await import('./github-frontend');
        this.frontends.push(new GitHubFrontend());
      } else if (spec.name === 'slack') {
        const { SlackFrontend } = await import('./slack-frontend');
        this.frontends.push(new SlackFrontend(spec.config as any));
      } else if (spec.name === 'tui') {
        const { TuiFrontend } = await import('../tui/tui-frontend');
        this.frontends.push(new TuiFrontend(spec.config as any));
      } else if (spec.name === 'a2a') {
        const { A2AFrontend } = await import('../agent-protocol/a2a-frontend');
        this.frontends.push(new A2AFrontend(spec.config as any));
      } else {
        this.log.warn(`[FrontendsHost] Unknown frontend '${spec.name}', skipping`);
      }
    }
  }

  async startAll(ctxFactory: () => FrontendContext): Promise<void> {
    for (const f of this.frontends) {
      try {
        const ctx = ctxFactory();
        // Auto-inject engine/config into active frontends
        if (isActiveFrontend(f)) {
          if (ctx.engine) f.setEngine(ctx.engine);
          if (ctx.visorConfig) f.setVisorConfig(ctx.visorConfig);
        }
        await f.start(ctx);
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
