import { MemoryStore } from '../memory-store';

/**
 * Create synchronous memory helpers for sandboxed script execution. These mirror
 * the behavior used in the memory provider's exec_js path: mutate in-memory state
 * synchronously and perform at most one save() afterward if needed.
 */
export function createSyncMemoryOps(store: MemoryStore): {
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
} {
  let saveNeeded = false;

  const ensureNs = (ns?: string) => {
    const nsName = ns || store.getDefaultNamespace();
    const anyStore = store as unknown as { data: Map<string, Map<string, unknown>> };
    if (!anyStore['data'].has(nsName)) {
      anyStore['data'].set(nsName, new Map());
    }
    return nsName;
  };

  const ops = {
    get: (key: string, ns?: string) => store.get(key, ns),
    has: (key: string, ns?: string) => store.has(key, ns),
    list: (ns?: string) => store.list(ns),
    getAll: (ns?: string) => store.getAll(ns),
    set: (key: string, value: unknown, ns?: string) => {
      const nsName = ensureNs(ns);
      (store as any)['data'].get(nsName)!.set(key, value);
      saveNeeded = true;
      return value;
    },
    append: (key: string, value: unknown, ns?: string) => {
      const existing = store.get(key, ns);
      let newValue: unknown[];
      if (existing === undefined) newValue = [value];
      else if (Array.isArray(existing)) newValue = [...existing, value];
      else newValue = [existing, value];
      const nsName = ensureNs(ns);
      (store as any)['data'].get(nsName)!.set(key, newValue);
      saveNeeded = true;
      return newValue;
    },
    increment: (key: string, amount = 1, ns?: string) => {
      const nsName = ensureNs(ns);
      const current = store.get(key, nsName);
      const numCurrent = typeof current === 'number' ? (current as number) : 0;
      const newValue = numCurrent + amount;
      (store as any)['data'].get(nsName)!.set(key, newValue);
      saveNeeded = true;
      return newValue;
    },
    delete: (key: string, ns?: string) => {
      const nsName = ensureNs(ns);
      const d = (store as any)['data'].get(nsName)?.delete(key) || false;
      if (d) saveNeeded = true;
      return d;
    },
    clear: (ns?: string) => {
      if (ns) (store as any)['data'].delete(ns);
      else (store as any)['data'].clear();
      saveNeeded = true;
    },
  } as const;

  return { ops: ops as any, needsSave: () => saveNeeded };
}
