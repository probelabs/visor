/**
 * A2A Frontend — serves Visor as an A2A-compliant agent.
 *
 * Implements the A2A HTTP endpoints:
 *   GET  /.well-known/agent-card.json  (public, no auth)
 *   POST /message:send                 (auth required)
 *   GET  /tasks/{id}                   (auth required)
 *   GET  /tasks                        (auth required)
 *   POST /tasks/{id}:cancel            (auth required)
 *
 * Milestone 5 adds SSE streaming and push notifications.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../logger';
import type { ActiveFrontend, FrontendContext } from '../frontends/host';
import type { TaskStore } from './task-store';
import { SqliteTaskStore } from './task-store';
import type {
  AgentCard,
  AgentProtocolConfig,
  AgentMessage,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentTask,
  AgentArtifact,
  AgentPart,
  AgentPushNotificationConfig,
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from './types';
import {
  TaskNotFoundError,
  InvalidStateTransitionError,
  InvalidRequestError,
  ContextMismatchError,
} from './types';
import { isTerminalState } from './state-transitions';
import { TaskStreamManager } from './task-stream-manager';
import { PushNotificationManager } from './push-notification-manager';
import { TaskQueue } from './task-queue';
import type { TaskExecutor } from './task-queue';
import type { VisorConfig } from '../types/config';
import type { CheckExecutionOptions } from '../types/execution';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new InvalidRequestError('Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: http.ServerResponse,
  httpStatus: number,
  message: string,
  code?: number
): void {
  sendJson(res, httpStatus, {
    error: {
      code: code ?? -httpStatus,
      message,
    },
  });
}

function timingSafeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function validateAuth(req: http.IncomingMessage, config: AgentProtocolConfig): boolean {
  if (!config.auth || config.auth.type === 'none') return true;

  if (config.auth.type === 'bearer') {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    const expected = config.auth.token_env ? process.env[config.auth.token_env] : undefined;
    return timingSafeEqual(token, expected);
  }

  if (config.auth.type === 'api_key') {
    const headerName = config.auth.header_name ?? 'x-api-key';
    const key = req.headers[headerName.toLowerCase()] as string | undefined;
    const expected = config.auth.key_env ? process.env[config.auth.key_env] : undefined;
    return timingSafeEqual(key, expected);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Workflow translation
// ---------------------------------------------------------------------------

function resolveWorkflow(req: AgentSendMessageRequest, config: AgentProtocolConfig): string {
  if (config.skill_routing && Object.keys(config.skill_routing).length > 0) {
    const requestedSkill = req.metadata?.skill_id as string | undefined;
    if (requestedSkill && config.skill_routing[requestedSkill]) {
      return config.skill_routing[requestedSkill];
    }
  }
  return config.default_workflow ?? 'assistant';
}

export function messageToWorkflowInput(
  message: AgentMessage,
  task: AgentTask
): Record<string, unknown> {
  const textContent = message.parts
    .filter(p => p.text != null)
    .map(p => p.text)
    .join('\n');

  const dataParts = message.parts.filter(p => p.data != null);
  const structuredData =
    dataParts.length === 1
      ? dataParts[0].data
      : dataParts.length > 1
        ? dataParts.map(p => p.data)
        : undefined;

  const fileParts = message.parts.filter(p => p.url != null || p.raw != null);

  return {
    question: textContent,
    task: textContent,
    data: structuredData,
    files: fileParts.length > 0 ? fileParts : undefined,
    _agent: {
      task_id: task.id,
      context_id: task.context_id,
      message_id: message.message_id,
      metadata: message.metadata,
    },
  };
}

/** Convert engine check results to A2A artifacts (used by task queue in M4) */
export function resultToArtifacts(checkResults: Record<string, unknown>): AgentArtifact[] {
  const artifacts: AgentArtifact[] = [];

  for (const [checkId, checkResult] of Object.entries(checkResults ?? {})) {
    if (!checkResult || typeof checkResult !== 'object') continue;
    const cr = checkResult as Record<string, unknown>;
    if (cr.status === 'skipped') continue;

    const parts: AgentPart[] = [];

    if (typeof cr.output === 'string') {
      parts.push({ text: cr.output, media_type: 'text/markdown' });
    } else if (typeof cr.output === 'object' && cr.output !== null) {
      const output = cr.output as Record<string, unknown>;
      if ('text' in output && typeof output.text === 'string') {
        parts.push({ text: output.text, media_type: 'text/markdown' });
      }
      parts.push({ data: cr.output, media_type: 'application/json' });
    }

    if (Array.isArray(cr.issues) && cr.issues.length > 0) {
      parts.push({ data: cr.issues, media_type: 'application/json' });
    }

    if (parts.length > 0) {
      artifacts.push({
        artifact_id: crypto.randomUUID(),
        name: checkId,
        description: `Output from check: ${checkId}`,
        parts,
      });
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// A2A Frontend
// ---------------------------------------------------------------------------

export class A2AFrontend implements ActiveFrontend {
  readonly name = 'a2a';

  private server: http.Server | https.Server | null = null;
  private taskStore: TaskStore;
  private agentCard: AgentCard | null = null;
  private config: AgentProtocolConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _ctx: FrontendContext | null = null;
  private streamManager = new TaskStreamManager();
  private pushManager = new PushNotificationManager();
  private _engine: any = null; // StateMachineExecutionEngine
  private _visorConfig: VisorConfig | null = null;
  private taskQueue: TaskQueue | null = null;

  private _boundPort = 0;

  constructor(config: AgentProtocolConfig, taskStore?: TaskStore) {
    this.config = config;
    this.taskStore = taskStore ?? new SqliteTaskStore();
  }

  /** The actual port the server is listening on (useful when config.port is 0). */
  get boundPort(): number {
    return this._boundPort;
  }

  /** Set the execution engine for running workflows. */
  setEngine(engine: any): void {
    this._engine = engine;
  }

  /** Set the full Visor config (needed for check definitions). */
  setVisorConfig(config: VisorConfig): void {
    this._visorConfig = config;
  }

  async start(ctx: FrontendContext): Promise<void> {
    this._ctx = ctx;

    // 1. Initialize task store
    await this.taskStore.initialize();

    // 2. Initialize push notification manager with shared db
    const db = (this.taskStore as SqliteTaskStore).getDatabase?.();
    if (db) {
      this.pushManager.initialize(db as any);
    }

    // 3. Pick up engine/visorConfig from FrontendContext (if provided)
    if (ctx.engine) this._engine = ctx.engine;
    if (ctx.visorConfig) this._visorConfig = ctx.visorConfig as VisorConfig;

    // 4. Load and validate agent card (file path → inline → none)
    if (this.config.agent_card) {
      const cardPath = this.config.agent_card;
      const raw = fs.readFileSync(cardPath, 'utf8');
      this.agentCard = JSON.parse(raw) as AgentCard;
    } else if (this.config.agent_card_inline) {
      this.agentCard = { ...this.config.agent_card_inline };
    }

    // URL patching deferred until after server.listen() so _boundPort is known

    // 5. Create HTTP server
    const handler = this.handleRequest.bind(this);
    if (this.config.tls) {
      const tlsOptions = {
        cert: fs.readFileSync(this.config.tls.cert),
        key: fs.readFileSync(this.config.tls.key),
      };
      this.server = https.createServer(tlsOptions, handler);
    } else {
      this.server = http.createServer(handler);
    }

    // 6. Subscribe to EventBus
    ctx.eventBus.on('CheckCompleted', (event: any) => {
      const envelope = event?.payload ? event : { payload: event };
      const taskId = envelope.metadata?.agentTaskId as string | undefined;
      if (!taskId) return;
      // Store intermediate artifacts and emit to streams
      try {
        const artifact = this.checkResultToArtifact(envelope.payload);
        if (artifact) {
          this.taskStore.addArtifact(taskId, artifact);
          const task = this.taskStore.getTask(taskId);
          if (task) {
            this.emitArtifactEvent(taskId, task.context_id, artifact, false, false);
          }
        }
      } catch {
        // ignore
      }
    });

    ctx.eventBus.on('CheckErrored', (event: any) => {
      const envelope = event?.payload ? event : { payload: event };
      const taskId = envelope.metadata?.agentTaskId as string | undefined;
      if (!taskId) return;
      logger.warn(`Agent task ${taskId}: check errored`);
    });

    ctx.eventBus.on('HumanInputRequested', (event: any) => {
      const envelope = event?.payload ? event : { payload: event };
      const taskId = envelope.metadata?.agentTaskId as string | undefined;
      if (!taskId) return;
      try {
        const statusMessage: AgentMessage = {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [{ text: envelope.payload?.prompt ?? 'Agent requires input' }],
        };
        this.taskStore.updateTaskState(taskId, 'input_required', statusMessage);
        const task = this.taskStore.getTask(taskId);
        if (task) {
          this.emitStatusEvent(taskId, task.context_id, task.status);
        }
      } catch {
        // ignore
      }
    });

    // 7. Start cleanup sweep
    this.startCleanupSweep();

    // 8. Start TaskQueue if engine is available (for non-blocking task execution)
    if (this._engine && this._visorConfig) {
      const executor = this.createTaskExecutor();
      const queueCfg = this.config.queue;
      this.taskQueue = new TaskQueue(
        this.taskStore,
        executor,
        null,
        queueCfg
          ? {
              pollInterval: queueCfg.poll_interval,
              maxConcurrent: queueCfg.max_concurrent,
              staleClaimTimeout: queueCfg.stale_claim_timeout,
            }
          : undefined
      );
      this.taskQueue.start();
      logger.info('[A2A] TaskQueue started for async task execution');
    }

    // 9. Listen
    const port = this.config.port ?? 9000;
    const host = this.config.host ?? '0.0.0.0';
    await new Promise<void>(resolve => {
      this.server!.listen(port, host, () => {
        const addr = this.server!.address();
        this._boundPort = typeof addr === 'object' && addr ? addr.port : port;
        logger.info(`A2A server listening on ${host}:${this._boundPort}`);
        resolve();
      });
    });

    // Patch agent card URL now that the bound port is known
    if (this.agentCard) {
      const publicUrl = this.config.public_url ?? `http://${host}:${this._boundPort}`;
      if (!this.agentCard.supported_interfaces?.length) {
        this.agentCard.supported_interfaces = [{ url: publicUrl, protocol_binding: 'a2a/v1' }];
      } else {
        this.agentCard.supported_interfaces[0].url = publicUrl;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopCleanupSweep();
    if (this.taskQueue) {
      this.taskQueue.stop();
      this.taskQueue = null;
    }
    this.streamManager.shutdown();
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => (err ? reject(err) : resolve()));
      });
      this.server = null;
    }
    await this.taskStore.shutdown();
  }

  // -------------------------------------------------------------------------
  // HTTP request dispatcher
  // -------------------------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Agent Card: public, no auth
    if (url.pathname === '/.well-known/agent-card.json' && req.method === 'GET') {
      return this.serveAgentCard(res);
    }

    // All other routes: require auth
    if (!validateAuth(req, this.config)) {
      return sendError(res, 401, 'Unauthorized');
    }

    try {
      // SendMessage
      if (url.pathname === '/message:send' && req.method === 'POST') {
        return await this.handleSendMessage(req, res);
      }
      // SendStreamingMessage
      if (url.pathname === '/message:stream' && req.method === 'POST') {
        if (!this.agentCard?.capabilities?.streaming) {
          return sendError(res, 400, 'Streaming not supported', -32002);
        }
        return await this.handleSendStreamingMessage(req, res);
      }

      // GetTask
      const taskMatch = url.pathname.match(/^\/tasks\/([^/:]+)$/);
      if (taskMatch && req.method === 'GET') {
        return this.handleGetTask(taskMatch[1], res);
      }

      // ListTasks
      if (url.pathname === '/tasks' && req.method === 'GET') {
        return this.handleListTasks(url.searchParams, res);
      }

      // CancelTask
      const cancelMatch = url.pathname.match(/^\/tasks\/([^/:]+):cancel$/);
      if (cancelMatch && req.method === 'POST') {
        return this.handleCancelTask(cancelMatch[1], res);
      }

      // SubscribeToTask
      const subscribeMatch = url.pathname.match(/^\/tasks\/([^/:]+):subscribe$/);
      if (subscribeMatch && req.method === 'GET') {
        if (!this.agentCard?.capabilities?.streaming) {
          return sendError(res, 400, 'Streaming not supported', -32002);
        }
        return this.handleSubscribeToTask(subscribeMatch[1], res);
      }

      // Push notification config routes
      const pushListMatch = url.pathname.match(/^\/tasks\/([^/:]+)\/pushNotificationConfigs$/);
      if (pushListMatch) {
        if (!this.agentCard?.capabilities?.push_notifications) {
          return sendError(res, 400, 'Push notifications not supported', -32002);
        }
        if (req.method === 'POST') {
          return await this.handleCreatePushConfig(pushListMatch[1], req, res);
        }
        if (req.method === 'GET') {
          return this.handleListPushConfigs(pushListMatch[1], res);
        }
      }

      const pushDetailMatch = url.pathname.match(
        /^\/tasks\/([^/:]+)\/pushNotificationConfigs\/([^/:]+)$/
      );
      if (pushDetailMatch) {
        if (!this.agentCard?.capabilities?.push_notifications) {
          return sendError(res, 400, 'Push notifications not supported', -32002);
        }
        if (req.method === 'GET') {
          return this.handleGetPushConfig(pushDetailMatch[1], pushDetailMatch[2], res);
        }
        if (req.method === 'DELETE') {
          return this.handleDeletePushConfig(pushDetailMatch[1], pushDetailMatch[2], res);
        }
      }

      sendError(res, 404, 'MethodNotFound', -32601);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return sendError(res, 404, err.message, -32001);
      }
      if (err instanceof InvalidStateTransitionError) {
        return sendError(res, 409, err.message, -32003);
      }
      if (err instanceof InvalidRequestError) {
        return sendError(res, 400, err.message, -32600);
      }
      if (err instanceof ContextMismatchError) {
        return sendError(res, 400, err.message, -32600);
      }
      logger.error(`A2A request error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, 'Internal error');
    }
  }

  // -------------------------------------------------------------------------
  // Endpoint handlers
  // -------------------------------------------------------------------------

  private serveAgentCard(res: http.ServerResponse): void {
    if (!this.agentCard) {
      return sendError(res, 404, 'Agent Card not configured');
    }
    sendJson(res, 200, this.agentCard);
  }

  private async handleSendMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = (await readJsonBody(req)) as AgentSendMessageRequest;

    if (!body.message?.parts?.length) {
      throw new InvalidRequestError('Message must contain at least one part');
    }

    // Check if follow-up to existing task
    const existingTaskId = body.message.task_id;
    if (existingTaskId) {
      const response = await this.handleFollowUpMessage(existingTaskId, body);
      return sendJson(res, 200, response);
    }

    // Resolve context
    const contextId = body.message.context_id ?? crypto.randomUUID();

    // Determine workflow
    const workflowId = resolveWorkflow(body, this.config);

    // Create task
    const task = this.taskStore.createTask({
      contextId,
      requestMessage: body.message,
      requestConfig: body.configuration,
      requestMetadata: body.metadata,
      workflowId,
    });

    // Append user message to history
    this.taskStore.appendHistory(task.id, body.message);

    const blocking = body.configuration?.blocking ?? false;

    if (blocking) {
      // Execute synchronously
      await this.executeTaskDirectly(task, body.message);
      let finalTask = this.taskStore.getTask(task.id)!;

      // Respect history_length
      const historyLength = body.configuration?.history_length;
      if (historyLength !== undefined) {
        finalTask = {
          ...finalTask,
          history: finalTask.history.slice(-historyLength),
        };
      }

      // Filter accepted_output_modes
      if (body.configuration?.accepted_output_modes?.length) {
        finalTask = this.filterOutputModes(finalTask, body.configuration.accepted_output_modes);
      }

      return sendJson(res, 200, { task: finalTask });
    }

    // Non-blocking: return task immediately (queue picks it up in Milestone 4)
    return sendJson(res, 200, { task: this.taskStore.getTask(task.id)! });
  }

  private async handleFollowUpMessage(
    taskId: string,
    req: AgentSendMessageRequest
  ): Promise<AgentSendMessageResponse> {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    if (task.status.state !== 'input_required' && task.status.state !== 'auth_required') {
      throw new InvalidStateTransitionError(
        task.status.state,
        'working',
        'Task is not awaiting input'
      );
    }

    // Validate context match
    if (req.message.context_id && req.message.context_id !== task.context_id) {
      throw new ContextMismatchError(req.message.context_id, task.context_id);
    }

    // Append follow-up
    this.taskStore.appendHistory(taskId, req.message);
    this.taskStore.updateTaskState(taskId, 'working');

    // For now, we mark as working. Full resume is in Milestone 4.
    // In blocking mode, we'd wait for completion here.
    return { task: this.taskStore.getTask(taskId)! };
  }

  private handleGetTask(taskId: string, res: http.ServerResponse): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    sendJson(res, 200, task);
  }

  private handleListTasks(params: URLSearchParams, res: http.ServerResponse): void {
    const contextId = params.get('context_id') ?? undefined;
    const stateParam = params.get('state');
    const state = stateParam ? (stateParam.split(',') as TaskState[]) : undefined;
    const limit = params.has('limit') ? parseInt(params.get('limit')!, 10) : undefined;
    const offset = params.has('offset') ? parseInt(params.get('offset')!, 10) : undefined;

    const result = this.taskStore.listTasks({ contextId, state, limit, offset });
    sendJson(res, 200, result);
  }

  private handleCancelTask(taskId: string, res: http.ServerResponse): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    this.taskStore.updateTaskState(taskId, 'canceled');
    const updated = this.taskStore.getTask(taskId)!;
    sendJson(res, 200, updated);
  }

  // -------------------------------------------------------------------------
  // Streaming handlers
  // -------------------------------------------------------------------------

  private async handleSendStreamingMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = (await readJsonBody(req)) as AgentSendMessageRequest;

    if (!body.message?.parts?.length) {
      throw new InvalidRequestError('Message must contain at least one part');
    }

    // Create task (same as handleSendMessage)
    const contextId = body.message.context_id ?? crypto.randomUUID();
    const workflowId = resolveWorkflow(body, this.config);

    const task = this.taskStore.createTask({
      contextId,
      requestMessage: body.message,
      requestConfig: body.configuration,
      requestMetadata: body.metadata,
      workflowId,
    });

    this.taskStore.appendHistory(task.id, body.message);

    // Subscribe response to SSE
    this.streamManager.subscribe(task.id, res);

    // Emit initial status
    this.emitStatusEvent(task.id, contextId, task.status);

    // Execute the task (status events will be emitted as it progresses)
    this.executeTaskDirectly(task, body.message)
      .then(() => {
        const finalTask = this.taskStore.getTask(task.id);
        if (finalTask) {
          this.emitStatusEvent(task.id, contextId, finalTask.status);
        }
      })
      .catch(() => {
        // Error already handled in executeTaskDirectly
      });
  }

  private handleSubscribeToTask(taskId: string, res: http.ServerResponse): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // If already terminal, send the final event and close
    if (isTerminalState(task.status.state)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const event: TaskStatusUpdateEvent = {
        type: 'TaskStatusUpdateEvent',
        task_id: taskId,
        context_id: task.context_id,
        status: task.status,
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }

    // Subscribe for future events
    this.streamManager.subscribe(taskId, res);

    // Send current status
    this.emitStatusEvent(taskId, task.context_id, task.status);
  }

  // -------------------------------------------------------------------------
  // Push notification handlers
  // -------------------------------------------------------------------------

  private async handleCreatePushConfig(
    taskId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const body = (await readJsonBody(req)) as Partial<AgentPushNotificationConfig>;
    if (!body.url) {
      throw new InvalidRequestError('Push notification config must include url');
    }

    const config = this.pushManager.create({
      task_id: taskId,
      url: body.url,
      token: body.token,
      auth_scheme: body.auth_scheme,
      auth_credentials: body.auth_credentials,
    });

    sendJson(res, 200, config);
  }

  private handleListPushConfigs(taskId: string, res: http.ServerResponse): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const configs = this.pushManager.list(taskId);
    sendJson(res, 200, { configs });
  }

  private handleGetPushConfig(taskId: string, configId: string, res: http.ServerResponse): void {
    const config = this.pushManager.get(taskId, configId);
    if (!config) {
      return sendError(res, 404, 'Push notification config not found', -32001);
    }
    sendJson(res, 200, config);
  }

  private handleDeletePushConfig(taskId: string, configId: string, res: http.ServerResponse): void {
    const deleted = this.pushManager.delete(taskId, configId);
    if (!deleted) {
      return sendError(res, 404, 'Push notification config not found', -32001);
    }
    sendJson(res, 200, { deleted: true });
  }

  // -------------------------------------------------------------------------
  // Event emission helpers
  // -------------------------------------------------------------------------

  /** Emit a task status update to SSE subscribers and push notification targets. */
  emitStatusEvent(
    taskId: string,
    contextId: string,
    status: { state: TaskState; message?: AgentMessage; timestamp: string }
  ): void {
    const event: TaskStatusUpdateEvent = {
      type: 'TaskStatusUpdateEvent',
      task_id: taskId,
      context_id: contextId,
      status,
    };
    this.streamManager.emit(taskId, event);
    this.pushManager.notifyAll(taskId, event).catch(err => {
      logger.error(`Push notification error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Emit an artifact update to SSE subscribers and push notification targets. */
  emitArtifactEvent(
    taskId: string,
    contextId: string,
    artifact: AgentArtifact,
    append: boolean,
    lastChunk: boolean
  ): void {
    const event: TaskArtifactUpdateEvent = {
      type: 'TaskArtifactUpdateEvent',
      task_id: taskId,
      context_id: contextId,
      artifact,
      append,
      last_chunk: lastChunk,
    };
    this.streamManager.emit(taskId, event);
    this.pushManager.notifyAll(taskId, event).catch(err => {
      logger.error(`Push notification error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a task, either via the engine (if available) or with a stub response (for tests).
   */
  private async executeTaskDirectly(task: AgentTask, message: AgentMessage): Promise<void> {
    try {
      this.taskStore.updateTaskState(task.id, 'working');
      this.emitStatusEvent(task.id, task.context_id, {
        state: 'working',
        timestamp: new Date().toISOString(),
      });

      if (this._engine && this._visorConfig) {
        // Engine-backed execution
        await this.executeTaskViaEngine(task, message);
      } else {
        // Stub execution (no engine available — e.g., in tests)
        const agentResponse: AgentMessage = {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [{ text: `Task ${task.id} received and processed.`, media_type: 'text/markdown' }],
        };
        this.taskStore.appendHistory(task.id, agentResponse);
        this.taskStore.updateTaskState(task.id, 'completed', agentResponse);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`[A2A] Task ${task.id} execution failed: ${errorMsg}`);
      try {
        const failMessage: AgentMessage = {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [{ text: errorMsg }],
        };
        this.taskStore.updateTaskState(task.id, 'failed', failMessage);
        this.emitStatusEvent(task.id, task.context_id, {
          state: 'failed',
          message: failMessage,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // ignore double-failure
      }
    }
  }

  /**
   * Execute a task through the Visor engine.
   * Creates a fresh engine execution per task and converts results to artifacts.
   */
  private async executeTaskViaEngine(task: AgentTask, _message: AgentMessage): Promise<void> {
    const workflowId = (task.metadata as any)?.workflowId ?? this.config.default_workflow;

    // Determine which checks to run
    const checks = workflowId ? [workflowId] : ['all'];

    // Build execution options
    const execOptions: CheckExecutionOptions = {
      checks,
      config: this._visorConfig!,
      timeout: 300_000,
    };

    // Execute via the engine
    const result = await this._engine.executeChecks(execOptions);

    // Use the grouped results if available
    const groupedResults =
      (result as any)?.executionStatistics?.groupedResults ?? (result as any)?.results ?? {};

    // Build artifacts from the analysis result
    const artifacts: AgentArtifact[] = [];

    // Add a summary artifact from reviewSummary
    if (result?.reviewSummary) {
      const summaryParts: AgentPart[] = [];
      if (result.reviewSummary.issues?.length) {
        const issueText = result.reviewSummary.issues
          .map((i: any) => `- **${i.severity}**: ${i.message} (${i.file}:${i.line})`)
          .join('\n');
        summaryParts.push({ text: `## Issues Found\n\n${issueText}`, media_type: 'text/markdown' });
        summaryParts.push({ data: result.reviewSummary.issues, media_type: 'application/json' });
      }
      if (summaryParts.length > 0) {
        artifacts.push({
          artifact_id: crypto.randomUUID(),
          name: 'review-summary',
          description: 'Review summary with issues found',
          parts: summaryParts,
        });
      }
    }

    // Add per-check artifacts from grouped results
    if (groupedResults && typeof groupedResults === 'object') {
      for (const [groupName, groupChecks] of Object.entries(groupedResults)) {
        if (!Array.isArray(groupChecks)) continue;
        for (const cr of groupChecks as any[]) {
          const parts: AgentPart[] = [];
          if (typeof cr.content === 'string' && cr.content.trim()) {
            parts.push({ text: cr.content, media_type: 'text/markdown' });
          }
          if (cr.output != null) {
            parts.push({ data: cr.output, media_type: 'application/json' });
          }
          if (parts.length > 0) {
            artifacts.push({
              artifact_id: crypto.randomUUID(),
              name: cr.checkName ?? groupName,
              description: `Output from check: ${cr.checkName ?? groupName}`,
              parts,
            });
          }
        }
      }
    }

    // If no structured artifacts, create a simple text result
    if (artifacts.length === 0) {
      artifacts.push({
        artifact_id: crypto.randomUUID(),
        name: 'result',
        description: 'Execution result',
        parts: [
          {
            text: `Executed ${checks.join(', ')} checks. ${result?.checksExecuted?.length ?? 0} checks ran.`,
            media_type: 'text/markdown',
          },
        ],
      });
    }

    // Store artifacts and emit events
    for (let i = 0; i < artifacts.length; i++) {
      this.taskStore.addArtifact(task.id, artifacts[i]);
      this.emitArtifactEvent(
        task.id,
        task.context_id,
        artifacts[i],
        false,
        i === artifacts.length - 1
      );
    }

    // Mark completed
    const agentResponse: AgentMessage = {
      message_id: crypto.randomUUID(),
      role: 'agent',
      parts: [
        {
          text: `Completed ${artifacts.length} artifact(s) from ${result?.checksExecuted?.length ?? 0} check(s).`,
          media_type: 'text/markdown',
        },
      ],
      metadata: {
        executionTime: result?.executionTime,
        checksExecuted: result?.checksExecuted,
      },
    };
    this.taskStore.appendHistory(task.id, agentResponse);
    this.taskStore.updateTaskState(task.id, 'completed', agentResponse);
    this.emitStatusEvent(task.id, task.context_id, {
      state: 'completed',
      message: agentResponse,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Create a TaskExecutor callback for the TaskQueue.
   * The queue handles state transitions (submitted → working), so the executor
   * focuses on running the engine and converting results.
   */
  private createTaskExecutor(): TaskExecutor {
    return async (
      task: AgentTask
    ): Promise<{ success: boolean; checkResults?: Record<string, unknown>; error?: string }> => {
      try {
        // Get the user message from history
        const userMessage = task.history.find(m => m.role === 'user');
        if (!userMessage) return { success: false, error: 'No user message found' };

        await this.executeTaskViaEngine(task, userMessage);
        return { success: true };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        return { success: false, error: errorMsg };
      }
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private checkResultToArtifact(payload: unknown): AgentArtifact | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    const parts: AgentPart[] = [];
    if (typeof p.output === 'string') {
      parts.push({ text: p.output, media_type: 'text/markdown' });
    } else if (typeof p.output === 'object' && p.output !== null) {
      parts.push({ data: p.output, media_type: 'application/json' });
    }

    if (parts.length === 0) return null;

    return {
      artifact_id: crypto.randomUUID(),
      name: (p.checkId as string) ?? 'check-result',
      parts,
    };
  }

  private filterOutputModes(task: AgentTask, acceptedModes: string[]): AgentTask {
    const filteredArtifacts = task.artifacts
      .map(a => ({
        ...a,
        parts: a.parts.filter(p =>
          acceptedModes.some(mode => (p.media_type ?? 'text/plain').startsWith(mode))
        ),
      }))
      .filter(a => a.parts.length > 0);

    return { ...task, artifacts: filteredArtifacts };
  }

  private startCleanupSweep(): void {
    // Run every hour
    this.cleanupTimer = setInterval(() => {
      try {
        const deletedTaskIds = this.taskStore.deleteExpiredTasks();
        if (deletedTaskIds.length > 0) {
          // Cascade-delete push notification configs for removed tasks
          for (const taskId of deletedTaskIds) {
            this.pushManager.deleteForTask(taskId);
          }
          logger.info(`[A2A] Cleaned up ${deletedTaskIds.length} expired tasks`);
        }
      } catch (err) {
        logger.error(
          `[A2A] Cleanup sweep error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, 3600_000);
  }

  private stopCleanupSweep(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public accessors (for testing)
  // -------------------------------------------------------------------------

  getTaskStore(): TaskStore {
    return this.taskStore;
  }

  getAgentCard(): AgentCard | null {
    return this.agentCard;
  }
}
