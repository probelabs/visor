import type { EventEnvelope, AnyEvent } from './types';
export type EventHandler<T = AnyEvent> = (event: T | EventEnvelope<T>) => void | Promise<void>;
export interface Subscription {
    unsubscribe(): void;
}
export declare class EventBus {
    private handlers;
    private anyHandlers;
    on<T = AnyEvent>(eventType: string, handler: EventHandler<T>): Subscription;
    onAny(handler: EventHandler): Subscription;
    emit(event: AnyEvent | EventEnvelope): Promise<void>;
}
//# sourceMappingURL=event-bus.d.ts.map