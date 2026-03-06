/**
 * A2A Check Provider — calls external A2A-compatible agents from Visor checks.
 *
 * Configuration:
 *   type: a2a
 *   agent_card: "https://agent.example.com/.well-known/agent-card.json"
 *   # OR agent_url: "http://localhost:9001"
 *   auth:
 *     scheme: "bearer"
 *     token_env: "AGENT_TOKEN"
 *   message: |
 *     Review this PR for compliance.
 *     Repo: {{ pr.repo }}
 *   blocking: true
 *   timeout: 300000
 *   poll_interval: 2000
 *   max_turns: 3
 *   on_input_required: |
 *     Additional context: {{ pr.description }}
 */

import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { createExtendedLiquid } from '../liquid-extensions';
import { buildProviderTemplateContext } from '../utils/template-context';
import { logger } from '../logger';
import type {
  AgentCard,
  AgentMessage,
  AgentPart,
  AgentTask,
  AgentCheckConfig,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
} from '../agent-protocol/types';
import {
  AgentCardFetchError,
  InvalidAgentCardError,
  A2ATimeoutError,
  A2ARequestError,
  A2AMaxTurnsExceededError,
  A2AInputRequiredError,
  A2AAuthRequiredError,
  A2ATaskFailedError,
  A2ATaskRejectedError,
} from '../agent-protocol/types';
import { isTerminalState } from '../agent-protocol/state-transitions';

// ---------------------------------------------------------------------------
// Agent Card Cache
// ---------------------------------------------------------------------------

interface CachedCard {
  card: AgentCard;
  fetchedAt: number;
}

export class AgentCardCache {
  private cache = new Map<string, CachedCard>();
  private ttlMs: number;

  constructor(ttlMs = 300_000) {
    this.ttlMs = ttlMs;
  }

  async fetch(url: string): Promise<AgentCard> {
    const entry = this.cache.get(url);
    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) {
      return entry.card;
    }

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new AgentCardFetchError(url, resp.status, resp.statusText);
    }

    let card: AgentCard;
    try {
      card = (await resp.json()) as AgentCard;
    } catch {
      throw new InvalidAgentCardError(url, 'Response is not valid JSON');
    }

    if (!card.name || !card.supported_interfaces?.length) {
      throw new InvalidAgentCardError(url, 'Missing required fields (name, supported_interfaces)');
    }

    this.cache.set(url, { card, fetchedAt: Date.now() });
    return card;
  }

  invalidate(url: string): void {
    this.cache.delete(url);
  }

  clear(): void {
    this.cache.clear();
  }
}

