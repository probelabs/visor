export interface EmailMessage {
    id: string;
    messageId: string;
    inReplyTo?: string;
    references?: string[];
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
    auth: {
        user: string;
        pass: string;
    };
    secure?: boolean;
    pollInterval?: number;
    folder?: string;
    markRead?: boolean;
}
export interface SmtpConfig {
    host: string;
    port?: number;
    auth: {
        user: string;
        pass: string;
    };
    secure?: boolean;
    from: string;
}
export interface ResendConfig {
    apiKey: string;
    from?: string;
    webhookSecret?: string;
}
type ReceiveBackend = 'imap' | 'resend';
export declare class EmailClient {
    private receiveBackend;
    private sendBackend;
    private imapConfig?;
    private imapClient?;
    private smtpConfig?;
    private smtpTransport?;
    private resendConfig?;
    private resendClient?;
    private fromAddress;
    constructor(opts: {
        receive?: {
            type?: string;
        } & Partial<ImapConfig> & Partial<ResendConfig>;
        send?: {
            type?: string;
        } & Partial<SmtpConfig> & Partial<ResendConfig>;
    });
    /** Get the configured from address */
    getFromAddress(): string;
    /** Get the receive backend type */
    getReceiveBackend(): ReceiveBackend;
    /** Connect to IMAP server */
    connectImap(): Promise<void>;
    /** Fetch unseen messages from IMAP */
    fetchNewMessages(): Promise<EmailMessage[]>;
    /** Disconnect IMAP */
    disconnectImap(): Promise<void>;
    /** Fetch full email content from Resend by ID */
    fetchResendEmail(emailId: string): Promise<EmailMessage | null>;
    /**
     * List received inbound emails from Resend via polling.
     * Uses GET /emails/receiving with cursor-based pagination.
     * Returns email summaries (call fetchResendEmail for full content).
     */
    listReceivedEmails(opts?: {
        limit?: number;
        after?: string;
    }): Promise<{
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
    }>;
    /** Verify Resend webhook signature */
    verifyResendWebhook(payload: string, headers: Record<string, string>): Promise<boolean>;
    /** Send an email via configured backend (SMTP or Resend) */
    sendEmail(opts: EmailSendOptions): Promise<EmailSendResult>;
    private sendViaSmtp;
    private sendViaResend;
    private getSmtpTransport;
    private getResendClient;
    /** Generate a deterministic thread ID from a Message-ID chain */
    static deriveThreadId(rootMessageId: string): string;
}
export {};
//# sourceMappingURL=client.d.ts.map