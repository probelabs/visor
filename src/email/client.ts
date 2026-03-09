// Multi-backend email client for Visor.
// Supports IMAP+SMTP (universal) and Resend (managed) for send/receive.
//
// Receive backends:
// - IMAP (imapflow): connect, fetchNewMessages, IDLE for push
// - Resend polling: GET /emails/receiving to list inbound, then GET /emails/{id} for full content
// - Resend webhook: webhook metadata → GET /emails/{id} for full content+headers
//
// Send backends:
// - SMTP (nodemailer): createTransport once, multipart/alternative
// - Resend (resend SDK): resend.emails.send() with threading headers

import { createHash, randomUUID } from 'crypto';

export interface EmailMessage {
  id: string; // internal ID (IMAP UID or Resend email_id)
  messageId: string; // Message-ID header
  inReplyTo?: string; // In-Reply-To header
  references?: string[]; // References header chain
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  date: Date;
}

export interface EmailSendOptions {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
}

export interface EmailSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ImapConfig {
  host: string;
  port?: number;
  auth: { user: string; pass: string };
  secure?: boolean;
  pollInterval?: number; // seconds (default: 30)
  folder?: string; // default: 'INBOX'
  markRead?: boolean; // default: true
}

export interface SmtpConfig {
  host: string;
  port?: number;
  auth: { user: string; pass: string };
  secure?: boolean;
  from: string;
}

export interface ResendConfig {
  apiKey: string;
  from?: string; // for sending
  webhookSecret?: string; // for inbound verification
}

type ReceiveBackend = 'imap' | 'resend';
type SendBackend = 'smtp' | 'resend';

export class EmailClient {
  private receiveBackend: ReceiveBackend;
  private sendBackend: SendBackend;

  // IMAP
  private imapConfig?: ImapConfig;
  private imapClient?: any; // ImapFlow instance (lazily created)

  // SMTP
  private smtpConfig?: SmtpConfig;
  private smtpTransport?: any; // nodemailer transport

  // Resend
  private resendConfig?: ResendConfig;
  private resendClient?: any; // Resend instance

  private fromAddress: string;

  constructor(opts: {
    receive?: { type?: string } & Partial<ImapConfig> & Partial<ResendConfig>;
    send?: { type?: string } & Partial<SmtpConfig> & Partial<ResendConfig>;
  }) {
    this.receiveBackend = (opts.receive?.type as ReceiveBackend) || 'imap';
    this.sendBackend = (opts.send?.type as SendBackend) || 'smtp';

    // Configure IMAP (only when receive config is provided)
    if (this.receiveBackend === 'imap' && opts.receive) {
      const r = opts.receive;
      if (!r.host && !process.env.EMAIL_IMAP_HOST) {
        throw new Error('IMAP host is required (set receive.host or EMAIL_IMAP_HOST)');
      }
      this.imapConfig = {
        host: r.host || process.env.EMAIL_IMAP_HOST!,
        port: r.port || parseInt(process.env.EMAIL_IMAP_PORT || '993'),
        auth: {
          user: r.auth?.user || process.env.EMAIL_USER || '',
          pass: r.auth?.pass || process.env.EMAIL_PASSWORD || '',
        },
        secure: r.secure ?? true,
        pollInterval: r.pollInterval || parseInt(process.env.EMAIL_POLL_INTERVAL || '30'),
        folder: r.folder || 'INBOX',
        markRead: r.markRead ?? true,
      };
    }

    // Configure Resend for receive
    if (this.receiveBackend === 'resend') {
      const r = opts.receive!;
      const apiKey = (r as any).api_key || r.apiKey || process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error('Resend API key is required for receive');
      this.resendConfig = {
        apiKey,
        webhookSecret:
          (r as any).webhook_secret || r.webhookSecret || process.env.RESEND_WEBHOOK_SECRET,
      };
    }

    // Configure SMTP
    if (this.sendBackend === 'smtp') {
      const s = opts.send!;
      if (!s.host && !process.env.EMAIL_SMTP_HOST) {
        throw new Error('SMTP host is required (set send.host or EMAIL_SMTP_HOST)');
      }
      this.smtpConfig = {
        host: s.host || process.env.EMAIL_SMTP_HOST!,
        port: s.port || parseInt(process.env.EMAIL_SMTP_PORT || '587'),
        auth: {
          user: s.auth?.user || process.env.EMAIL_USER || '',
          pass: s.auth?.pass || process.env.EMAIL_PASSWORD || '',
        },
        secure: s.secure ?? true,
        from: s.from || process.env.EMAIL_FROM || '',
      };
    }

    // Configure Resend for send
    if (this.sendBackend === 'resend') {
      const s = opts.send!;
      const apiKey = (s as any).api_key || s.apiKey || process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error('Resend API key is required for send');
      if (!this.resendConfig) {
        this.resendConfig = { apiKey };
      }
      this.resendConfig.from = s.from || process.env.EMAIL_FROM;
    }

    // Determine from address
    this.fromAddress =
      opts.send?.from ||
      process.env.EMAIL_FROM ||
      this.smtpConfig?.from ||
      this.resendConfig?.from ||
      '';
  }

