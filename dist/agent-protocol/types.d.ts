/**
 * Protocol-agnostic agent interoperability types.
 *
 * These types are designed to be protocol-neutral. A2A is the first
 * protocol binding, but the types work equally for ACP, AAIF, etc.
 */
export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'input_required' | 'auth_required';
/** Protocol-agnostic content part (maps to A2A Part) */
export interface AgentPart {
    text?: string;
    raw?: string;
    url?: string;
    data?: unknown;
    metadata?: Record<string, unknown>;
    filename?: string;
    media_type?: string;
}
/** Protocol-agnostic message (maps to A2A Message) */
export interface AgentMessage {
    message_id: string;
    context_id?: string;
    task_id?: string;
    role: 'user' | 'agent';
    parts: AgentPart[];
    metadata?: Record<string, unknown>;
    extensions?: string[];
    reference_task_ids?: string[];
}
/** Protocol-agnostic artifact (maps to A2A Artifact) */
export interface AgentArtifact {
    artifact_id: string;
    name?: string;
    description?: string;
    parts: AgentPart[];
    metadata?: Record<string, unknown>;
}
export interface TaskStatus {
    state: TaskState;
    message?: AgentMessage;
    timestamp: string;
}
/** Protocol-agnostic task (maps to A2A Task) */
export interface AgentTask {
    id: string;
    context_id: string;
    status: TaskStatus;
    artifacts: AgentArtifact[];
    history: AgentMessage[];
    metadata?: Record<string, unknown>;
    workflow_id?: string;
}
/** Protocol-agnostic push notification config */
export interface AgentPushNotificationConfig {
    id?: string;
    task_id: string;
    url: string;
    token?: string;
    auth_scheme?: string;
    auth_credentials?: string;
}
/** Protocol-agnostic send configuration (maps to A2A SendMessageConfiguration) */
export interface AgentSendMessageConfig {
    accepted_output_modes?: string[];
    task_push_notification_config?: AgentPushNotificationConfig;
    history_length?: number;
    blocking?: boolean;
}
/** Protocol-agnostic send request (maps to A2A SendMessageRequest) */
export interface AgentSendMessageRequest {
    message: AgentMessage;
    configuration?: AgentSendMessageConfig;
    metadata?: Record<string, unknown>;
}
/** Protocol-agnostic response: Task OR Message */
export type AgentSendMessageResponse = {
    task: AgentTask;
    message?: undefined;
} | {
    message: AgentMessage;
    task?: undefined;
};
export interface TaskStatusUpdateEvent {
    type: 'TaskStatusUpdateEvent';
    task_id: string;
    context_id: string;
    status: TaskStatus;
    metadata?: Record<string, unknown>;
}
export interface TaskArtifactUpdateEvent {
    type: 'TaskArtifactUpdateEvent';
    task_id: string;
    context_id: string;
    artifact: AgentArtifact;
    append: boolean;
    last_chunk: boolean;
    metadata?: Record<string, unknown>;
}
export interface AgentSkill {
    id: string;
    name: string;
    description: string;
    tags?: string[];
    examples?: string[];
    input_modes?: string[];
    output_modes?: string[];
}
export interface AgentCapabilities {
    streaming?: boolean;
    push_notifications?: boolean;
    extensions?: string[];
    extended_agent_card?: boolean;
}
export interface AgentCard {
    name: string;
    description?: string;
    version?: string;
    provider?: {
        organization: string;
        url?: string;
    };
    supported_interfaces?: Array<{
        url: string;
        protocol_binding?: string;
        protocol_version?: string;
    }>;
    capabilities?: AgentCapabilities;
    default_input_modes?: string[];
    default_output_modes?: string[];
    security_schemes?: Record<string, unknown>;
    security_requirements?: unknown[];
    skills?: AgentSkill[];
    icon_url?: string;
}
export interface AgentProtocolAuthConfig {
    type: 'bearer' | 'api_key' | 'none';
    token_env?: string;
    header_name?: string;
    param_name?: string;
    key_env?: string;
}
export interface AgentProtocolQueueConfig {
    poll_interval?: number;
    max_concurrent?: number;
    stale_claim_timeout?: number;
}
export interface AgentProtocolTlsConfig {
    cert: string;
    key: string;
}
export interface AgentProtocolConfig {
    enabled: boolean;
    protocol: string;
    agent_card?: string;
    agent_card_inline?: AgentCard;
    public_url?: string;
    port?: number;
    host?: string;
    tls?: AgentProtocolTlsConfig;
    auth?: AgentProtocolAuthConfig;
    default_workflow?: string;
    skill_routing?: Record<string, string>;
    task_ttl?: string;
    queue?: AgentProtocolQueueConfig;
}
/** A2A check provider config (for calling external agents) */
export interface AgentCheckConfig {
    type: 'a2a';
    agent_card?: string;
    agent_url?: string;
    auth?: {
        scheme: string;
        token_env?: string;
        header_name?: string;
    };
    message: string;
    data?: Record<string, string>;
    files?: Array<{
        url: string;
        media_type?: string;
        filename?: string;
    }>;
    blocking?: boolean;
    timeout?: number;
    poll_interval?: number;
    max_turns?: number;
    on_input_required?: string;
    transform_js?: string;
    [key: string]: unknown;
}
export declare class InvalidStateTransitionError extends Error {
    readonly fromState: TaskState;
    readonly toState: TaskState;
    constructor(fromState: TaskState, toState: TaskState, detail?: string);
}
export declare class TaskNotFoundError extends Error {
    readonly taskId: string;
    constructor(taskId: string);
}
export declare class ContextMismatchError extends Error {
    readonly providedContextId: string;
    readonly existingContextId: string;
    constructor(providedContextId: string, existingContextId: string);
}
export declare class InvalidRequestError extends Error {
    constructor(message: string);
}
export declare class ParseError extends Error {
    constructor(message: string);
}
export declare class A2ATimeoutError extends Error {
    readonly taskId: string;
    readonly timeoutMs: number;
    constructor(taskId: string, timeoutMs: number);
}
export declare class A2ARequestError extends Error {
    readonly url: string;
    readonly statusCode: number;
    readonly body: string;
    constructor(url: string, statusCode: number, body: string);
}
export declare class A2AMaxTurnsExceededError extends Error {
    readonly taskId: string;
    readonly maxTurns: number;
    constructor(taskId: string, maxTurns: number);
}
export declare class A2AInputRequiredError extends Error {
    readonly taskId: string;
    readonly prompt: string;
    constructor(taskId: string, prompt: string);
}
export declare class A2AAuthRequiredError extends Error {
    readonly taskId: string;
    constructor(taskId: string);
}
export declare class A2ATaskFailedError extends Error {
    readonly taskId: string;
    readonly detail: string;
    constructor(taskId: string, detail: string);
}
export declare class A2ATaskRejectedError extends Error {
    readonly taskId: string;
    readonly state: string;
    constructor(taskId: string, state: string);
}
export declare class AgentCardFetchError extends Error {
    readonly url: string;
    readonly statusCode: number;
    readonly statusText: string;
    constructor(url: string, statusCode: number, statusText: string);
}
export declare class InvalidAgentCardError extends Error {
    readonly url: string;
    readonly detail: string;
    constructor(url: string, detail: string);
}
//# sourceMappingURL=types.d.ts.map