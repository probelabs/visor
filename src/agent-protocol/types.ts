/**
 * Protocol-agnostic agent interoperability types.
 *
 * These types are designed to be protocol-neutral. A2A is the first
 * protocol binding, but the types work equally for ACP, AAIF, etc.
 */

// ---------------------------------------------------------------------------
// Task State
// ---------------------------------------------------------------------------

export type TaskState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'input_required'
  | 'auth_required';

// ---------------------------------------------------------------------------
// Content Types
// ---------------------------------------------------------------------------

/** Protocol-agnostic content part (maps to A2A Part) */
export interface AgentPart {
  text?: string;
  raw?: string; // base64-encoded bytes
  url?: string;
  data?: unknown; // arbitrary JSON value
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

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface TaskStatus {
  state: TaskState;
  message?: AgentMessage;
  timestamp: string; // ISO 8601
}

/** Protocol-agnostic task (maps to A2A Task) */
export interface AgentTask {
  id: string;
  context_id: string;
  status: TaskStatus;
  artifacts: AgentArtifact[];
  history: AgentMessage[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Send Message
// ---------------------------------------------------------------------------

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
export type AgentSendMessageResponse =
  | { task: AgentTask; message?: undefined }
  | { message: AgentMessage; task?: undefined };

// ---------------------------------------------------------------------------
// Streaming Events
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Agent Card (loaded from file, not auto-generated)
// ---------------------------------------------------------------------------

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
  provider?: { organization: string; url?: string };
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentProtocolAuthConfig {
  type: 'bearer' | 'api_key' | 'none';
  token_env?: string;
  header_name?: string;
  param_name?: string;
  key_env?: string;
}

export interface AgentProtocolQueueConfig {
  poll_interval?: number; // ms, default 1000
  max_concurrent?: number; // default 5
  stale_claim_timeout?: number; // ms, default 300000
}

export interface AgentProtocolTlsConfig {
  cert: string;
  key: string;
}

export interface AgentProtocolConfig {
  enabled: boolean;
  protocol: string; // 'a2a' (currently only binding)
  agent_card?: string; // path to Agent Card JSON file
  agent_card_inline?: AgentCard; // inline agent card (alternative to file)
  public_url?: string;
  port?: number; // default 9000
  host?: string; // default '0.0.0.0'
  tls?: AgentProtocolTlsConfig;
  auth?: AgentProtocolAuthConfig;
  default_workflow?: string;
  skill_routing?: Record<string, string>; // skill_id -> workflow name
  task_ttl?: string; // e.g. '7d'
  queue?: AgentProtocolQueueConfig;
}

/** A2A check provider config (for calling external agents) */
export interface AgentCheckConfig {
  type: 'a2a';
  agent_card?: string; // URL to agent card
  agent_url?: string; // direct endpoint URL
  auth?: {
    scheme: string;
    token_env?: string;
    header_name?: string;
  };
  message: string; // Liquid template
  data?: Record<string, string>; // Liquid-templated structured data
  files?: Array<{
    url: string;
    media_type?: string;
    filename?: string;
  }>;
  blocking?: boolean; // default true
  timeout?: number; // ms, default 300000
  poll_interval?: number; // ms, default 2000
  max_turns?: number; // default 1
  on_input_required?: string; // Liquid template for auto-reply
  transform_js?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly fromState: TaskState,
    public readonly toState: TaskState,
    detail?: string
  ) {
    super(
      `Invalid state transition from '${fromState}' to '${toState}'${detail ? `: ${detail}` : ''}`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class ContextMismatchError extends Error {
  constructor(
    public readonly providedContextId: string,
    public readonly existingContextId: string
  ) {
    super(
      `Context ID mismatch: provided '${providedContextId}' but task belongs to '${existingContextId}'`
    );
    this.name = 'ContextMismatchError';
  }
}

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

// ---------------------------------------------------------------------------
// A2A-specific error classes (used by A2A provider/frontend)
// ---------------------------------------------------------------------------

export class A2ATimeoutError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly timeoutMs: number
  ) {
    super(`A2A task ${taskId} timed out after ${timeoutMs}ms`);
    this.name = 'A2ATimeoutError';
  }
}

export class A2ARequestError extends Error {
  constructor(
    public readonly url: string,
    public readonly statusCode: number,
    public readonly body: string
  ) {
    super(`A2A request to ${url} failed with status ${statusCode}: ${body}`);
    this.name = 'A2ARequestError';
  }
}

export class A2AMaxTurnsExceededError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly maxTurns: number
  ) {
    super(`A2A task ${taskId} exceeded max turns (${maxTurns})`);
    this.name = 'A2AMaxTurnsExceededError';
  }
}

export class A2AInputRequiredError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly prompt: string
  ) {
    super(`A2A task ${taskId} requires input: ${prompt}`);
    this.name = 'A2AInputRequiredError';
  }
}

export class A2AAuthRequiredError extends Error {
  constructor(public readonly taskId: string) {
    super(`A2A task ${taskId} requires authentication`);
    this.name = 'A2AAuthRequiredError';
  }
}

export class A2ATaskFailedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly detail: string
  ) {
    super(`A2A task ${taskId} failed: ${detail}`);
    this.name = 'A2ATaskFailedError';
  }
}

export class A2ATaskRejectedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly state: string
  ) {
    super(`A2A task ${taskId} was ${state}`);
    this.name = 'A2ATaskRejectedError';
  }
}

export class AgentCardFetchError extends Error {
  constructor(
    public readonly url: string,
    public readonly statusCode: number,
    public readonly statusText: string
  ) {
    super(`Failed to fetch Agent Card from ${url}: ${statusCode} ${statusText}`);
    this.name = 'AgentCardFetchError';
  }
}

export class InvalidAgentCardError extends Error {
  constructor(
    public readonly url: string,
    public readonly detail: string
  ) {
    super(`Invalid Agent Card from ${url}: ${detail}`);
    this.name = 'InvalidAgentCardError';
  }
}
