import type { TelegramClient } from '../telegram/client';
import type { TaskLiveUpdateSink } from './task-live-updates';
export declare class TelegramTaskLiveUpdateSink implements TaskLiveUpdateSink {
    private readonly telegram;
    private readonly chatId;
    private readonly replyToMessageId;
    private readonly messageThreadId?;
    readonly kind = "telegram";
    private messageId?;
    constructor(telegram: TelegramClient, chatId: number | string, replyToMessageId: number, messageThreadId?: number | undefined, initialMessageId?: number);
    start(): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    update(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    complete(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    fail(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    private publish;
}
//# sourceMappingURL=task-live-update-telegram.d.ts.map