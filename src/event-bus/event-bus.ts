import type { EventEnvelope, AnyEvent } from './types';

export type EventHandler<T = AnyEvent> = (event: T | EventEnvelope<T>) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private anyHandlers: Set<EventHandler> = new Set();

  on<T = AnyEvent>(eventType: string, handler: EventHandler<T>): Subscription {
    const set = this.handlers.get(eventType) || new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(eventType, set);
    return {
      unsubscribe: () => {
        set.delete(handler);
      },
    };
  }

  onAny(handler: EventHandler): Subscription {
    this.anyHandlers.add(handler);
    return { unsubscribe: () => this.anyHandlers.delete(handler) };
  }

  async emit(event: AnyEvent | EventEnvelope): Promise<void> {
    const type = (event as any)?.payload?.type ?? (event as any)?.type ?? 'unknown';
    const list: EventHandler[] = [
      ...Array.from(this.anyHandlers),
      ...Array.from(this.handlers.get(type) || []),
    ];
    for (const h of list) {
      // Run sequentially to keep ordering guarantees per emit call
      // Handlers themselves should fan out if they need concurrency
      await h(event as any);
    }
  }
}
