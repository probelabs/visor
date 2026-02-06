import {
  context,
  init_lazy_otel,
  trace
} from "./chunk-4HVFUUNB.mjs";
import "./chunk-J7LXIPZS.mjs";

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
  /**
   * Fetch user info from Slack API.
   * Returns user profile including guest status flags, email, and display name.
   */
  async getUserInfo(userId) {
    try {
      const resp = await this.api("users.info", { user: userId });
      if (!resp || resp.ok !== true || !resp.user) {
        return { ok: false };
      }
      return {
        ok: true,
        user: {
          id: resp.user.id,
          name: resp.user.name,
          real_name: resp.user.real_name || resp.user.profile?.real_name,
          email: resp.user.profile?.email,
          is_restricted: resp.user.is_restricted,
          is_ultra_restricted: resp.user.is_ultra_restricted,
          is_bot: resp.user.is_bot,
          is_app_user: resp.user.is_app_user,
          deleted: resp.user.deleted
        }
      };
    } catch (e) {
      console.warn(`Slack users.info failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
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
  files = {
    /**
     * Upload a file to Slack using files.uploadV2 API
     * @param options Upload options including file content, filename, channel, and thread_ts
     */
    uploadV2: async ({
      content,
      filename,
      channel,
      thread_ts,
      title,
      initial_comment
    }) => {
      try {
        const getUrlResp = await this.api("files.getUploadURLExternal", {
          filename,
          length: content.length
        });
        if (!getUrlResp || getUrlResp.ok !== true || !getUrlResp.upload_url) {
          console.warn(
            `Slack files.getUploadURLExternal failed: ${getUrlResp?.error || "unknown"}`
          );
          return { ok: false };
        }
        const uploadResp = await fetch(getUrlResp.upload_url, {
          method: "POST",
          body: content
        });
        if (!uploadResp.ok) {
          console.warn(`Slack file upload to URL failed: ${uploadResp.status}`);
          return { ok: false };
        }
        const completeResp = await this.api("files.completeUploadExternal", {
          files: [{ id: getUrlResp.file_id, title: title || filename }],
          channel_id: channel,
          thread_ts,
          initial_comment
        });
        if (!completeResp || completeResp.ok !== true) {
          console.warn(
            `Slack files.completeUploadExternal failed: ${completeResp?.error || "unknown"}`
          );
          return { ok: false };
        }
        return {
          ok: true,
          file: completeResp.files?.[0] || { id: getUrlResp.file_id }
        };
      } catch (e) {
        console.warn(`Slack file upload failed: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false };
      }
    }
  };
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
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
function extractMermaidDiagrams(text) {
  const diagrams = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    diagrams.push({
      fullMatch: match[0],
      code: match[1].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }
  return diagrams;
}
async function renderMermaidToPng(mermaidCode) {
  const tmpDir = os.tmpdir();
  const inputFile = path.join(
    tmpDir,
    `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}.mmd`
  );
  const outputFile = path.join(
    tmpDir,
    `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  );
  try {
    fs.writeFileSync(inputFile, mermaidCode, "utf-8");
    const chromiumPaths = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/chrome"
    ];
    let chromiumPath;
    for (const p of chromiumPaths) {
      if (fs.existsSync(p)) {
        chromiumPath = p;
        break;
      }
    }
    const env = { ...process.env };
    if (chromiumPath) {
      env.PUPPETEER_EXECUTABLE_PATH = chromiumPath;
    }
    const result = await new Promise((resolve) => {
      const proc = spawn(
        "npx",
        [
          "--yes",
          "@mermaid-js/mermaid-cli",
          "-i",
          inputFile,
          "-o",
          outputFile,
          "-e",
          "png",
          "-b",
          "white",
          "-w",
          "1200"
        ],
        {
          timeout: 6e4,
          // 60 second timeout (first run may download packages)
          stdio: ["pipe", "pipe", "pipe"],
          env
        }
      );
      let stderr = "";
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr || `Exit code ${code}` });
        }
      });
      proc.on("error", (err) => {
        resolve({ success: false, error: err.message });
      });
    });
    if (!result.success) {
      console.warn(`Mermaid rendering failed: ${result.error}`);
      return null;
    }
    if (!fs.existsSync(outputFile)) {
      console.warn("Mermaid output file not created");
      return null;
    }
    const pngBuffer = fs.readFileSync(outputFile);
    return pngBuffer;
  } catch (e) {
    console.warn(`Mermaid rendering error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch {
    }
  }
}
function replaceMermaidBlocks(text, diagrams, replacement = "_(See diagram above)_") {
  if (diagrams.length === 0) return text;
  const sorted = [...diagrams].sort((a, b) => b.startIndex - a.startIndex);
  let result = text;
  sorted.forEach((diagram, sortedIndex) => {
    const originalIndex = diagrams.length - 1 - sortedIndex;
    const rep = typeof replacement === "function" ? replacement(originalIndex) : replacement;
    result = result.slice(0, diagram.startIndex) + rep + result.slice(diagram.endIndex);
  });
  return result;
}
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
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headerMatch) {
      const [, hashes, headerText] = headerMatch;
      const prevLine = i > 0 ? lines[i - 1].trim() : "";
      const prevIsHeaderOrFence = /^#{1,6}\s+/.test(prevLine) || /^\*[^*]+\*$/.test(prevLine) || /^```/.test(prevLine);
      if (hashes.length <= 2 && i > 0 && prevLine !== "" && !prevIsHeaderOrFence) {
        lines[i] = `
*${headerText.trim()}*`;
      } else {
        lines[i] = `*${headerText.trim()}*`;
      }
      continue;
    }
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const [, indent, , rest] = bulletMatch;
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
init_lazy_otel();
var SlackFrontend = class {
  name = "slack";
  subs = [];
  cfg;
  // Reactions ack/done per run (inbound Slack events only)
  acked = false;
  ackRef = null;
  ackName = "eyes";
  doneName = "thumbsup";
  errorNotified = false;
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
        await this.maybePostExecutionFailure(ctx, ev.checkId, ev.result).catch(() => {
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
      bus.on("StateTransition", async (env) => {
        const ev = env && env.payload || env;
        if (ev && (ev.to === "Completed" || ev.to === "Error")) {
          await this.finalizeReactions(ctx).catch(() => {
          });
        }
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
          const { getPromptStateManager } = await import("./prompt-state-X2WDGSEM.mjs");
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
          const { getPromptStateManager } = await import("./prompt-state-X2WDGSEM.mjs");
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
  isTelemetryEnabled(ctx) {
    try {
      const anyCfg = ctx.config || {};
      const slackCfg = anyCfg.slack || {};
      const telemetryCfg = slackCfg.telemetry ?? this.cfg?.telemetry;
      return telemetryCfg === true || telemetryCfg && typeof telemetryCfg === "object" && telemetryCfg.enabled === true;
    } catch {
      return false;
    }
  }
  async maybePostError(ctx, title, message, checkId) {
    if (this.errorNotified) return;
    const slack = this.getSlack(ctx);
    if (!slack) return;
    const payload = this.getInboundSlackPayload(ctx);
    const ev = payload?.event;
    const channel = String(ev?.channel || "");
    const threadTs = String(ev?.thread_ts || ev?.ts || ev?.event_ts || "");
    if (!channel || !threadTs) return;
    let text = `\u274C ${title}`;
    if (checkId) text += `
Check: ${checkId}`;
    if (message) text += `
${message}`;
    if (this.isTelemetryEnabled(ctx)) {
      const traceInfo = this.getTraceInfo();
      if (traceInfo?.traceId) {
        text += `

\`trace_id: ${traceInfo.traceId}\``;
      }
    }
    const formattedText = formatSlackText(text);
    await slack.chat.postMessage({ channel, text: formattedText, thread_ts: threadTs });
    try {
      ctx.logger.info(
        `[slack-frontend] posted error notice to ${channel} thread=${threadTs} check=${checkId || "run"}`
      );
    } catch {
    }
    this.errorNotified = true;
  }
  isExecutionFailureIssue(issue) {
    const ruleId = String(issue?.ruleId || "");
    const msg = String(issue?.message || "");
    const msgLower = msg.toLowerCase();
    return ruleId.endsWith("/error") || ruleId.includes("/execution_error") || ruleId.includes("timeout") || ruleId.includes("sandbox_runner_error") || msgLower.includes("timed out") || msg.includes("Command execution failed");
  }
  async maybePostExecutionFailure(ctx, checkId, result) {
    try {
      if (this.errorNotified) return;
      const cfg = ctx.config || {};
      const checkCfg = cfg.checks?.[checkId];
      if (!checkCfg) return;
      if (checkCfg.type === "human-input") return;
      if (checkCfg.criticality === "internal") return;
      const issues = result?.issues;
      if (!Array.isArray(issues) || issues.length === 0) return;
      const failureIssue = issues.find((issue) => this.isExecutionFailureIssue(issue));
      if (!failureIssue) return;
      if (typeof failureIssue.message === "string" && failureIssue.message.toLowerCase().includes("awaiting human input")) {
        return;
      }
      const msg = typeof failureIssue.message === "string" && failureIssue.message.trim().length > 0 ? failureIssue.message.trim() : `Execution failed (${String(failureIssue.ruleId || "unknown")})`;
      await this.maybePostError(ctx, "Check failed", msg, checkId);
    } catch {
    }
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
      const telemetryCfg = slackRoot.telemetry ?? this.cfg?.telemetry;
      const providerType = checkCfg.type || "";
      const isAi = providerType === "ai";
      const isLogChat = providerType === "log" && checkCfg.group === "chat";
      if (!isAi && !isLogChat) return;
      if (checkCfg.criticality === "internal") return;
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
      } else if (isLogChat && typeof result?.logOutput === "string") {
        const raw = result.logOutput;
        if (raw.trim().length > 0) {
          text = raw.trim();
        }
      } else if (isAi && showRawOutput && out !== void 0) {
        try {
          text = JSON.stringify(out, null, 2);
        } catch {
          text = String(out);
        }
      }
      if (!text) return;
      const diagrams = extractMermaidDiagrams(text);
      let processedText = text;
      if (diagrams.length > 0) {
        try {
          ctx.logger.info(
            `[slack-frontend] found ${diagrams.length} mermaid diagram(s) to render for ${checkId}`
          );
        } catch {
        }
        const uploadedCount = [];
        for (let i = 0; i < diagrams.length; i++) {
          const diagram = diagrams[i];
          try {
            ctx.logger.info(`[slack-frontend] rendering mermaid diagram ${i + 1}...`);
            const pngBuffer = await renderMermaidToPng(diagram.code);
            if (pngBuffer) {
              ctx.logger.info(
                `[slack-frontend] rendered diagram ${i + 1}, size=${pngBuffer.length} bytes, uploading...`
              );
              const filename = `diagram-${i + 1}.png`;
              const uploadResult = await slack.files.uploadV2({
                content: pngBuffer,
                filename,
                channel,
                thread_ts: threadTs,
                title: `Diagram ${i + 1}`
              });
              if (uploadResult.ok) {
                uploadedCount.push(i);
                ctx.logger.info(`[slack-frontend] uploaded mermaid diagram ${i + 1} to ${channel}`);
              } else {
                ctx.logger.warn(`[slack-frontend] upload failed for diagram ${i + 1}`);
              }
            } else {
              ctx.logger.warn(
                `[slack-frontend] mermaid rendering returned null for diagram ${i + 1} (mmdc failed or not installed)`
              );
            }
          } catch (e) {
            ctx.logger.warn(
              `[slack-frontend] failed to render/upload mermaid diagram ${i + 1}: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
        if (uploadedCount.length > 0) {
          processedText = replaceMermaidBlocks(
            text,
            diagrams,
            (idx) => uploadedCount.includes(idx) ? "_(See diagram above)_" : "_(Diagram rendering failed)_"
          );
        }
      }
      let decoratedText = processedText;
      const telemetryEnabled = telemetryCfg === true || telemetryCfg && typeof telemetryCfg === "object" && telemetryCfg.enabled === true;
      if (telemetryEnabled) {
        const traceInfo = this.getTraceInfo();
        if (traceInfo?.traceId) {
          const suffix = `\`trace_id: ${traceInfo.traceId}\``;
          decoratedText = `${decoratedText}

${suffix}`;
        }
      }
      const formattedText = formatSlackText(decoratedText);
      await slack.chat.postMessage({ channel, text: formattedText, thread_ts: threadTs });
      ctx.logger.info(
        `[slack-frontend] posted AI reply for ${checkId} to ${channel} thread=${threadTs}`
      );
    } catch (outerErr) {
      try {
        ctx.logger.warn(
          `[slack-frontend] maybePostDirectReply failed for ${checkId}: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`
        );
      } catch {
      }
    }
  }
  getTraceInfo() {
    try {
      const span = trace.getSpan(context.active());
      if (!span) return null;
      const ctx = span.spanContext();
      if (!ctx || !ctx.traceId) return null;
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    } catch {
      return null;
    }
  }
};
export {
  SlackFrontend
};
//# sourceMappingURL=slack-frontend-ZMVXJTZH.mjs.map