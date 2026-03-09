import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/whatsapp/markdown.ts
function markdownToWhatsApp(text) {
  if (!text || typeof text !== "string") return "";
  const lines = text.split(/\r?\n/);
  const result = [];
  let inCodeBlock = false;
  let codeLines = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^```/.test(trimmed)) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        result.push("```" + codeLines.join("\n") + "```");
        inCodeBlock = false;
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(lines[i]);
      continue;
    }
    const line = lines[i];
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line.trimStart());
    if (headerMatch) {
      result.push(`*${convertInline(headerMatch[2].trim())}*`);
      continue;
    }
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      result.push("---");
      continue;
    }
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      result.push(`${bulletMatch[1]}- ${convertInline(bulletMatch[3])}`);
      continue;
    }
    const numMatch = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
    if (numMatch) {
      result.push(`${numMatch[1]}${numMatch[2]} ${convertInline(numMatch[3])}`);
      continue;
    }
    const bqMatch = /^>\s?(.*)$/.exec(trimmed);
    if (bqMatch) {
      result.push(`> ${convertInline(bqMatch[1])}`);
      continue;
    }
    result.push(convertInline(line));
  }
  if (inCodeBlock && codeLines.length > 0) {
    result.push("```" + codeLines.join("\n") + "```");
  }
  return result.join("\n");
}
function convertInline(line) {
  const codeSpans = [];
  let processed = line.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSpans.length;
    codeSpans.push("```" + code + "```");
    return `\0CODE${idx}\0`;
  });
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt, url) => `${alt || "image"} (${url})`
  );
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label, url) => `${label} (${url})`
  );
  const boldSpans = [];
  processed = processed.replace(/\*\*([^*]+)\*\*/g, (_m, content) => {
    const idx = boldSpans.length;
    boldSpans.push(`*${content}*`);
    return `\0BOLD${idx}\0`;
  });
  processed = processed.replace(/__([^_]+)__/g, (_m, content) => {
    const idx = boldSpans.length;
    boldSpans.push(`*${content}*`);
    return `\0BOLD${idx}\0`;
  });
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_");
  processed = processed.replace(/~~([^~]+)~~/g, "~$1~");
  processed = processed.replace(
    /\x00BOLD(\d+)\x00/g,
    (_m, idx) => boldSpans[parseInt(idx)]
  );
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
function formatWhatsAppText(text) {
  return markdownToWhatsApp(text);
}
var init_markdown = __esm({
  "src/whatsapp/markdown.ts"() {
    "use strict";
  }
});

// src/whatsapp/client.ts
import { createHmac } from "crypto";
var WhatsAppClient;
var init_client = __esm({
  "src/whatsapp/client.ts"() {
    "use strict";
    init_markdown();
    WhatsAppClient = class {
      accessToken;
      phoneNumberId;
      appSecret;
      verifyToken;
      baseUrl;
      constructor(opts) {
        if (!opts.accessToken || typeof opts.accessToken !== "string") {
          throw new Error("WhatsAppClient: accessToken is required");
        }
        if (!opts.phoneNumberId || typeof opts.phoneNumberId !== "string") {
          throw new Error("WhatsAppClient: phoneNumberId is required");
        }
        this.accessToken = opts.accessToken;
        this.phoneNumberId = opts.phoneNumberId;
        this.appSecret = opts.appSecret;
        this.verifyToken = opts.verifyToken;
        const version = opts.apiVersion || "v21.0";
        this.baseUrl = `https://graph.facebook.com/${version}/${this.phoneNumberId}`;
      }
      /** Get the Phone Number ID */
      getPhoneNumberId() {
        return this.phoneNumberId;
      }
      /**
       * Send a text message. Auto-chunks at 4096 characters.
       */
      async sendMessage(opts) {
        const chunks = chunkText(opts.text, 4096);
        let lastResult = { ok: false, error: "No chunks to send" };
        for (const chunk of chunks) {
          const body = {
            messaging_product: "whatsapp",
            to: opts.to,
            type: "text",
            text: { body: chunk }
          };
          if (opts.replyToMessageId) {
            body.context = { message_id: opts.replyToMessageId };
          }
          try {
            const resp = await fetch(`${this.baseUrl}/messages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.accessToken}`
              },
              body: JSON.stringify(body)
            });
            const data = await resp.json();
            if (!resp.ok) {
              const errMsg = data?.error?.message || `HTTP ${resp.status}`;
              return { ok: false, error: errMsg };
            }
            const msgId = data?.messages?.[0]?.id;
            lastResult = { ok: true, messageId: msgId };
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            };
          }
        }
        return lastResult;
      }
      /**
       * Mark a message as read (send read receipt).
       */
      async markAsRead(messageId) {
        try {
          const resp = await fetch(`${this.baseUrl}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.accessToken}`
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              status: "read",
              message_id: messageId
            })
          });
          if (!resp.ok) {
            const data = await resp.json();
            return {
              ok: false,
              error: data?.error?.message || `HTTP ${resp.status}`
            };
          }
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }
      /**
       * Verify webhook signature (HMAC-SHA256 with X-Hub-Signature-256).
       * Returns true if valid or if no appSecret is configured (skip verification).
       */
      verifyWebhookSignature(rawBody, signatureHeader) {
        if (!this.appSecret) return true;
        if (!signatureHeader) return false;
        const expected = "sha256=" + createHmac("sha256", this.appSecret).update(rawBody).digest("hex");
        return signatureHeader === expected;
      }
      /**
       * Verify GET challenge-response for webhook subscription.
       */
      verifyChallenge(params) {
        const mode = params["hub.mode"];
        const token = params["hub.verify_token"];
        const challenge = params["hub.challenge"];
        if (mode === "subscribe" && token === this.verifyToken) {
          return { ok: true, challenge };
        }
        return { ok: false };
      }
    };
  }
});