  /** Get the configured from address */
  getFromAddress(): string {
    return this.fromAddress;
  }

  /** Get the receive backend type */
  getReceiveBackend(): ReceiveBackend {
    return this.receiveBackend;
  }

  // ─── IMAP Receive ───

  /** Connect to IMAP server */
  async connectImap(): Promise<void> {
    if (this.receiveBackend !== 'imap' || !this.imapConfig) return;
    const { ImapFlow } = await import('imapflow');
    this.imapClient = new ImapFlow({
      host: this.imapConfig.host,
      port: this.imapConfig.port || 993,
      secure: this.imapConfig.secure ?? true,
      auth: this.imapConfig.auth,
      logger: false,
    });
    await this.imapClient.connect();
  }

  /** Fetch unseen messages from IMAP */
  async fetchNewMessages(): Promise<EmailMessage[]> {
    if (!this.imapClient || !this.imapConfig) return [];
    const { simpleParser } = await import('mailparser');

    const lock = await this.imapClient.getMailboxLock(this.imapConfig.folder || 'INBOX');
    try {
      const messages: EmailMessage[] = [];
      for await (const msg of this.imapClient.fetch({ seen: false }, { source: true, uid: true })) {
        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId || `<${randomUUID()}@visor>`;
        const inReplyTo = typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : undefined;
        const references = parsed.references
          ? Array.isArray(parsed.references)
            ? parsed.references
            : [parsed.references]
          : undefined;

        messages.push({
          id: String(msg.uid),
          messageId,
          inReplyTo,
          references,
          from: typeof parsed.from?.text === 'string' ? parsed.from.text : '',
          to: parsed.to
            ? Array.isArray(parsed.to)
              ? parsed.to.map((a: any) => a.text || '')
              : [parsed.to.text || '']
            : [],
          cc: parsed.cc
            ? Array.isArray(parsed.cc)
              ? parsed.cc.map((a: any) => a.text || '')
              : [parsed.cc.text || '']
            : undefined,
          subject: parsed.subject || '',
          text: parsed.text || '',
          html: parsed.html || undefined,
          date: parsed.date || new Date(),
        });

        // Mark as read
        if (this.imapConfig.markRead !== false) {
          try {
            await this.imapClient.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
          } catch {}
        }
      }
      return messages;
    } finally {
      lock.release();
    }
  }

