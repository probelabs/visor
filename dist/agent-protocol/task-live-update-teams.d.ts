import type { TeamsClient } from '../teams/client';
import type { ConversationReference } from 'botbuilder';
import type { TaskLiveUpdateSink } from './task-live-updates';
export declare class TeamsTaskLiveUpdateSink implements TaskLiveUpdateSink {
    private readonly teams;
    private readonly conversationReference;
    private readonly replyToActivityId?;
    readonly kind = "teams";
    private activityId?;
    constructor(teams: TeamsClient, conversationReference: ConversationReference, replyToActivityId?: string | undefined, initialActivityId?: string);
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
//# sourceMappingURL=task-live-update-teams.d.ts.map