// src/frontends/whatsapp-frontend.ts
var WhatsAppFrontend;
var init_whatsapp_frontend = __esm({
  "src/frontends/whatsapp-frontend.ts"() {
    init_client();
    init_markdown();
    WhatsAppFrontend = class {
      name = "whatsapp";
      subs = [];
      cfg;
      errorNotified = false;
      constructor(config) {
        this.cfg = config || {};
      }
      start(ctx) {
        const bus = ctx.eventBus;
        try {
          ctx.logger.info(`[whatsapp-frontend] started`);
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
      getWhatsApp(ctx) {
        const injected = ctx.whatsapp || ctx.whatsappClient;
        if (injected) return injected;
        try {
          const token = this.cfg.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
          const phoneId = this.cfg.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
          if (typeof token === "string" && token.trim() && typeof phoneId === "string" && phoneId.trim()) {
            return new WhatsAppClient({
              accessToken: token.trim(),
              phoneNumberId: phoneId.trim()
            });
          }
        } catch {
        }
        return void 0;
      }
      getInboundWhatsAppPayload(ctx) {
        try {
          const endpoint = "/bots/whatsapp/message";
          return ctx.webhookContext?.webhookData?.get(endpoint) || null;
        } catch {
          return null;
        }
      }
      async maybePostError(ctx, title, message, checkId) {
        if (this.errorNotified) return;
        const whatsapp = this.getWhatsApp(ctx);
        if (!whatsapp) return;
        const payload = this.getInboundWhatsAppPayload(ctx);
        const ev = payload?.event;
        const from = ev?.from;
        if (!from) return;
        let text = `${title}`;
        if (checkId) text += `
Check: ${checkId}`;
        if (message) text += `
${message}`;
        await whatsapp.sendMessage({
          to: from,
          text,
          replyToMessageId: ev?.message_id
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
          if (isAi) {
            const schema = checkCfg.schema;
            if (typeof schema === "string") {
              const simpleSchemas = ["code-review", "markdown", "text", "plain"];
              if (!simpleSchemas.includes(schema)) return;
            }
          }
          const whatsapp = this.getWhatsApp(ctx);
          if (!whatsapp) return;
          const payload = this.getInboundWhatsAppPayload(ctx);
          const ev = payload?.event;
          const from = ev?.from;
          if (!from) {
            ctx.logger.warn(
              `[whatsapp-frontend] skip posting reply for ${checkId}: missing from number`
            );
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
              `[whatsapp-frontend] skip posting reply for ${checkId}: no renderable text`
            );
            return;
          }
          text = text.replace(/\\n/g, "\n");
          const formattedText = formatWhatsAppText(text);
          const postResult = await whatsapp.sendMessage({
            to: from,
            text: formattedText,
            replyToMessageId: ev?.message_id
          });
          if (!postResult.ok) {
            ctx.logger.warn(
              `[whatsapp-frontend] failed to post reply for ${checkId}: ${postResult.error}`
            );
            return;
          }
          ctx.logger.info(
            `[whatsapp-frontend] posted reply for ${checkId} to ${from} (messageId=${postResult.messageId})`
          );
        } catch (err) {
          try {
            ctx.logger.warn(
              `[whatsapp-frontend] maybePostDirectReply failed for ${checkId}: ${err instanceof Error ? err.message : String(err)}`
            );
          } catch {
          }
        }
      }
    };
  }
});
init_whatsapp_frontend();
export {
  WhatsAppFrontend
};
//# sourceMappingURL=whatsapp-frontend-72XEIUIR.mjs.map