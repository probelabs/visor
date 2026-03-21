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

// src/telegram/markdown.ts
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function markdownToTelegramHtml(text) {
  if (!text || typeof text !== "string") return "";
  const lines = text.split(/\r?\n/);
  const result = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines = [];
  let inBlockquote = false;
  let blockquoteLines = [];
  const flushBlockquote = () => {
    if (blockquoteLines.length > 0) {
      result.push(`<blockquote>${blockquoteLines.join("\n")}</blockquote>`);
      blockquoteLines = [];
      inBlockquote = false;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^```/.test(trimmed)) {
      if (!inCodeBlock) {
        flushBlockquote();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        const escaped = codeLines.map((l) => escapeHtml(l)).join("\n");
        if (codeBlockLang && codeBlockLang !== "mermaid") {
          result.push(
            `<pre><code class="language-${escapeHtml(codeBlockLang)}">${escaped}</code></pre>`
          );
        } else {
          result.push(`<pre>${escaped}</pre>`);
        }
        inCodeBlock = false;
        codeBlockLang = "";
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(lines[i]);
      continue;
    }
    const bqMatch = /^>\s?(.*)$/.exec(trimmed);
    if (bqMatch) {
      inBlockquote = true;
      blockquoteLines.push(convertInline(bqMatch[1]));
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }
    const line = lines[i];
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line.trimStart());
    if (headerMatch) {
      result.push(`<b>${convertInline(headerMatch[2].trim())}</b>`);
      continue;
    }
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      result.push("\u2014\u2014\u2014");
      continue;
    }
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      result.push(`${indent}\u2022 ${convertInline(bulletMatch[3])}`);
      continue;
    }
    const numMatch = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
    if (numMatch) {
      result.push(`${numMatch[1]}${numMatch[2]} ${convertInline(numMatch[3])}`);
      continue;
    }
    result.push(convertInline(line));
  }
  if (inCodeBlock && codeLines.length > 0) {
    const escaped = codeLines.map((l) => escapeHtml(l)).join("\n");
    result.push(`<pre>${escaped}</pre>`);
  }
  flushBlockquote();
  return result.join("\n");
}
function convertInline(line) {
  const codeSpans = [];
  let processed = line.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\0CODE${idx}\0`;
  });
  processed = escapeHtml(processed);
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt, url) => `<a href="${url}">${alt || "image"}</a>`
  );
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, label, url) => `<a href="${url}">${label}</a>`
  );
  processed = processed.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  processed = processed.replace(/__([^_]+)__/g, "<b>$1</b>");
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");
  processed = processed.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  processed = processed.replace(
    /\x00CODE(\d+)\x00/g,
    (_m, idx) => codeSpans[parseInt(idx)]
  );
  return processed;
}
function chunkText(text, limit = 4096) {
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
function formatTelegramText(text) {
  return markdownToTelegramHtml(text);
}
var init_markdown = __esm({
  "src/telegram/markdown.ts"() {
    "use strict";
  }
});

// src/telegram/client.ts
import { Bot } from "grammy";
var TelegramClient;
var init_client = __esm({
  "src/telegram/client.ts"() {
    "use strict";
    init_markdown();
    TelegramClient = class {
      bot;
      _botInfo = null;
      constructor(botToken) {
        if (!botToken || typeof botToken !== "string") {
          throw new Error("TelegramClient: botToken is required");
        }
        this.bot = new Bot(botToken);
      }
      /** Get the underlying grammy Bot instance (for polling runner) */
      getBot() {
        return this.bot;
      }
      /** Get the underlying grammy API instance */
      get api() {
        return this.bot.api;
      }
      /** Initialize bot info (call before using) */
      async init() {
        const me = await this.bot.api.getMe();
        this._botInfo = {
          id: me.id,
          is_bot: me.is_bot,
          first_name: me.first_name,
          username: me.username
        };
        return this._botInfo;
      }
      /** Get cached bot info */
      getBotInfo() {
        return this._botInfo;
      }
      /**
       * Send a text message with optional HTML parse mode.
       * Auto-chunks messages exceeding 4096 characters.
       * Falls back to plain text if HTML parsing fails.
       */
      async sendMessage(opts) {
        try {
          const { chat_id, text, parse_mode, reply_to_message_id, message_thread_id } = opts;
          const chunks = chunkText(text, 4096);
          let firstMessageId;
          for (let i = 0; i < chunks.length; i++) {
            const params = {
              // disable_web_page_preview is deprecated, use link_preview_options
              link_preview_options: { is_disabled: true }
            };
            if (parse_mode) params.parse_mode = parse_mode;
            if (i === 0 && reply_to_message_id)
              params.reply_parameters = { message_id: reply_to_message_id };
            if (message_thread_id) params.message_thread_id = message_thread_id;
            try {
              const msg = await this.bot.api.sendMessage(chat_id, chunks[i], params);
              if (i === 0) firstMessageId = msg.message_id;
            } catch (err) {
              if (parse_mode === "HTML" && err?.description?.includes("can't parse entities")) {
                const plainParams = { ...params };
                delete plainParams.parse_mode;
                const msg = await this.bot.api.sendMessage(chat_id, chunks[i], plainParams);
                if (i === 0) firstMessageId = msg.message_id;
              } else {
                throw err;
              }
            }
          }
          return { ok: true, message_id: firstMessageId };
        } catch (err) {
          const errMsg = err?.description || err?.message || String(err);
          console.warn(`Telegram sendMessage failed (non-fatal): ${errMsg}`);
          return { ok: false, error: errMsg };
        }
      }
      /**
       * Edit an existing text message.
       * Returns ok=false if Telegram rejects the edit (e.g. message too old or unchanged).
       */
      async editMessageText(opts) {
        try {
          const params = {
            link_preview_options: { is_disabled: true }
          };
          if (opts.parse_mode) params.parse_mode = opts.parse_mode;
          const msg = await this.bot.api.editMessageText(
            opts.chat_id,
            opts.message_id,
            opts.text,
            params
          );
          const messageId = msg?.message_id || opts.message_id;
          return { ok: true, message_id: messageId };
        } catch (err) {
          const errMsg = err?.description || err?.message || String(err);
          console.warn(`Telegram editMessageText failed (non-fatal): ${errMsg}`);
          return { ok: false, error: errMsg };
        }
      }
      /**
       * Delete a message.
       */
      async deleteMessage(opts) {
        try {
          await this.bot.api.deleteMessage(opts.chat_id, opts.message_id);
          return true;
        } catch (err) {
          console.warn(
            `Telegram deleteMessage failed (non-fatal): ${err?.description || err?.message || String(err)}`
          );
          return false;
        }
      }
      /**
       * Send a document/file.
       */
      async sendDocument(opts) {
        try {
          const {
            chat_id,
            document,
            filename,
            caption,
            parse_mode,
            reply_to_message_id,
            message_thread_id
          } = opts;
          const params = {};
          if (caption) params.caption = caption.slice(0, 1024);
          if (parse_mode) params.parse_mode = parse_mode;
          if (reply_to_message_id) params.reply_parameters = { message_id: reply_to_message_id };
          if (message_thread_id) params.message_thread_id = message_thread_id;
          const file = new (await import("grammy")).InputFile(document, filename);
          const msg = await this.bot.api.sendDocument(chat_id, file, params);
          return { ok: true, message_id: msg.message_id };
        } catch (err) {
          const errMsg = err?.description || err?.message || String(err);
          console.warn(`Telegram sendDocument failed (non-fatal): ${errMsg}`);
          return { ok: false, error: errMsg };
        }
      }
      /**
       * Add an emoji reaction to a message.
       * Note: Bot must be admin in groups to set reactions.
       */
      async setMessageReaction(opts) {
        try {
          await this.bot.api.setMessageReaction(opts.chat_id, opts.message_id, [
            { type: "emoji", emoji: opts.emoji }
          ]);
          return true;
        } catch (err) {
          console.warn(
            `Telegram setMessageReaction failed (non-fatal): ${err?.description || err?.message || String(err)}`
          );
          return false;
        }
      }
    };
  }
});

// src/frontends/telegram-frontend.ts
var TelegramFrontend;
var init_telegram_frontend = __esm({
  "src/frontends/telegram-frontend.ts"() {
    init_client();
    init_markdown();
    init_task_live_updates();
    TelegramFrontend = class {
      name = "telegram";
      subs = [];
      cfg;
      acked = false;
      ackRef = null;
      errorNotified = false;
      constructor(config) {
        this.cfg = config || {};
      }
      start(ctx) {
        const bus = ctx.eventBus;
        try {
          ctx.logger.info(`[telegram-frontend] started`);
        } catch {
        }
        try {
          const payload = this.getInboundTelegramPayload(ctx);
          if (payload) {
            const ev = payload.event || {};
            const chatId = String(ev.chat_id || "-");
            const msgId = String(ev.message_id || "-");
            ctx.logger.info(`[telegram-frontend] inbound event: chat_id=${chatId} message_id=${msgId}`);
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
      }
      stop() {
        for (const s of this.subs) s.unsubscribe();
        this.subs = [];
      }
      getTelegram(ctx) {
        const injected = ctx.telegram || ctx.telegramClient;
        if (injected) return injected;
        try {
          const token = this.cfg.botToken || process.env.TELEGRAM_BOT_TOKEN;
          if (typeof token === "string" && token.trim()) {
            return new TelegramClient(token.trim());
          }
        } catch {
        }
        return void 0;
      }
      getInboundTelegramPayload(ctx) {
        try {
          const endpoint = "/bots/telegram/message";
          return ctx.webhookContext?.webhookData?.get(endpoint) || null;
        } catch {
          return null;
        }
      }
      getInboundTelegramEvent(ctx) {
        try {
          const payload = this.getInboundTelegramPayload(ctx);
          const ev = payload?.event;
          const chatId = ev?.chat_id;
          const messageId = ev?.message_id;
          if (chatId !== void 0 && messageId !== void 0) {
            return { chatId, messageId };
          }
        } catch {
        }
        return null;
      }
      async ensureAcknowledgement(ctx) {
        if (this.acked) return;
        const ref = this.getInboundTelegramEvent(ctx);
        if (!ref) return;
        const telegram = this.getTelegram(ctx);
        if (!telegram) return;
        try {
          const payload = this.getInboundTelegramPayload(ctx);
          const ev = payload?.event;
          const botInfo = telegram.getBotInfo();
          if (botInfo && ev?.from?.id === botInfo.id) return;
        } catch {
        }
        await telegram.setMessageReaction({
          chat_id: ref.chatId,
          message_id: ref.messageId,
          emoji: "\u{1F440}"
        });
        try {
          ctx.logger.info(
            `[telegram-frontend] added ack reaction chat_id=${ref.chatId} message_id=${ref.messageId}`
          );
        } catch {
        }
        this.acked = true;
        this.ackRef = ref;
      }
      async finalizeReactions(ctx) {
        if (!this.acked || !this.ackRef) return;
        const telegram = this.getTelegram(ctx);
        if (!telegram) return;
        try {
          await telegram.setMessageReaction({
            chat_id: this.ackRef.chatId,
            message_id: this.ackRef.messageId,
            emoji: "\u{1F44D}"
          });
          try {
            ctx.logger.info(
              `[telegram-frontend] finalized reaction chat_id=${this.ackRef.chatId} message_id=${this.ackRef.messageId}`
            );
          } catch {
          }
        } finally {
          this.acked = false;
          this.ackRef = null;
        }
      }
      async maybePostError(ctx, title, message, checkId) {
        if (this.errorNotified) return;
        const telegram = this.getTelegram(ctx);
        if (!telegram) return;
        const payload = this.getInboundTelegramPayload(ctx);
        const ev = payload?.event;
        const chatId = ev?.chat_id;
        const messageId = ev?.message_id;
        if (chatId === void 0) return;
        let text = `\u274C ${title}`;
        if (checkId) text += `
Check: ${checkId}`;
        if (message) text += `
${message}`;
        await telegram.sendMessage({
          chat_id: chatId,
          text,
          reply_to_message_id: messageId
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
          if (isFrontendLiveUpdatesEnabled(cfg.task_live_updates, "telegram")) return;
          if (isAi) {
            const schema = checkCfg.schema;
            if (typeof schema === "string") {
              const simpleSchemas = ["code-review", "markdown", "text", "plain"];
              if (!simpleSchemas.includes(schema)) return;
            }
          }
          const telegram = this.getTelegram(ctx);
          if (!telegram) return;
          const payload = this.getInboundTelegramPayload(ctx);
          const ev = payload?.event;
          const chatId = ev?.chat_id;
          const messageId = ev?.message_id;
          if (chatId === void 0) {
            ctx.logger.warn(`[telegram-frontend] skip posting reply for ${checkId}: missing chat_id`);
            return;
          }
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
            ctx.logger.info(
              `[telegram-frontend] skip posting reply for ${checkId}: no renderable text`
            );
            return;
          }
          text = text.replace(/\\n/g, "\n");
          const formattedText = formatTelegramText(text);
          const postResult = await telegram.sendMessage({
            chat_id: chatId,
            text: formattedText,
            parse_mode: "HTML",
            reply_to_message_id: messageId,
            message_thread_id: ev?.message_thread_id
          });
          if (!postResult.ok) {
            ctx.logger.warn(
              `[telegram-frontend] failed to post reply for ${checkId}: ${postResult.error}`
            );
            return;
          }
          ctx.logger.info(
            `[telegram-frontend] posted reply for ${checkId} to chat_id=${chatId} message_id=${postResult.message_id}`
          );
        } catch (err) {
          try {
            ctx.logger.warn(
              `[telegram-frontend] maybePostDirectReply failed for ${checkId}: ${err instanceof Error ? err.message : String(err)}`
            );
          } catch {
          }
        }
      }
    };
  }
});
init_telegram_frontend();
export {
  TelegramFrontend
};
//# sourceMappingURL=telegram-frontend-5UA77YAT.mjs.map