  /** Disconnect IMAP */
  async disconnectImap(): Promise<void> {
    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch {}
      this.imapClient = undefined;
    }
  }

  // ─── Resend Receive ───

  /** Fetch full email content from Resend by ID */
  async fetchResendEmail(emailId: string): Promise<EmailMessage | null> {
    try {
      const resend = await this.getResendClient();
      const result = await resend.emails.get(emailId);
      const email: any = (result as any).data || result;
      if (!email) return null;

      // Extract threading headers
      const headers: Record<string, string> = {};
      if (Array.isArray(email.headers)) {
        for (const h of email.headers) {
          if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
        }
      } else if (email.headers && typeof email.headers === 'object') {
        for (const [k, v] of Object.entries(email.headers)) {
          headers[k.toLowerCase()] = String(v);
        }
      }

      const references = headers['references']
        ? headers['references'].split(/\s+/).filter(Boolean)
        : undefined;

      return {
        id: emailId,
        messageId: headers['message-id'] || `<${emailId}@resend>`,
        inReplyTo: headers['in-reply-to'] || undefined,
        references,
        from: typeof email.from === 'string' ? email.from : email.from?.email || '',
        to: Array.isArray(email.to)
          ? email.to.map((t: any) => (typeof t === 'string' ? t : t?.email || ''))
          : [String(email.to || '')],
        subject: email.subject || '',
        text: email.text || email.body || '',
        html: email.html || undefined,
        date: email.created_at ? new Date(email.created_at) : new Date(),
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
  async listReceivedEmails(opts?: { limit?: number; after?: string }): Promise<{
    emails: Array<{
      id: string;
      from: string;
      to: string[];
      subject: string;
      created_at: string;
      message_id?: string;
    }>;
    hasMore: boolean;
    lastId?: string;
  }> {
    if (!this.resendConfig?.apiKey) {
      return { emails: [], hasMore: false };
    }

    try {
      const params = new URLSearchParams();
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.after) params.set('after', opts.after);
      const qs = params.toString();
      const url = `https://api.resend.com/emails/receiving${qs ? `?${qs}` : ''}`;

      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.resendConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!resp.ok) {
        console.warn(
          `[EmailClient] Resend list received failed: ${resp.status} ${resp.statusText}`
        );
        return { emails: [], hasMore: false };
      }

      const body: any = await resp.json();
      const data = Array.isArray(body.data) ? body.data : [];
      const emails = data.map((e: any) => ({
        id: e.id,
        from: typeof e.from === 'string' ? e.from : e.from?.email || '',
        to: Array.isArray(e.to)
          ? e.to.map((t: any) => (typeof t === 'string' ? t : t?.email || ''))
          : [],
        subject: e.subject || '',
        created_at: e.created_at || '',
        message_id: e.message_id,
      }));

      const lastId = emails.length > 0 ? emails[emails.length - 1].id : undefined;
      return {
        emails,
        hasMore: !!body.has_more,
        lastId,
      };
    } catch (err) {
      console.warn(`[EmailClient] Resend list received error: ${err}`);
      return { emails: [], hasMore: false };
    }
  }

  /** Verify Resend webhook signature */
  async verifyResendWebhook(payload: string, headers: Record<string, string>): Promise<boolean> {
    if (!this.resendConfig?.webhookSecret) return true; // no secret = skip verification
    try {
      const { Webhook } = await import('svix');
      const wh = new Webhook(this.resendConfig.webhookSecret);
      wh.verify(payload, {
        'svix-id': headers['svix-id'] || '',
        'svix-timestamp': headers['svix-timestamp'] || '',
        'svix-signature': headers['svix-signature'] || '',
      });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Send ───

  /** Send an email via configured backend (SMTP or Resend) */
  async sendEmail(opts: EmailSendOptions): Promise<EmailSendResult> {
    const messageId = opts.messageId || `<${randomUUID()}@visor>`;

    if (this.sendBackend === 'resend') {
      return this.sendViaResend(opts, messageId);
    }
    return this.sendViaSmtp(opts, messageId);
  }

  private async sendViaSmtp(opts: EmailSendOptions, messageId: string): Promise<EmailSendResult> {
    try {
      const transport = await this.getSmtpTransport();
      const to = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;

      const mailOpts: Record<string, any> = {
        from: this.fromAddress,
        to,
        subject: opts.subject,
        text: opts.text,
        messageId,
      };

      if (opts.html) mailOpts.html = opts.html;
      if (opts.inReplyTo) mailOpts.inReplyTo = opts.inReplyTo;
      if (opts.references && opts.references.length > 0) {
        mailOpts.references = opts.references.join(' ');
      }

      const info = await transport.sendMail(mailOpts);
      return {
        ok: true,
        messageId: info.messageId || messageId,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[EmailClient] SMTP send failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  private async sendViaResend(opts: EmailSendOptions, messageId: string): Promise<EmailSendResult> {
    try {
      const resend = await this.getResendClient();
      const to = Array.isArray(opts.to) ? opts.to : [opts.to];

      const headers: Record<string, string> = {};
      headers['Message-ID'] = messageId;
      if (opts.inReplyTo) headers['In-Reply-To'] = opts.inReplyTo;
      if (opts.references && opts.references.length > 0) {
        headers['References'] = opts.references.join(' ');
      }

      const sendOpts: Record<string, any> = {
        from: this.fromAddress,
        to,
        subject: opts.subject,
        text: opts.text,
        headers,
      };
      if (opts.html) sendOpts.html = opts.html;

      const result = await resend.emails.send(sendOpts);
      const data: any = (result as any).data || result;
      return {
        ok: true,
        messageId: data?.id ? `<${data.id}@resend>` : messageId,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[EmailClient] Resend send failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  // ─── Lazy initialization helpers ───

  private async getSmtpTransport(): Promise<any> {
    if (this.smtpTransport) return this.smtpTransport;
    const nodemailer = await import('nodemailer');
    this.smtpTransport = nodemailer.createTransport({
      host: this.smtpConfig!.host,
      port: this.smtpConfig!.port || 587,
      secure: this.smtpConfig!.secure ?? true,
      auth: this.smtpConfig!.auth,
    });
    return this.smtpTransport;
  }

  private async getResendClient(): Promise<any> {
    if (this.resendClient) return this.resendClient;
    const { Resend } = await import('resend');
    this.resendClient = new Resend(this.resendConfig!.apiKey);
    return this.resendClient;
  }

  /** Generate a deterministic thread ID from a Message-ID chain */
  static deriveThreadId(rootMessageId: string): string {
    return createHash('sha256').update(rootMessageId).digest('hex').slice(0, 16);
  }
}
