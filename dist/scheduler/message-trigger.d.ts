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
export declare class MessageTriggerEvaluator {
    private triggers;
    private regexCache;
    constructor(triggers: Record<string, SlackMessageTrigger>);
    /**
     * Evaluate a message against all configured triggers.
     * Returns all matching triggers.
     */
    evaluate(message: IncomingMessage): MatchedTrigger[];
    private matchesTrigger;
    private matchesThreadScope;
    private matchesChannels;
}
//# sourceMappingURL=message-trigger.d.ts.map