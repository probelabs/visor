import { MemoryStore } from '../memory-store';
/**
 * Create synchronous memory helpers for sandboxed script execution. These mirror
 * the legacy behavior previously used for in-provider scripting: mutate in-memory state
 * synchronously and perform at most one save() afterward if needed.
 */
export declare function createSyncMemoryOps(store: MemoryStore): {
    ops: {
        get: (key: string, ns?: string) => unknown;
        has: (key: string, ns?: string) => boolean;
        list: (ns?: string) => string[];
        getAll: (ns?: string) => Record<string, unknown>;
        set: (key: string, value: unknown, ns?: string) => unknown;
        append: (key: string, value: unknown, ns?: string) => unknown[];
        increment: (key: string, amount?: number, ns?: string) => number;
        delete: (key: string, ns?: string) => boolean;
        clear: (ns?: string) => void;
    };
    needsSave: () => boolean;
};
//# sourceMappingURL=script-memory-ops.d.ts.map