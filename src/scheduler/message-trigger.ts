/**
 * Message trigger evaluator for Slack message-based workflow triggers.
 * Pure matching logic — no I/O or Slack API calls.
 */
import type { SlackMessageTrigger } from '../types/config';

/**
 * Incoming message to evaluate against triggers
 */
export interface IncomingMessage {
  channel: string;
  user: string;
  text: string;
  isBot: boolean;
  threadTs?: string;
  ts: string;
}

/**
 * Result of a matched trigger
 */
export interface MatchedTrigger {
  id: string;
  trigger: SlackMessageTrigger;
}

/**
 * Evaluates incoming Slack messages against configured on_message triggers.
 * All specified filters must pass (AND). Within `contains`, any keyword match suffices (OR).
 * Omitted filters are not checked (match all).
 *
 * Instances are **immutable** — regex patterns are compiled once in the constructor.
 * When triggers change (config reload, DB mutation), callers must create a new
 * evaluator instance rather than mutating the existing one. SlackSocketRunner
 * handles this via {@link initMessageTriggersAsync} which rebuilds the evaluator.
 */
export class MessageTriggerEvaluator {
  private triggers: Map<string, SlackMessageTrigger>;
  private regexCache: Map<string, RegExp> = new Map();

  constructor(triggers: Record<string, SlackMessageTrigger>) {
    this.triggers = new Map(Object.entries(triggers));
    // Pre-compile regex patterns
    for (const [id, trigger] of this.triggers) {
      if (trigger.match) {
        try {
          this.regexCache.set(id, new RegExp(trigger.match, 'i'));
        } catch {
          // Invalid regex — will never match
        }
      }
    }
  }

  /**
   * Evaluate a message against all configured triggers.
   * Returns all matching triggers.
   */
  evaluate(message: IncomingMessage): MatchedTrigger[] {
    const matches: MatchedTrigger[] = [];

    for (const [id, trigger] of this.triggers) {
      if (this.matchesTrigger(id, trigger, message)) {
        matches.push({ id, trigger });
      }
    }

    return matches;
  }

  private matchesTrigger(
    id: string,
    trigger: SlackMessageTrigger,
    message: IncomingMessage
  ): boolean {
    // 1. Enabled check
    if (trigger.enabled === false) return false;

    // 2. Thread scope
    if (!this.matchesThreadScope(trigger.threads ?? 'any', message)) return false;

    // 3. Channel match (wildcard support)
    if (!this.matchesChannels(trigger.channels, message.channel)) return false;

    // 4. User match
    if (trigger.from && trigger.from.length > 0) {
      if (!trigger.from.includes(message.user)) return false;
    }

    // 5. Bot filter
    if (message.isBot && !trigger.from_bots) return false;

    // 6. Keyword match (case-insensitive, any match = pass)
    if (trigger.contains && trigger.contains.length > 0) {
      const textLower = message.text.toLowerCase();
      const hasKeyword = trigger.contains.some(kw => textLower.includes(kw.toLowerCase()));
      if (!hasKeyword) return false;
    }

    // 7. Regex match
    if (trigger.match) {
      const re = this.regexCache.get(id);
      if (!re || !re.test(message.text)) return false;
    }

    return true;
  }

  private matchesThreadScope(
    scope: 'root_only' | 'thread_only' | 'any',
    message: IncomingMessage
  ): boolean {
    if (scope === 'any') return true;

    const isThreadReply = !!message.threadTs && message.threadTs !== message.ts;

    if (scope === 'root_only') return !isThreadReply;
    if (scope === 'thread_only') return isThreadReply;

    return true;
  }

  private matchesChannels(channels: string[] | undefined, channel: string): boolean {
    if (!channels || channels.length === 0) return true;
    return channels.some(pat =>
      pat.endsWith('*') ? channel.startsWith(pat.slice(0, -1)) : channel === pat
    );
  }
}
