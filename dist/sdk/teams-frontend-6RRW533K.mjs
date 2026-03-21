import {
  init_task_live_updates,
  isFrontendLiveUpdatesEnabled
} from "./chunk-SRU5TFNY.mjs";
import "./chunk-IY5PQ5EN.mjs";
import "./chunk-6E625R3C.mjs";
import "./chunk-B2OUZAWY.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/teams/markdown.ts
function markdownToTeams(text) {
  if (!text || typeof text !== "string") return "";
  return text;
}
function chunkText(text, limit = 28e3) {
  if (text.length <= limit) return [text];
  const chunks = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    const candidate = current ? current + "\n" + line : line;
    if (candidate.length > limit) {
      if (current) {
        chunks.push(current);
        current = line;
      } else {
        let remaining = line;
        while (remaining.length > limit) {
          chunks.push(remaining.slice(0, limit));
          remaining = remaining.slice(limit);
        }
        current = remaining;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
function formatTeamsText(text) {
  return markdownToTeams(text);
}
var init_markdown = __esm({
  "src/teams/markdown.ts"() {
    "use strict";
  }
});

// src/teams/client.ts
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  MessageFactory
} from "botbuilder";
var TeamsClient;
var init_client = __esm({
  "src/teams/client.ts"() {
    "use strict";
    init_markdown();
    TeamsClient = class {
      appId;
      appPassword;
      tenantId;
      adapter;
      constructor(opts) {
        if (!opts.appId) throw new Error("TeamsClient: appId is required");
        if (!opts.appPassword) throw new Error("TeamsClient: appPassword is required");
        this.appId = opts.appId;
        this.appPassword = opts.appPassword;
        this.tenantId = opts.tenantId;
        const auth = new ConfigurationBotFrameworkAuthentication({
          MicrosoftAppId: this.appId,
          MicrosoftAppPassword: this.appPassword,
          MicrosoftAppTenantId: this.tenantId || ""
        });
        this.adapter = new CloudAdapter(auth);
      }
      /** Get the underlying CloudAdapter (used by webhook runner for processing inbound) */
      getAdapter() {
        return this.adapter;
      }
      /** Get the configured App ID */
      getAppId() {
        return this.appId;
      }
      /**
       * Send a text message using a stored conversation reference.
       * Auto-chunks at 28000 characters.
       */
      async sendMessage(opts) {
        const chunks = chunkText(opts.text, 28e3);
        let lastActivityId;
        for (const chunk of chunks) {
          try {
            await this.adapter.continueConversationAsync(
              this.appId,
              opts.conversationReference,
              async (turnContext) => {
                const activity = MessageFactory.text(chunk);
                if (opts.replyToActivityId) {
                  activity.replyToId = opts.replyToActivityId;
                }
                const response = await turnContext.sendActivity(activity);
                lastActivityId = response?.id;
              }
            );
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            };
          }
        }
        return { ok: true, activityId: lastActivityId };
      }
      /**
       * Update an existing bot message.
       * For safety, only supports single-activity payloads. Oversized content returns msg_too_long.
       */
      async updateMessage(opts) {
        const chunks = chunkText(opts.text, 28e3);
        if (chunks.length > 1) {
          return { ok: false, error: "msg_too_long" };
        }
        try {
          await this.adapter.continueConversationAsync(
            this.appId,
            opts.conversationReference,
            async (turnContext) => {
              const activity = MessageFactory.text(chunks[0] || "");
              activity.id = opts.activityId;
              await turnContext.updateActivity(activity);
            }
          );
          return { ok: true, activityId: opts.activityId };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }
      /**
       * Delete a previously sent bot message.
       */
      async deleteMessage(opts) {
        try {
          await this.adapter.continueConversationAsync(
            this.appId,
            opts.conversationReference,
            async (turnContext) => {
              await turnContext.deleteActivity(opts.activityId);
            }
          );
          return true;
        } catch {
          return false;
        }
      }
    };
  }
});

// src/frontends/teams-frontend.ts
var TeamsFrontend;
var init_teams_frontend = __esm({
  "src/frontends/teams-frontend.ts"() {
    init_client();
    init_markdown();
    init_task_live_updates();
    TeamsFrontend = class {
      name = "teams";
      subs = [];
      cfg;
      errorNotified = false;
      constructor(config) {
        this.cfg = config || {};
      }
      start(ctx) {
        const bus = ctx.eventBus;
        try {
          ctx.logger.info(`[teams-frontend] started`);
        } catch {
        }
        this.subs.push(
          bus.on("CheckCompleted", async (env) => {
            const ev = env && env.payload || env;
            await this.maybePostDirectReply(ctx, ev.checkId, ev.result).catch(() => {
            });
          })
        );
        this.subs.push(
          bus.on("CheckErrored", async (env) => {
            const ev = env && env.payload || env;
            const message = ev?.error?.message || "Execution error";
            await this.maybePostError(ctx, "Check failed", message, ev?.checkId).catch(() => {
            });
          })
        );
        this.subs.push(
          bus.on("Shutdown", async (env) => {
            const ev = env && env.payload || env;
            const message = ev?.error?.message || "Fatal error";
            await this.maybePostError(ctx, "Run failed", message).catch(() => {
            });
          })
        );
      }
      stop() {
        for (const s of this.subs) s.unsubscribe();
        this.subs = [];
      }
      getTeams(ctx) {
        const injected = ctx.teams || ctx.teamsClient;
        if (injected) return injected;
        try {
          const appId = this.cfg.appId || process.env.TEAMS_APP_ID;
          const appPassword = this.cfg.appPassword || process.env.TEAMS_APP_PASSWORD;
          if (typeof appId === "string" && appId.trim() && typeof appPassword === "string" && appPassword.trim()) {
            return new TeamsClient({
              appId: appId.trim(),
              appPassword: appPassword.trim(),
              tenantId: this.cfg.tenantId || process.env.TEAMS_TENANT_ID
            });
          }
        } catch {
        }
        return void 0;
      }
      getInboundTeamsPayload(ctx) {
        try {
          const endpoint = "/bots/teams/message";
          return ctx.webhookContext?.webhookData?.get(endpoint) || null;
        } catch {
          return null;
        }
      }
      async maybePostError(ctx, title, message, _checkId) {
        if (this.errorNotified) return;
        const teams = this.getTeams(ctx);
        if (!teams) return;
        const payload = this.getInboundTeamsPayload(ctx);
        const conversationRef = payload?.teams_conversation_reference;
        if (!conversationRef) return;
        const ev = payload?.event;
        let text = `${title}`;
        if (_checkId) text += `
Check: ${_checkId}`;
        if (message) text += `
${message}`;
        await teams.sendMessage({
          conversationReference: conversationRef,
          text,
          replyToActivityId: ev?.activity_id
        });
        this.errorNotified = true;
      }
      async maybePostDirectReply(ctx, checkId, result) {
        try {
          const cfg = ctx.config || {};
          const checkCfg = cfg.checks?.[checkId];
          if (!checkCfg) return;
          const providerType = checkCfg.type || "";
          const isAi = providerType === "ai";
          const isLogChat = providerType === "log" && checkCfg.group === "chat";
          const isWorkflow = providerType === "workflow";
          if (!isAi && !isLogChat && !isWorkflow) return;
          if (checkCfg.criticality === "internal") return;
          if (isFrontendLiveUpdatesEnabled(cfg.task_live_updates, "teams")) return;
          if (isAi) {
            const schema = checkCfg.schema;
            if (typeof schema === "string") {
              const simpleSchemas = ["code-review", "markdown", "text", "plain"];
              if (!simpleSchemas.includes(schema)) return;
            }
          }
          const teams = this.getTeams(ctx);
          if (!teams) return;
          const payload = this.getInboundTeamsPayload(ctx);
          const conversationRef = payload?.teams_conversation_reference;
          if (!conversationRef) {
            ctx.logger.warn(
              `[teams-frontend] skip posting reply for ${checkId}: missing conversation reference`
            );
            return;
          }
          const ev = payload?.event;
          const out = result?.output;
          let text;
          if (out && typeof out.text === "string" && out.text.trim().length > 0) {
            text = out.text.trim();
          } else if (isAi && typeof checkCfg.schema === "string") {
            if (typeof result?.content === "string" && result.content.trim().length > 0) {
              text = result.content.trim();
            }
          } else if (isLogChat && typeof result?.logOutput === "string") {
            const raw = result.logOutput;
            if (raw.trim().length > 0) text = raw.trim();
          }
          if (out && typeof out._rawOutput === "string" && out._rawOutput.trim().length > 0) {
            text = (text || "") + "\n\n" + out._rawOutput.trim();
          }
          if (!text) {
            ctx.logger.info(`[teams-frontend] skip posting reply for ${checkId}: no renderable text`);
            return;
          }
          text = text.replace(/\\n/g, "\n");
          const formattedText = formatTeamsText(text);
          const postResult = await teams.sendMessage({
            conversationReference: conversationRef,
            text: formattedText,
            replyToActivityId: ev?.activity_id
          });
          if (!postResult.ok) {
            ctx.logger.warn(
              `[teams-frontend] failed to post reply for ${checkId}: ${postResult.error}`
            );
            return;
          }
          ctx.logger.info(
            `[teams-frontend] posted reply for ${checkId} (activityId=${postResult.activityId})`
          );
        } catch (err) {
          try {
            ctx.logger.warn(
              `[teams-frontend] maybePostDirectReply failed for ${checkId}: ${err instanceof Error ? err.message : String(err)}`
            );
          } catch {
          }
        }
      }
    };
  }
});
init_teams_frontend();
export {
  TeamsFrontend
};
//# sourceMappingURL=teams-frontend-6RRW533K.mjs.map