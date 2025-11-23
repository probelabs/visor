import "./chunk-WMJKH4XE.mjs";

// src/slack/client.ts
var SlackClient = class {
  token;
  constructor(botToken) {
    if (!botToken || typeof botToken !== "string") {
      throw new Error("SlackClient: botToken is required");
    }
    this.token = botToken;
  }
  reactions = {
    add: async ({
      channel,
      timestamp,
      name
    }) => {
      const resp = await this.api("reactions.add", { channel, timestamp, name });
      if (!resp || resp.ok !== true) {
        const err = resp && resp.error || "unknown_error";
        console.warn(`Slack reactions.add failed (non-fatal): ${err}`);
        return { ok: false };
      }
      return { ok: true };
    },
    remove: async ({
      channel,
      timestamp,
      name
    }) => {
      const resp = await this.api("reactions.remove", { channel, timestamp, name });
      if (!resp || resp.ok !== true) {
        const err = resp && resp.error || "unknown_error";
        console.warn(`Slack reactions.remove failed (non-fatal): ${err}`);
        return { ok: false };
      }
      return { ok: true };
    }
  };
  chat = {
    postMessage: async ({
      channel,
      text,
      thread_ts
    }) => {
      const resp = await this.api("chat.postMessage", { channel, text, thread_ts });
      if (!resp || resp.ok !== true) {
        const err = resp && resp.error || "unknown_error";
        console.warn(`Slack chat.postMessage failed (non-fatal): ${err}`);
        return {
          ts: void 0,
          message: void 0,
          data: resp
        };
      }
      return {
        ts: resp.ts || resp.message && resp.message.ts || void 0,
        message: resp.message,
        data: resp
      };
    },
    update: async ({ channel, ts, text }) => {
      const resp = await this.api("chat.update", { channel, ts, text });
      if (!resp || resp.ok !== true) {
        const err = resp && resp.error || "unknown_error";
        console.warn(`Slack chat.update failed (non-fatal): ${err}`);
        return { ok: false, ts };
      }
      return { ok: true, ts: resp.ts || ts };
    }
  };
  async getBotUserId() {
    const resp = await this.api("auth.test", {});
    if (!resp || resp.ok !== true || !resp.user_id) {
      console.warn("Slack auth.test failed (non-fatal); bot user id unavailable");
      return "UNKNOWN_BOT";
    }
    return String(resp.user_id);
  }
  async fetchThreadReplies(channel, thread_ts, limit = 40) {
    try {
      const params = new URLSearchParams({
        channel,
        ts: thread_ts,
        limit: String(limit)
      });
      const res = await fetch(`https://slack.com/api/conversations.replies?${params.toString()}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`
        }
      });
      const resp = await res.json();
      if (!resp || resp.ok !== true || !Array.isArray(resp.messages)) {
        const err = resp && resp.error || "unknown_error";
        console.warn(
          `Slack conversations.replies failed (non-fatal): ${err} (channel=${channel}, ts=${thread_ts}, limit=${limit})`
        );
        return [];
      }
      return resp.messages.map((m) => ({
        ts: String(m.ts || ""),
        user: m.user,
        text: m.text,
        bot_id: m.bot_id,
        thread_ts: m.thread_ts
      }));
    } catch (e) {
      console.warn(
        `Slack conversations.replies failed (non-fatal): ${e instanceof Error ? e.message : String(e)} (channel=${channel}, ts=${thread_ts}, limit=${limit})`
      );
      return [];
    }
  }
  getWebClient() {
    return {
      conversations: {
        history: async ({ channel, limit }) => await this.api("conversations.history", { channel, limit }),
        open: async ({ users }) => await this.api("conversations.open", { users }),
        replies: async ({ channel, ts, limit }) => await this.api("conversations.replies", { channel, ts, limit })
      }
    };
  }
  async api(method, body) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify(body)
    });
    return await res.json();
  }
};

// src/slack/markdown.ts
function markdownToSlack(text) {
  if (!text || typeof text !== "string") return "";
  let out = text;
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt, url) => `<${url}|${alt || "image"}>`
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label, url) => `<${url}|${label}>`
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner) => `*${inner}*`);
  out = out.replace(/__([^_]+)__/g, (_m, inner) => `*${inner}*`);
  const lines = out.split(/\r?\n/);
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (match) {
      const [, indent, , rest] = match;
      lines[i] = `${indent}\u2022 ${rest}`;
    }
  }
  out = lines.join("\n");
  return out;
}
function formatSlackText(text) {
  return markdownToSlack(text);
}

