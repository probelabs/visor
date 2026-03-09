// WhatsApp Cloud API client.
// Wraps Graph API calls behind a clean interface.
// Uses fetch directly (no npm dependency — Meta's official SDK is archived).

import { createHmac } from 'crypto';
import { chunkText } from './markdown';

export interface WhatsAppSendResult {
  ok: boolean;
  messageId?: string; // wamid.* format
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
  apiVersion?: string; // default 'v21.0'
}

export class WhatsAppClient {
  private accessToken: string;
  private phoneNumberId: string;
  private appSecret?: string;
  private verifyToken?: string;
  private baseUrl: string;

  constructor(opts: WhatsAppClientOptions) {
    if (!opts.accessToken || typeof opts.accessToken !== 'string') {
      throw new Error('WhatsAppClient: accessToken is required');
    }
    if (!opts.phoneNumberId || typeof opts.phoneNumberId !== 'string') {
      throw new Error('WhatsAppClient: phoneNumberId is required');
    }
    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.appSecret = opts.appSecret;
    this.verifyToken = opts.verifyToken;
    const version = opts.apiVersion || 'v21.0';
    this.baseUrl = `https://graph.facebook.com/${version}/${this.phoneNumberId}`;
  }

  /** Get the Phone Number ID */
  getPhoneNumberId(): string {
    return this.phoneNumberId;
  }

  /**
   * Send a text message. Auto-chunks at 4096 characters.
   */
  async sendMessage(opts: {
    to: string;
    text: string;
    replyToMessageId?: string;
  }): Promise<WhatsAppSendResult> {
    const chunks = chunkText(opts.text, 4096);
    let lastResult: WhatsAppSendResult = { ok: false, error: 'No chunks to send' };

    for (const chunk of chunks) {
      const body: any = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'text',
        text: { body: chunk },
      };

      // Add quoted reply context
      if (opts.replyToMessageId) {
        body.context = { message_id: opts.replyToMessageId };
      }

      try {
        const resp = await fetch(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify(body),
        });

        const data = await resp.json();

        if (!resp.ok) {
          const errMsg = (data as any)?.error?.message || `HTTP ${resp.status}`;
          return { ok: false, error: errMsg };
        }

        const msgId = (data as any)?.messages?.[0]?.id;
        lastResult = { ok: true, messageId: msgId };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return lastResult;
  }

  /**
   * Mark a message as read (send read receipt).
   */
  async markAsRead(messageId: string): Promise<WhatsAppMessageStatus> {
    try {
      const resp = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      });

      if (!resp.ok) {
        const data = await resp.json();
        return {
          ok: false,
          error: (data as any)?.error?.message || `HTTP ${resp.status}`,
        };
      }

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Verify webhook signature (HMAC-SHA256 with X-Hub-Signature-256).
   * Returns true if valid or if no appSecret is configured (skip verification).
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    if (!this.appSecret) return true; // no secret = skip verification
    if (!signatureHeader) return false;

    const expected = 'sha256=' + createHmac('sha256', this.appSecret).update(rawBody).digest('hex');

    return signatureHeader === expected;
  }

  /**
   * Verify GET challenge-response for webhook subscription.
   */
  verifyChallenge(params: Record<string, string>): {
    ok: boolean;
    challenge?: string;
  } {
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];

    if (mode === 'subscribe' && token === this.verifyToken) {
      return { ok: true, challenge };
    }

    return { ok: false };
  }
}
