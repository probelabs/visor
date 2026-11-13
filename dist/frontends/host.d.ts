import { EventBus } from '../event-bus/event-bus';
import type { TaskStore } from '../agent-protocol/task-store';
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
        repo?: {
            owner: string;
            name: string;
        };
        pr?: number;
        headSha?: string;
        event?: string;
        actor?: string;
    };
    octokit?: any;
    webhookContext?: {
        webhookData?: Map<string, unknown>;
        eventType?: string;
    };
    engine?: any;
    visorConfig?: any;
    taskStore?: TaskStore;
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
export declare function isActiveFrontend(f: Frontend): f is ActiveFrontend;
export interface FrontendSpec {
    name: string;
    package?: string;
    config?: unknown;
}
export declare class FrontendsHost {
    private bus;
    private log;
    private frontends;
    constructor(bus: EventBus, log: FrontendContext['logger']);
    load(specs: FrontendSpec[]): Promise<void>;
    startAll(ctxFactory: () => FrontendContext): Promise<void>;
    stopAll(): Promise<void>;
}
//# sourceMappingURL=host.d.ts.map