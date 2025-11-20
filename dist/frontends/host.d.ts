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
        repo?: {
            owner: string;
            name: string;
        };
        pr?: number;
        headSha?: string;
    };
    octokit?: any;
}
export interface Frontend {
    readonly name: string;
    start(ctx: FrontendContext): Promise<void> | void;
    stop(): Promise<void> | void;
}
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