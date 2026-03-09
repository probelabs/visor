import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/email/client.ts
import { createHash, randomUUID } from "crypto";
var EmailClient;
var init_client = __esm({
  "src/email/client.ts"() {
    "use strict";
    EmailClient = class {
      receiveBackend;
      sendBackend;
      // IMAP
      imapConfig;
      imapClient;
      // ImapFlow instance (lazily created)
      // SMTP
      smtpConfig;
      smtpTransport;
      // nodemailer transport
      // Resend
      resendConfig;
      resendClient;
      // Resend instance
      fromAddress;
      constructor(opts) {
        this.receiveBackend = opts.receive?.type || "imap";
        this.sendBackend = opts.send?.type || "smtp";
        if (this.receiveBackend === "imap" && opts.receive) {
          const r = opts.receive;
          if (!r.host && !process.env.EMAIL_IMAP_HOST) {
            throw new Error("IMAP host is required (set receive.host or EMAIL_IMAP_HOST)");
          }
          this.imapConfig = {
            host: r.host || process.env.EMAIL_IMAP_HOST,
            port: r.port || parseInt(process.env.EMAIL_IMAP_PORT || "993"),
            auth: {
              user: r.auth?.user || process.env.EMAIL_USER || "",
              pass: r.auth?.pass || process.env.EMAIL_PASSWORD || ""
            },
            secure: r.secure ?? true,
            pollInterval: r.pollInterval || parseInt(process.env.EMAIL_POLL_INTERVAL || "30"),
            folder: r.folder || "INBOX",
            markRead: r.markRead ?? true
          };
        }
        if (this.receiveBackend === "resend") {
          const r = opts.receive;
          const apiKey = r.api_key || r.apiKey || process.env.RESEND_API_KEY;
          if (!apiKey) throw new Error("Resend API key is required for receive");
          this.resendConfig = {
            apiKey,
            webhookSecret: r.webhook_secret || r.webhookSecret || process.env.RESEND_WEBHOOK_SECRET
          };
        }
        if (this.sendBackend === "smtp") {
          const s = opts.send;
          if (!s.host && !process.env.EMAIL_SMTP_HOST) {
            throw new Error("SMTP host is required (set send.host or EMAIL_SMTP_HOST)");
          }
          this.smtpConfig = {
            host: s.host || process.env.EMAIL_SMTP_HOST,
            port: s.port || parseInt(process.env.EMAIL_SMTP_PORT || "587"),
            auth: {
              user: s.auth?.user || process.env.EMAIL_USER || "",
              pass: s.auth?.pass || process.env.EMAIL_PASSWORD || ""
            },
            secure: s.secure ?? true,
            from: s.from || process.env.EMAIL_FROM || ""
          };
        }
        if (this.sendBackend === "resend") {
          const s = opts.send;
          const apiKey = s.api_key || s.apiKey || process.env.RESEND_API_KEY;
          if (!apiKey) throw new Error("Resend API key is required for send");
          if (!this.resendConfig) {
            this.resendConfig = { apiKey };
          }
          this.resendConfig.from = s.from || process.env.EMAIL_FROM;
        }
        this.fromAddress = opts.send?.from || process.env.EMAIL_FROM || this.smtpConfig?.from || this.resendConfig?.from || "";
      }
      /** Get the configured from address */
      getFromAddress() {
        return this.fromAddress;
      }
      /** Get the receive backend type */
      getReceiveBackend() {
        return this.receiveBackend;
      }
      // ─── IMAP Receive ───
      /** Connect to IMAP server */
      async connectImap() {
        if (this.receiveBackend !== "imap" || !this.imapConfig) return;
        const { ImapFlow } = await import("imapflow");
        this.imapClient = new ImapFlow({
          host: this.imapConfig.host,
          port: this.imapConfig.port || 993,
          secure: this.imapConfig.secure ?? true,
          auth: this.imapConfig.auth,
          logger: false
        });
        await this.imapClient.connect();
      }
      /** Fetch unseen messages from IMAP */
      async fetchNewMessages() {
        if (!this.imapClient || !this.imapConfig) return [];
        const { simpleParser } = await import("mailparser");
        const lock = await this.imapClient.getMailboxLock(this.imapConfig.folder || "INBOX");
        try {
          const messages = [];
          for await (const msg of this.imapClient.fetch({ seen: false }, { source: true, uid: true })) {
            const parsed = await simpleParser(msg.source);
            const messageId = parsed.messageId || `<${randomUUID()}@visor>`;
            const inReplyTo = typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : void 0;
            const references = parsed.references ? Array.isArray(parsed.references) ? parsed.references : [parsed.references] : void 0;
            messages.push({
              id: String(msg.uid),
              messageId,
              inReplyTo,
              references,
              from: typeof parsed.from?.text === "string" ? parsed.from.text : "",
              to: parsed.to ? Array.isArray(parsed.to) ? parsed.to.map((a) => a.text || "") : [parsed.to.text || ""] : [],
              cc: parsed.cc ? Array.isArray(parsed.cc) ? parsed.cc.map((a) => a.text || "") : [parsed.cc.text || ""] : void 0,
              subject: parsed.subject || "",
              text: parsed.text || "",
              html: parsed.html || void 0,
              date: parsed.date || /* @__PURE__ */ new Date()
            });
            if (this.imapConfig.markRead !== false) {
              try {
                await this.imapClient.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
              } catch {
              }
            }
          }
          return messages;
        } finally {
          lock.release();
        }
      }
      /** Disconnect IMAP */
      async disconnectImap() {
        if (this.imapClient) {
          try {
            await this.imapClient.logout();
          } catch {
          }
          this.imapClient = void 0;
        }
      }
      // ─── Resend Receive ───
      /** Fetch full email content from Resend by ID */
      async fetchResendEmail(emailId) {
        try {
          const resend = await this.getResendClient();
          const result = await resend.emails.get(emailId);
          const email = result.data || result;
          if (!email) return null;
          const headers = {};
          if (Array.isArray(email.headers)) {
            for (const h of email.headers) {
              if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
            }
          } else if (email.headers && typeof email.headers === "object") {
            for (const [k, v] of Object.entries(email.headers)) {
              headers[k.toLowerCase()] = String(v);
            }
          }
          const references = headers["references"] ? headers["references"].split(/\s+/).filter(Boolean) : void 0;
          return {
            id: emailId,
            messageId: headers["message-id"] || `<${emailId}@resend>`,
            inReplyTo: headers["in-reply-to"] || void 0,
            references,
            from: typeof email.from === "string" ? email.from : email.from?.email || "",
            to: Array.isArray(email.to) ? email.to.map((t) => typeof t === "string" ? t : t?.email || "") : [String(email.to || "")],
            subject: email.subject || "",
            text: email.text || email.body || "",
            html: email.html || void 0,
            date: email.created_at ? new Date(email.created_at) : /* @__PURE__ */ new Date()
          };
        } catch (err) {
          console.warn(`[EmailClient] Failed to fetch Resend email ${emailId}: ${err}`);
          return null;
        }
      }
      /**
       * List received inbound emails from Resend via polling.
       * Uses GET /emails/receiving with cursor-based pagination.
       * Returns email summaries (call fetchResendEmail for full content).
       */
      async listReceivedEmails(opts) {
        if (!this.resendConfig?.apiKey) {
          return { emails: [], hasMore: false };
        }
        try {
          const params = new URLSearchParams();
          if (opts?.limit) params.set("limit", String(opts.limit));
          if (opts?.after) params.set("after", opts.after);
          const qs = params.toString();
          const url = `https://api.resend.com/emails/receiving${qs ? `?${qs}` : ""}`;
          const resp = await fetch(url, {
            headers: {
              Authorization: `Bearer ${this.resendConfig.apiKey}`,
              "Content-Type": "application/json"
            }
          });
          if (!resp.ok) {
            console.warn(
              `[EmailClient] Resend list received failed: ${resp.status} ${resp.statusText}`
            );
            return { emails: [], hasMore: false };
          }
          const body = await resp.json();
          const data = Array.isArray(body.data) ? body.data : [];
          const emails = data.map((e) => ({
            id: e.id,
            from: typeof e.from === "string" ? e.from : e.from?.email || "",
            to: Array.isArray(e.to) ? e.to.map((t) => typeof t === "string" ? t : t?.email || "") : [],
            subject: e.subject || "",
            created_at: e.created_at || "",
            message_id: e.message_id
          }));
          const lastId = emails.length > 0 ? emails[emails.length - 1].id : void 0;
          return {
            emails,
            hasMore: !!body.has_more,
            lastId
          };
        } catch (err) {
          console.warn(`[EmailClient] Resend list received error: ${err}`);
          return { emails: [], hasMore: false };
        }
      }
      /** Verify Resend webhook signature */
      async verifyResendWebhook(payload, headers) {
        if (!this.resendConfig?.webhookSecret) return true;
        try {
          const { Webhook } = await import("./dist-NERCHNRR.mjs");
          const wh = new Webhook(this.resendConfig.webhookSecret);
          wh.verify(payload, {
            "svix-id": headers["svix-id"] || "",
            "svix-timestamp": headers["svix-timestamp"] || "",
            "svix-signature": headers["svix-signature"] || ""
          });
          return true;
        } catch {
          return false;
        }
      }
      // ─── Send ───
      /** Send an email via configured backend (SMTP or Resend) */
      async sendEmail(opts) {
        const messageId = opts.messageId || `<${randomUUID()}@visor>`;
        if (this.sendBackend === "resend") {
          return this.sendViaResend(opts, messageId);
        }
        return this.sendViaSmtp(opts, messageId);
      }
      async sendViaSmtp(opts, messageId) {
        try {
          const transport = await this.getSmtpTransport();
          const to = Array.isArray(opts.to) ? opts.to.join(", ") : opts.to;
          const mailOpts = {
            from: this.fromAddress,
            to,
            subject: opts.subject,
            text: opts.text,
            messageId
          };
          if (opts.html) mailOpts.html = opts.html;
          if (opts.inReplyTo) mailOpts.inReplyTo = opts.inReplyTo;
          if (opts.references && opts.references.length > 0) {
            mailOpts.references = opts.references.join(" ");
          }
          const info = await transport.sendMail(mailOpts);
          return {
            ok: true,
            messageId: info.messageId || messageId
          };
        } catch (err) {
          const errMsg = err?.message || String(err);
          console.warn(`[EmailClient] SMTP send failed: ${errMsg}`);
          return { ok: false, error: errMsg };
        }
      }
      async sendViaResend(opts, messageId) {
        try {
          const resend = await this.getResendClient();
          const to = Array.isArray(opts.to) ? opts.to : [opts.to];
          const headers = {};
          headers["Message-ID"] = messageId;
          if (opts.inReplyTo) headers["In-Reply-To"] = opts.inReplyTo;
          if (opts.references && opts.references.length > 0) {
            headers["References"] = opts.references.join(" ");
          }
          const sendOpts = {
            from: this.fromAddress,
            to,
            subject: opts.subject,
            text: opts.text,
            headers
          };
          if (opts.html) sendOpts.html = opts.html;
          const result = await resend.emails.send(sendOpts);
          const data = result.data || result;
          return {
            ok: true,
            messageId: data?.id ? `<${data.id}@resend>` : messageId
          };
        } catch (err) {
          const errMsg = err?.message || String(err);
          console.warn(`[EmailClient] Resend send failed: ${errMsg}`);
          return { ok: false, error: errMsg };
        }
      }
      // ─── Lazy initialization helpers ───
      async getSmtpTransport() {
        if (this.smtpTransport) return this.smtpTransport;
        const nodemailer = await import("nodemailer");
        this.smtpTransport = nodemailer.createTransport({
          host: this.smtpConfig.host,
          port: this.smtpConfig.port || 587,
          secure: this.smtpConfig.secure ?? true,
          auth: this.smtpConfig.auth
        });
        return this.smtpTransport;
      }
      async getResendClient() {
        if (this.resendClient) return this.resendClient;
        const { Resend } = await import("resend");
        this.resendClient = new Resend(this.resendConfig.apiKey);
        return this.resendClient;
      }
      /** Generate a deterministic thread ID from a Message-ID chain */
      static deriveThreadId(rootMessageId) {
        return createHash("sha256").update(rootMessageId).digest("hex").slice(0, 16);
      }
    };
  }
});

