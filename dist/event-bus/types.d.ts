export type IntegrationEvent = {
    type: 'CheckStatusRequested';
    checkId?: string;
    checkName: string;
    status: 'queued' | 'in_progress' | 'completed' | 'cancelled';
    conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
    output?: {
        title?: string;
        summary?: string;
        text?: string;
        annotations?: any[];
    };
    idempotencyKey?: string;
} | {
    type: 'CommentRequested';
    body: string;
    threadKey?: string;
    commentId?: string;
    idempotencyKey?: string;
} | {
    type: 'CheckStatusCompleted';
    checkId?: string;
    success: boolean;
    error?: {
        message: string;
        stack?: string;
        name?: string;
    };
} | {
    type: 'CommentPosted';
    threadKey?: string;
    commentId: string;
    success: boolean;
    error?: {
        message: string;
        stack?: string;
        name?: string;
    };
};
export interface EventEnvelope<T = any> {
    id: string;
    version: 1;
    timestamp: string;
    runId: string;
    workflowId?: string;
    caseId?: string;
    wave?: number;
    attempt?: number;
    checkId?: string;
    traceId?: string;
    spanId?: string;
    causationId?: string;
    correlationId?: string;
    payload: T;
}
export type AnyEvent = any;
//# sourceMappingURL=types.d.ts.map