// Module-level cache shared across instances
const cardCache = new AgentCardCache();

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class A2ACheckProvider extends CheckProvider {
  private liquid = createExtendedLiquid({ strictVariables: false });

  getName(): string {
    return 'a2a';
  }

  getDescription(): string {
    return 'Call external A2A-compatible agents and collect their responses';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') return false;
    const c = config as Record<string, unknown>;
    if (c.type !== 'a2a') return false;
    // Exactly one of agent_card / agent_url
    if ((!c.agent_card && !c.agent_url) || (c.agent_card && c.agent_url)) return false;
    if (!c.message || typeof c.message !== 'string') return false;
    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    _context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const cfg = config as unknown as AgentCheckConfig;
    const timeout = cfg.timeout ?? 300_000;
    const pollInterval = cfg.poll_interval ?? 2_000;
    const maxTurns = cfg.max_turns ?? 1;
    const blocking = cfg.blocking !== false;

    try {
      // 1. Resolve agent endpoint
      let agentUrl: string;
      if (cfg.agent_card) {
        const card = await cardCache.fetch(cfg.agent_card);
        agentUrl = card.supported_interfaces![0].url;
      } else {
        agentUrl = cfg.agent_url!;
      }
      agentUrl = agentUrl.replace(/\/+$/, '');

      // 2. Build auth headers
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.auth) {
        const token = cfg.auth.token_env ? process.env[cfg.auth.token_env] : undefined;
        if (cfg.auth.scheme === 'bearer' && token) {
          headers['Authorization'] = `Bearer ${token}`;
        } else if (cfg.auth.scheme === 'api_key' && token) {
          headers[cfg.auth.header_name ?? 'X-API-Key'] = token;
        }
      }

      // 3. Build message from Liquid templates
      const templateCtx = buildProviderTemplateContext(
        prInfo,
        dependencyResults,
        undefined,
        undefined,
        undefined,
        {
          attachMemoryReadHelpers: false,
        }
      );
      const renderedMessage = await this.liquid.parseAndRender(cfg.message, templateCtx);

      const parts: AgentPart[] = [{ text: renderedMessage }];

      if (cfg.data) {
        for (const [, valueTemplate] of Object.entries(cfg.data)) {
          const rendered = await this.liquid.parseAndRender(valueTemplate, templateCtx);
          let dataValue: unknown;
          try {
            dataValue = JSON.parse(rendered);
          } catch {
            dataValue = rendered;
          }
          parts.push({ data: dataValue, media_type: 'application/json' });
        }
      }

      if (cfg.files) {
        for (const f of cfg.files) {
          parts.push({ url: f.url, media_type: f.media_type, filename: f.filename });
        }
      }

      const message: AgentMessage = {
        message_id: `visor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        parts,
      };

      // 4. Send
      const sendUrl = `${agentUrl}/message:send`;
      let response = await this.sendMessage(
        sendUrl,
        { message, configuration: { blocking } },
        headers
      );

      // 5. Direct message response
      if (response.message) {
        return this.messageToReviewSummary(response.message);
      }

      let task = response.task!;

      // 6. Poll loop
      const deadline = Date.now() + timeout;
      let turns = 0;

      while (!isTerminalState(task.status.state)) {
        if (Date.now() > deadline) throw new A2ATimeoutError(task.id, timeout);

        if (task.status.state === 'input_required') {
          turns++;
          if (turns > maxTurns) throw new A2AMaxTurnsExceededError(task.id, maxTurns);

          if (cfg.on_input_required) {
            const ctx = { ...templateCtx, task };
            const replyText = await this.liquid.parseAndRender(cfg.on_input_required, ctx);
            const followUp: AgentSendMessageRequest = {
              message: {
                message_id: `visor-reply-${Date.now()}`,
                role: 'user',
                task_id: task.id,
                context_id: task.context_id,
                parts: [{ text: replyText }],
              },
              configuration: { blocking },
            };
            response = await this.sendMessage(sendUrl, followUp, headers);
            if (response.task) {
              task = response.task;
              continue;
            }
            if (response.message) {
              return this.messageToReviewSummary(response.message);
            }
          } else {
            const prompt =
              task.status.message?.parts
                ?.map(p => p.text)
                .filter(Boolean)
                .join(' ') ?? 'Agent requires input';
            throw new A2AInputRequiredError(task.id, prompt);
          }
        }

        if (task.status.state === 'auth_required') throw new A2AAuthRequiredError(task.id);

        await new Promise(r => setTimeout(r, pollInterval));
        task = await this.getTask(agentUrl, task.id, headers);
      }

      // 7. Terminal state
      if (task.status.state === 'failed') {
        const detail =
          task.status.message?.parts
            ?.map(p => p.text)
            .filter(Boolean)
            .join(' ') ?? 'Unknown failure';
        throw new A2ATaskFailedError(task.id, detail);
      }
      if (task.status.state === 'canceled' || task.status.state === 'rejected') {
        throw new A2ATaskRejectedError(task.id, task.status.state);
      }

      return this.taskToReviewSummary(task);
    } catch (err) {
      if (
        err instanceof A2ATimeoutError ||
        err instanceof A2AMaxTurnsExceededError ||
        err instanceof A2AInputRequiredError ||
        err instanceof A2AAuthRequiredError ||
        err instanceof A2ATaskFailedError ||
        err instanceof A2ATaskRejectedError ||
        err instanceof AgentCardFetchError ||
        err instanceof InvalidAgentCardError ||
        err instanceof A2ARequestError
      ) {
        return {
          issues: [
            {
              file: 'a2a',
              line: 0,
              ruleId: 'a2a/error',
              message: err.message,
              severity: 'error',
              category: 'logic',
            },
          ],
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[a2a] Unexpected error: ${msg}`);
      return {
        issues: [
          {
            file: 'a2a',
            line: 0,
            ruleId: 'a2a/error',
            message: `A2A provider error: ${msg}`,
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'agent_card',
      'agent_url',
      'auth',
      'message',
      'data',
      'files',
      'blocking',
      'timeout',
      'poll_interval',
      'max_turns',
      'on_input_required',
      'transform_js',
      'depends_on',
      'on',
      'if',
      'fail_if',
      'group',
    ];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getRequirements(): string[] {
    return [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async sendMessage(
    url: string,
    req: AgentSendMessageRequest,
    headers: Record<string, string>
  ): Promise<AgentSendMessageResponse> {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new A2ARequestError(url, resp.status, body);
    }
    const data = (await resp.json()) as Record<string, unknown>;
    if (data.task) return { task: data.task as AgentTask } as AgentSendMessageResponse;
    if (data.message) return { message: data.message as AgentMessage } as AgentSendMessageResponse;
    // Some agents return task at top level
    if (data.id && data.status)
      return { task: data as unknown as AgentTask } as AgentSendMessageResponse;
    throw new A2ARequestError(url, resp.status, 'Response is neither Task nor Message');
  }

  private async getTask(
    agentUrl: string,
    taskId: string,
    headers: Record<string, string>
  ): Promise<AgentTask> {
    const url = `${agentUrl}/tasks/${taskId}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new A2ARequestError(url, resp.status, await resp.text().catch(() => ''));
    return (await resp.json()) as AgentTask;
  }

  private taskToReviewSummary(task: AgentTask): ReviewSummary {
    const textParts: string[] = [];
    for (const a of task.artifacts ?? []) {
      for (const p of a.parts ?? []) {
        if (p.text) textParts.push(p.text);
      }
    }
    if (task.status.message) {
      for (const p of task.status.message.parts ?? []) {
        if (p.text) textParts.push(p.text);
      }
    }
    return { issues: [] } as ReviewSummary;
  }

  private messageToReviewSummary(_message: AgentMessage): ReviewSummary {
    return { issues: [] } as ReviewSummary;
  }
}