// src/email/markdown.ts
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function markdownToEmailHtml(text) {
  if (!text || typeof text !== "string") return "";
  const lines = text.split(/\r?\n/);
  const result = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines = [];
  let inBlockquote = false;
  let blockquoteLines = [];
  const listStack = [];
  const flushBlockquote = () => {
    if (blockquoteLines.length > 0) {
      result.push(
        `<blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#555;">${blockquoteLines.join("<br>")}</blockquote>`
      );
      blockquoteLines = [];
      inBlockquote = false;
    }
  };
  const flushList = () => {
    while (listStack.length > 0) {
      const tag = listStack.pop();
      result.push(`</${tag}>`);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^```/.test(trimmed)) {
      if (!inCodeBlock) {
        flushBlockquote();
        flushList();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        const escaped = codeLines.map((l) => escapeHtml(l)).join("\n");
        const langAttr = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : "";
        result.push(
          `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;"><code${langAttr}>${escaped}</code></pre>`
        );
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
      flushList();
      inBlockquote = true;
      blockquoteLines.push(convertInline(bqMatch[1]));
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(lines[i]);
    if (bulletMatch) {
      if (listStack.length === 0 || listStack[listStack.length - 1] !== "ul") {
        flushList();
        listStack.push("ul");
        result.push('<ul style="margin:4px 0;padding-left:24px;">');
      }
      result.push(`<li>${convertInline(bulletMatch[3])}</li>`);
      continue;
    }
    const numMatch = /^(\s*)(\d+)\.\s+(.+)$/.exec(lines[i]);
    if (numMatch) {
      if (listStack.length === 0 || listStack[listStack.length - 1] !== "ol") {
        flushList();
        listStack.push("ol");
        result.push('<ol style="margin:4px 0;padding-left:24px;">');
      }
      result.push(`<li>${convertInline(numMatch[3])}</li>`);
      continue;
    }
    if (listStack.length > 0) flushList();
    const line = lines[i];
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line.trimStart());
    if (headerMatch) {
      const level = headerMatch[1].length;
      const sizes = {
        1: "24px",
        2: "20px",
        3: "18px",
        4: "16px",
        5: "14px",
        6: "13px"
      };
      result.push(
        `<h${level} style="font-size:${sizes[level]};margin:16px 0 8px 0;">${convertInline(headerMatch[2].trim())}</h${level}>`
      );
      continue;
    }
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      result.push('<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">');
      continue;
    }
    if (trimmed === "") {
      result.push("<br>");
      continue;
    }
    result.push(`<p style="margin:4px 0;">${convertInline(line)}</p>`);
  }
  if (inCodeBlock && codeLines.length > 0) {
    const escaped = codeLines.map((l) => escapeHtml(l)).join("\n");
    result.push(
      `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;"><code>${escaped}</code></pre>`
    );
  }
  flushBlockquote();
  flushList();
  return result.join("\n");
}
function convertInline(line) {
  const codeSpans = [];
  let processed = line.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSpans.length;
    codeSpans.push(
      `<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:13px;">${escapeHtml(code)}</code>`
    );
    return `\0CODE${idx}\0`;
  });
  processed = escapeHtml(processed);
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt, url) => `<img src="${url}" alt="${alt || "image"}" style="max-width:100%;">`
  );
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, label, url) => `<a href="${url}" style="color:#0066cc;">${label}</a>`
  );
  processed = processed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  processed = processed.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  processed = processed.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  processed = processed.replace(
    /\x00CODE(\d+)\x00/g,
    (_m, idx) => codeSpans[parseInt(idx)]
  );
  return processed;
}
function wrapInEmailTemplate(bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#333;max-width:600px;margin:0 auto;padding:16px;">
${bodyHtml}
</body>
</html>`;
}
function addRePrefix(subject) {
  if (!subject) return "Re:";
  if (/^Re:/i.test(subject.trim())) return subject.trim();
  return `Re: ${subject.trim()}`;
}
function formatEmailText(text) {
  return markdownToEmailHtml(text);
}
var init_markdown = __esm({
  "src/email/markdown.ts"() {
    "use strict";
  }
});

// src/frontends/email-frontend.ts
var EmailFrontend;
var init_email_frontend = __esm({
  "src/frontends/email-frontend.ts"() {
    init_client();
    init_markdown();
    EmailFrontend = class {
      name = "email";
      subs = [];
      cfg;
      errorNotified = false;
      constructor(config) {
        this.cfg = config || {};
      }
      start(ctx) {
        const bus = ctx.eventBus;
        try {
          ctx.logger.info(`[email-frontend] started`);
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
      getEmailClient(ctx) {
        const injected = ctx.emailClient;
        if (injected) return injected;
        try {
          const emailConfig = ctx.webhookContext?.webhookData?.get("/bots/email/message");
          const sendCfg = this.cfg.send || emailConfig?.sendConfig;
          if (sendCfg || process.env.EMAIL_SMTP_HOST || process.env.RESEND_API_KEY) {
            return new EmailClient({
              send: sendCfg || {
                type: process.env.RESEND_API_KEY ? "resend" : "smtp"
              }
            });
          }
        } catch {
        }
        return void 0;
      }
      getInboundEmailPayload(ctx) {
        try {
          const endpoint = "/bots/email/message";
          return ctx.webhookContext?.webhookData?.get(endpoint) || null;
        } catch {
          return null;
        }
      }
      async maybePostError(ctx, title, message, checkId) {
        if (this.errorNotified) return;
        const client = this.getEmailClient(ctx);
        if (!client) return;
        const payload = this.getInboundEmailPayload(ctx);
        const ev = payload?.event;
        if (!ev?.from) return;
        let text = `${title}`;
        if (checkId) text += `
Check: ${checkId}`;
        if (message) text += `
${message}`;
        const sendOpts = {
          to: ev.from,
          subject: ev.subject ? addRePrefix(ev.subject) : `Visor: ${title}`,
          text,
          html: wrapInEmailTemplate(`<p><strong>${title}</strong></p><p>${message}</p>`)
        };
        if (ev.messageId) {
          sendOpts.inReplyTo = ev.messageId;
          sendOpts.references = ev.references ? [...ev.references, ev.messageId] : [ev.messageId];
        }
        await client.sendEmail(sendOpts);
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
          const client = this.getEmailClient(ctx);
          if (!client) return;
          const payload = this.getInboundEmailPayload(ctx);
          const ev = payload?.event;
          if (!ev?.from) {
            ctx.logger.warn(`[email-frontend] skip posting reply for ${checkId}: missing from address`);
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
            ctx.logger.info(`[email-frontend] skip posting reply for ${checkId}: no renderable text`);
            return;
          }
          text = text.replace(/\\n/g, "\n");
          const htmlBody = formatEmailText(text);
          const sendOpts = {
            to: ev.from,
            subject: ev.subject ? addRePrefix(ev.subject) : `Re: Visor response`,
            text,
            html: wrapInEmailTemplate(htmlBody)
          };
          if (ev.messageId) {
            sendOpts.inReplyTo = ev.messageId;
            sendOpts.references = ev.references ? [...ev.references, ev.messageId] : [ev.messageId];
          }
          const sendResult = await client.sendEmail(sendOpts);
          if (!sendResult.ok) {
            ctx.logger.warn(
              `[email-frontend] failed to send reply for ${checkId}: ${sendResult.error}`
            );
            return;
          }
          ctx.logger.info(
            `[email-frontend] sent reply for ${checkId} to ${ev.from} (messageId=${sendResult.messageId})`
          );
        } catch (err) {
          try {
            ctx.logger.warn(
              `[email-frontend] maybePostDirectReply failed for ${checkId}: ${err instanceof Error ? err.message : String(err)}`
            );
          } catch {
          }
        }
      }
    };
  }
});
init_email_frontend();
export {
  EmailFrontend
};
//# sourceMappingURL=email-frontend-6JU4L33L.mjs.map