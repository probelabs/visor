// Email message adapter.
// Normalizes EmailMessage into Visor's shared ConversationContext format,
// mirroring the pattern from src/telegram/adapter.ts.
// Manages in-memory thread state for email conversation tracking.

import type { ConversationContext, NormalizedMessage } from '../types/bot';
import type { EmailMessage } from './client';
import { EmailClient } from './client';

/** Thread state tracking */
export interface EmailThread {
  threadId: string; // SHA-256(root Message-ID)[0:16]
  rootMessageId: string; // first Message-ID in the chain
  messageIds: string[]; // all Message-IDs in order
  messages: NormalizedMessage[];
  participants: Set<string>;
  subject: string;
  lastActivity: Date;
}

export class EmailAdapter {
  private fromAddress: string;
  private threads: Map<string, EmailThread> = new Map(); // threadId -> thread
  private messageIdToThread: Map<string, string> = new Map(); // Message-ID -> threadId

  constructor(fromAddress: string) {
    this.fromAddress = fromAddress.toLowerCase();
  }

  /** Extract email address from "Name <email>" format */
  static extractEmail(addr: string): string {
    const match = /<([^>]+)>/.exec(addr);
    return (match ? match[1] : addr).toLowerCase().trim();
  }

  /** Check if a message is from the bot */
  isFromBot(msg: EmailMessage): boolean {
    const from = EmailAdapter.extractEmail(msg.from);
    const bot = EmailAdapter.extractEmail(this.fromAddress);
    return from === bot;
  }

  /** Find or create a thread for a message */
  getOrCreateThread(msg: EmailMessage): EmailThread {
    // Check if this message's ID is already tracked
    const existingId = this.messageIdToThread.get(msg.messageId);
    if (existingId && this.threads.has(existingId)) {
      return this.threads.get(existingId)!;
    }

    // Check if we can find the thread via In-Reply-To
    if (msg.inReplyTo) {
      const parentThreadId = this.messageIdToThread.get(msg.inReplyTo);
      if (parentThreadId && this.threads.has(parentThreadId)) {
        return this.threads.get(parentThreadId)!;
      }
    }

    // Check References chain (walk from end to start to find existing thread)
    if (msg.references && msg.references.length > 0) {
      for (let i = msg.references.length - 1; i >= 0; i--) {
        const refThreadId = this.messageIdToThread.get(msg.references[i]);
        if (refThreadId && this.threads.has(refThreadId)) {
          return this.threads.get(refThreadId)!;
        }
      }
    }

    // No existing thread found — create new one
    // Root is the first message in References, or this message itself
    const rootMessageId =
      msg.references && msg.references.length > 0 ? msg.references[0] : msg.messageId;
    const threadId = EmailClient.deriveThreadId(rootMessageId);

    const thread: EmailThread = {
      threadId,
      rootMessageId,
      messageIds: [],
      messages: [],
      participants: new Set<string>(),
      subject: msg.subject,
      lastActivity: msg.date,
    };

    this.threads.set(threadId, thread);
    return thread;
  }

  /** Register a message in its thread and return updated thread */
  trackMessage(msg: EmailMessage): EmailThread {
    const thread = this.getOrCreateThread(msg);

    // Don't double-register
    if (thread.messageIds.includes(msg.messageId)) {
      thread.lastActivity = msg.date;
      return thread;
    }

    thread.messageIds.push(msg.messageId);
    this.messageIdToThread.set(msg.messageId, thread.threadId);

    // Also register all references so future lookups work
    if (msg.references) {
      for (const ref of msg.references) {
        if (!this.messageIdToThread.has(ref)) {
          this.messageIdToThread.set(ref, thread.threadId);
        }
      }
    }

    const normalized = this.normalizeMessage(msg);
    thread.messages.push(normalized);
    thread.participants.add(EmailAdapter.extractEmail(msg.from));
    for (const to of msg.to) {
      thread.participants.add(EmailAdapter.extractEmail(to));
    }
    thread.lastActivity = msg.date;

    return thread;
  }

  /** Normalize an EmailMessage to NormalizedMessage */
  normalizeMessage(msg: EmailMessage): NormalizedMessage {
    const isBot = this.isFromBot(msg);
    return {
      role: isBot ? 'bot' : 'user',
      text: msg.text || '',
      timestamp: msg.date.toISOString(),
      origin: isBot ? 'visor' : undefined,
      user: EmailAdapter.extractEmail(msg.from),
    };
  }

  /** Build ConversationContext from an EmailMessage */
  buildConversationContext(msg: EmailMessage): ConversationContext {
    const thread = this.trackMessage(msg);
    const current = this.normalizeMessage(msg);

    return {
      transport: 'email',
      thread: {
        id: thread.threadId,
      },
      messages: [...thread.messages],
      current,
      attributes: {
        thread_id: thread.threadId,
        message_id: msg.messageId,
        from: msg.from,
        to: msg.to.join(', '),
        subject: msg.subject,
        ...(msg.inReplyTo ? { in_reply_to: msg.inReplyTo } : {}),
        ...(msg.cc && msg.cc.length > 0 ? { cc: msg.cc.join(', ') } : {}),
      },
    };
  }

  /** Get thread state by ID */
  getThread(threadId: string): EmailThread | undefined {
    return this.threads.get(threadId);
  }

  /** Get thread by Message-ID */
  getThreadByMessageId(messageId: string): EmailThread | undefined {
    const threadId = this.messageIdToThread.get(messageId);
    if (threadId) return this.threads.get(threadId);
    return undefined;
  }

  /** Clean up old threads to prevent memory leaks */
  cleanupOldThreads(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [threadId, thread] of this.threads.entries()) {
      if (now - thread.lastActivity.getTime() > maxAgeMs) {
        // Remove all message ID references
        for (const mid of thread.messageIds) {
          this.messageIdToThread.delete(mid);
        }
        this.threads.delete(threadId);
      }
    }
  }
}
