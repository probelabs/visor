export interface WhatsAppSendResult {
    ok: boolean;
    messageId?: string;
    error?: string;
}
export interface WhatsAppMessageStatus {
    ok: boolean;
    error?: string;
}
export interface WhatsAppClientOptions {
    accessToken: string;
    phoneNumberId: string;
    appSecret?: string;
    verifyToken?: string;
    apiVersion?: string;
}
export declare class WhatsAppClient {
    private accessToken;
    private phoneNumberId;
    private appSecret?;
    private verifyToken?;
    private baseUrl;
    constructor(opts: WhatsAppClientOptions);
    /** Get the Phone Number ID */
    getPhoneNumberId(): string;
    /**
     * Send a text message. Auto-chunks at 4096 characters.
     */
    sendMessage(opts: {
        to: string;
        text: string;
        replyToMessageId?: string;
    }): Promise<WhatsAppSendResult>;
    /**
     * Mark a message as read (send read receipt).
     */
    markAsRead(messageId: string): Promise<WhatsAppMessageStatus>;
    /**
     * Verify webhook signature (HMAC-SHA256 with X-Hub-Signature-256).
     * Returns true if valid or if no appSecret is configured (skip verification).
     */
    verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
    /**
     * Verify GET challenge-response for webhook subscription.
     */
    verifyChallenge(params: Record<string, string>): {
        ok: boolean;
        challenge?: string;
    };
}
//# sourceMappingURL=client.d.ts.map