// src/frontends/slack-frontend.ts
var SlackFrontend = class {
  name = "slack";
  subs = [];
  cfg;
  // Reactions ack/done per run (inbound Slack events only)
  acked = false;
  ackRef = null;
  ackName = "eyes";
  doneName = "thumbsup";
  constructor(config) {
    this.cfg = config || {};
  }
  start(ctx) {
    const bus = ctx.eventBus;
    try {
      const hasClient = !!(ctx.slack || ctx.slackClient || this.cfg?.botToken || process.env.SLACK_BOT_TOKEN);
      ctx.logger.info(`[slack-frontend] started; hasClient=${hasClient} defaultChannel=unset`);
    } catch {
    }
    try {
      const payload = this.getInboundSlackPayload(ctx);
      if (payload) {
        const ev = payload.event || {};
        const ch = String(ev.channel || "-");
        const ts = String(ev.ts || ev.event_ts || "-");
        const user = String(ev.user || ev.bot_id || "-");
        const type = String(ev.type || "-");
        const thread = String(ev.thread_ts || "");
        ctx.logger.info(
          `[slack-frontend] inbound event received: type=${type} channel=${ch} ts=${ts}` + (thread ? ` thread_ts=${thread}` : "") + ` user=${user}`
        );
      }
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
      bus.on("StateTransition", async (env) => {
        const ev = env && env.payload || env;
        if (ev && (ev.to === "Completed" || ev.to === "Error")) {
          await this.finalizeReactions(ctx).catch(() => {
          });
        }
      })
    );
    this.subs.push(
      bus.on("CheckScheduled", async () => {
        await this.ensureAcknowledgement(ctx).catch(() => {
        });
      })
    );
    this.subs.push(
      bus.on("HumanInputRequested", async (env) => {
        try {
          const ev = env && env.payload || env;
          if (!ev || typeof ev.prompt !== "string" || !ev.checkId) return;
          let channel = ev.channel;
          let threadTs = ev.threadTs;
          if (!channel || !threadTs) {
            const payload = this.getInboundSlackPayload(ctx);
            const e = payload?.event;
            const derivedTs = String(e?.thread_ts || e?.ts || e?.event_ts || "");
            const derivedCh = String(e?.channel || "");
            if (derivedCh && derivedTs) {
              channel = channel || derivedCh;
              threadTs = threadTs || derivedTs;
            }
          }
          if (!channel || !threadTs) return;
          const { getPromptStateManager } = await import("./prompt-state-VNPT66WT.mjs");
          const mgr = getPromptStateManager();
          const prev = mgr.getWaiting(channel, threadTs);
          const text = String(ev.prompt);
          mgr.setWaiting(channel, threadTs, {
            checkName: String(ev.checkId),
            prompt: text,
            promptMessageTs: prev?.promptMessageTs,
            promptsPosted: (prev?.promptsPosted || 0) + 1
          });
          try {
            ctx.logger.info(
              `[slack-frontend] registered human-input waiting state for ${channel} thread=${threadTs}`
            );
          } catch {
          }
        } catch (e) {
          try {
            ctx.logger.warn(
              `[slack-frontend] HumanInputRequested handling failed: ${e instanceof Error ? e.message : String(e)}`
            );
          } catch {
          }
        }
      })
    );
    this.subs.push(
      bus.on("SnapshotSaved", async (env) => {
        try {
          const ev = env && env.payload || env;
          const channel = String(ev?.channel || "");
          const threadTs = String(ev?.threadTs || "");
          const filePath = String(ev?.filePath || "");
          if (!channel || !threadTs || !filePath) return;
          const { getPromptStateManager } = await import("./prompt-state-VNPT66WT.mjs");
          const mgr = getPromptStateManager();
          mgr.update(channel, threadTs, { snapshotPath: filePath });
          try {
            ctx.logger.info(
              `[slack-frontend] snapshot path attached to waiting prompt: ${filePath}`
            );
          } catch {
          }
        } catch {
        }
      })
    );
  }
  stop() {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }
  getSlack(ctx) {
    const injected = ctx.slack || ctx.slackClient;
    if (injected) return injected;
    try {
      const token = this.cfg?.botToken || process.env.SLACK_BOT_TOKEN;
      if (typeof token === "string" && token.trim()) {
        return new SlackClient(token.trim());
      }
    } catch {
    }
    return void 0;
  }
  getInboundSlackPayload(ctx) {
    try {
      const anyCfg = ctx.config || {};
      const slackCfg = anyCfg.slack || {};
      const endpoint = slackCfg.endpoint || "/bots/slack/support";
      const payload = ctx.webhookContext?.webhookData?.get(endpoint);
      return payload || null;
    } catch {
      return null;
    }
  }
  getInboundSlackEvent(ctx) {
    try {
      const payload = this.getInboundSlackPayload(ctx);
      const ev = payload?.event;
      const channel = String(ev?.channel || "");
      const ts = String(ev?.ts || ev?.event_ts || "");
      if (channel && ts) return { channel, ts };
    } catch {
    }
    return null;
  }
  async ensureAcknowledgement(ctx) {
    if (this.acked) return;
    const ref = this.getInboundSlackEvent(ctx);
    if (!ref) return;
    const slack = this.getSlack(ctx);
    if (!slack) return;
    try {
      const payload = this.getInboundSlackPayload(ctx);
      const ev = payload?.event;
      if (ev?.subtype === "bot_message") return;
      try {
        const botId = await slack.getBotUserId?.();
        if (botId && ev?.user && String(ev.user) === String(botId)) return;
      } catch {
      }
    } catch {
    }
    try {
      const anyCfg = ctx.config || {};
      const slackCfg = anyCfg.slack || {};
      if (slackCfg?.reactions?.enabled === false) return;
      this.ackName = slackCfg?.reactions?.ack || this.ackName;
      this.doneName = slackCfg?.reactions?.done || this.doneName;
    } catch {
    }
    await slack.reactions.add({ channel: ref.channel, timestamp: ref.ts, name: this.ackName });
    try {
      ctx.logger.info(
        `[slack-frontend] added acknowledgement reaction :${this.ackName}: channel=${ref.channel} ts=${ref.ts}`
      );
    } catch {
    }
    this.acked = true;
    this.ackRef = ref;
  }
  async finalizeReactions(ctx) {
    if (!this.acked || !this.ackRef) return;
    const slack = this.getSlack(ctx);
    if (!slack) return;
    try {
      try {
        await slack.reactions.remove({
          channel: this.ackRef.channel,
          timestamp: this.ackRef.ts,
          name: this.ackName
        });
      } catch {
      }
      await slack.reactions.add({
        channel: this.ackRef.channel,
        timestamp: this.ackRef.ts,
        name: this.doneName
      });
      try {
        ctx.logger.info(
          `[slack-frontend] replaced acknowledgement with completion reaction :${this.doneName}: channel=${this.ackRef.channel} ts=${this.ackRef.ts}`
        );
      } catch {
      }
    } finally {
      this.acked = false;
      this.ackRef = null;
    }
  }
  /**
   * Post direct replies into the originating Slack thread when appropriate.
   * This is independent of summary messages and is intended for chat-style flows
   * (e.g., AI answers and explicit chat/notify steps).
   */
  async maybePostDirectReply(ctx, checkId, result) {
    try {
      const cfg = ctx.config || {};
      const checkCfg = cfg.checks?.[checkId];
      if (!checkCfg) return;
      const slackRoot = cfg.slack || {};
      const showRawOutput = slackRoot.show_raw_output === true || this.cfg?.showRawOutput === true;
      const providerType = checkCfg.type || "";
      const isAi = providerType === "ai";
      const isLogChat = providerType === "log" && checkCfg.group === "chat";
      if (!isAi && !isLogChat) return;
      if (isAi) {
        const schema = checkCfg.schema;
        if (typeof schema === "string") {
          const simpleSchemas = ["code-review", "markdown", "text", "plain"];
          if (!simpleSchemas.includes(schema)) return;
        }
      }
      const slack = this.getSlack(ctx);
      if (!slack) return;
      const payload = this.getInboundSlackPayload(ctx);
      const ev = payload?.event;
      const channel = String(ev?.channel || "");
      const threadTs = String(ev?.thread_ts || ev?.ts || ev?.event_ts || "");
      if (!channel || !threadTs) return;
      const out = result?.output;
      let text;
      if (out && typeof out.text === "string" && out.text.trim().length > 0) {
        text = out.text.trim();
      } else if (isAi && typeof checkCfg.schema === "string") {
        if (typeof result?.content === "string" && result.content.trim().length > 0) {
          text = result.content.trim();
        }
      } else if (isAi && showRawOutput && out !== void 0) {
        try {
          text = JSON.stringify(out, null, 2);
        } catch {
          text = String(out);
        }
      }
      if (!text) return;
      const formattedText = formatSlackText(text);
      await slack.chat.postMessage({ channel, text: formattedText, thread_ts: threadTs });
      try {
        ctx.logger.info(
          `[slack-frontend] posted AI reply for ${checkId} to ${channel} thread=${threadTs}`
        );
      } catch {
      }
    } catch {
    }
  }
};
export {
  SlackFrontend
};
//# sourceMappingURL=slack-frontend-4AOQY4AL.mjs.map