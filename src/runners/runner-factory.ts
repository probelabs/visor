import type { Runner } from './runner';
import type { VisorConfig } from '../types/config';
import type { CliOptions } from '../types/cli';
import type { StateMachineExecutionEngine } from '../state-machine-execution-engine';

/**
 * Create a Runner instance by name.
 *
 * Each case encapsulates the config-extraction logic previously duplicated
 * in cli-main.ts (reading config sub-objects, env vars, defaults).
 */
export async function createRunner(
  name: string,
  engine: StateMachineExecutionEngine,
  config: VisorConfig,
  options: CliOptions
): Promise<Runner> {
  switch (name) {
    case 'slack': {
      const { SlackSocketRunner } = await import('../slack/socket-runner');
      const slackAny: any = (config as any).slack || {};
      return new SlackSocketRunner(engine, config, {
        appToken: slackAny.app_token || process.env.SLACK_APP_TOKEN,
        endpoint: slackAny.endpoint || '/bots/slack/support',
        mentions: slackAny.mentions || 'direct',
        threads: slackAny.threads || 'any',
        channel_allowlist: Array.isArray(slackAny.channel_allowlist)
          ? slackAny.channel_allowlist
          : [],
      });
    }

    case 'telegram': {
      const { TelegramPollingRunner } = await import('../telegram/polling-runner');
      const telegramAny: any = (config as any).telegram || {};
      return new TelegramPollingRunner(engine, config, {
        botToken: telegramAny.bot_token || process.env.TELEGRAM_BOT_TOKEN,
        pollingTimeout: telegramAny.polling_timeout || 30,
        chatAllowlist: telegramAny.chat_allowlist,
        requireMention: telegramAny.require_mention ?? true,
        workflow: telegramAny.workflow,
      });
    }

    case 'email': {
      const { EmailPollingRunner } = await import('../email/polling-runner');
      const emailAny: any = (config as any).email || {};
      return new EmailPollingRunner(engine, config, {
        receive: emailAny.receive || {},
        send: emailAny.send || {},
        allowlist: emailAny.allowlist,
        workflow: emailAny.workflow,
      });
    }

    case 'whatsapp': {
      const { WhatsAppWebhookRunner } = await import('../whatsapp/webhook-runner');
      const waAny: any = (config as any).whatsapp || {};
      return new WhatsAppWebhookRunner(engine, config, {
        accessToken: waAny.access_token || process.env.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: waAny.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
        appSecret: waAny.app_secret || process.env.WHATSAPP_APP_SECRET,
        verifyToken: waAny.verify_token || process.env.WHATSAPP_VERIFY_TOKEN,
        apiVersion: waAny.api_version || 'v21.0',
        port: waAny.port || parseInt(process.env.WHATSAPP_WEBHOOK_PORT || '8443'),
        host: waAny.host || '0.0.0.0',
        phoneAllowlist: waAny.phone_allowlist,
        workflow: waAny.workflow,
      });
    }

    case 'teams': {
      const { TeamsWebhookRunner } = await import('../teams/webhook-runner');
      const teamsAny: any = (config as any).teams || {};
      return new TeamsWebhookRunner(engine, config, {
        appId: teamsAny.app_id || process.env.TEAMS_APP_ID,
        appPassword: teamsAny.app_password || process.env.TEAMS_APP_PASSWORD,
        tenantId: teamsAny.tenant_id || process.env.TEAMS_TENANT_ID,
        port: teamsAny.port || parseInt(process.env.TEAMS_WEBHOOK_PORT || '3978'),
        host: teamsAny.host || '0.0.0.0',
        userAllowlist: teamsAny.user_allowlist,
        workflow: teamsAny.workflow,
      });
    }

    case 'a2a': {
      const { A2AFrontend } = await import('../agent-protocol/a2a-frontend');
      const { EventBus } = await import('../event-bus/event-bus');
      const { logger } = await import('../logger');
      const crypto = await import('crypto');

      const agentConfig = config.agent_protocol;
      if (!agentConfig) {
        throw new Error('agent_protocol configuration is required for --a2a mode');
      }

      const frontend = new A2AFrontend(agentConfig);
      frontend.setEngine(engine);
      frontend.setVisorConfig(config);

      // Return a thin adapter that bridges A2AFrontend → Runner interface
      return {
        name: 'a2a',
        async start() {
          const eventBus = new EventBus();
          const ctx = {
            eventBus,
            logger,
            config,
            run: { runId: crypto.randomUUID() },
            engine,
            visorConfig: config,
          };
          await frontend.start(ctx);
          const port = agentConfig.port ?? 9000;
          const host = agentConfig.host ?? '0.0.0.0';
          console.log(`A2A server running on ${host}:${port}`);
        },
        async stop() {
          await frontend.stop();
        },
        async stopListening() {
          await frontend.stopListening();
        },
        async drain(timeoutMs?: number) {
          await frontend.drain(timeoutMs);
        },
        updateConfig(cfg: VisorConfig) {
          frontend.setVisorConfig(cfg);
        },
        setTaskStore(store: any, _configPath?: string) {
          // A2AFrontend receives task store via constructor; update if possible
          (frontend as any)._taskStore = store;
        },
      };
    }

    case 'mcp': {
      const { McpServerRunner } = await import('./mcp-server-runner');
      const mcpAny: any = (config as any).mcp_server || {};
      return new McpServerRunner(engine, config, {
        port:
          options.mcpPort ||
          mcpAny.port ||
          (process.env.VISOR_MCP_PORT ? parseInt(process.env.VISOR_MCP_PORT) : 8080),
        host: mcpAny.host || process.env.VISOR_MCP_HOST || '0.0.0.0',
        authToken: options.mcpAuthToken || mcpAny.auth_token || process.env.VISOR_MCP_AUTH_TOKEN,
        authTokenEnv: mcpAny.auth_token_env,
        tlsCert: mcpAny.tls_cert || process.env.VISOR_MCP_TLS_CERT,
        tlsKey: mcpAny.tls_key || process.env.VISOR_MCP_TLS_KEY,
        toolName: mcpAny.tool_name || process.env.VISOR_MCP_TOOL_NAME,
        toolDescription: mcpAny.tool_description || process.env.VISOR_MCP_TOOL_DESCRIPTION,
        asyncMode: options.mcpAsync || mcpAny.async_mode || process.env.VISOR_MCP_ASYNC === 'true',
        longPollTimeout:
          mcpAny.long_poll_timeout ||
          (process.env.VISOR_MCP_POLL_TIMEOUT
            ? parseInt(process.env.VISOR_MCP_POLL_TIMEOUT)
            : undefined),
      });
    }

    default:
      throw new Error(`Unknown runner type: "${name}"`);
  }
}
