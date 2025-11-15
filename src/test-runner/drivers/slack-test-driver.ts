/**
 * Slack Test Driver
 *
 * Provides mock Slack environment for testing bot interactions without hitting real APIs.
 * Simulates Slack events, thread history, reactions, and API calls.
 */

import type { SlackTestFixture, SlackTestAssertions, SlackMessage } from '../types/slack-fixtures';
import type { BotSessionContext, NormalizedMessage } from '../../types/bot';
import { CheckExecutionEngine } from '../../check-execution-engine';
import { MemoryStore } from '../../memory-store';
import { SlackClient } from '../../slack/client';
import { getPromptStateManager } from '../../slack/prompt-state';

/**
 * Mock Slack API call tracker
 */
interface MockSlackCall {
  method: string;
  args: Record<string, unknown>;
  timestamp: number;
}

/**
 * Slack test driver for running tests in Slack bot mode
 */
export class SlackTestDriver {
  private mockCalls: MockSlackCall[] = [];
  private mockReactions: Map<string, Set<string>> = new Map(); // key: channel:ts, value: reaction emojis
  private mockMessages: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  private botUserId: string;

  constructor(
    private readonly fixture: SlackTestFixture,
    private readonly engine: CheckExecutionEngine
  ) {
    this.botUserId = fixture.bot_user_id || 'U_BOT_ID';
    this.setupMockSlackClient();
  }

  /**
   * Setup mock Slack client that intercepts API calls
   */
  private setupMockSlackClient(): void {
    // Mock SlackClient methods to track calls without hitting real API
    const originalAddReaction = SlackClient.prototype.addReaction;
    const originalRemoveReaction = SlackClient.prototype.removeReaction;
    const originalPostMessage = SlackClient.prototype.postMessage;

    // Track add reaction calls
    SlackClient.prototype.addReaction = async (
      channel: string,
      timestamp: string,
      emoji: string
    ): Promise<void> => {
      this.mockCalls.push({
        method: 'addReaction',
        args: { channel, timestamp, emoji },
        timestamp: Date.now(),
      });

      const key = `${channel}:${timestamp}`;
      if (!this.mockReactions.has(key)) {
        this.mockReactions.set(key, new Set());
      }
      this.mockReactions.get(key)!.add(emoji);
    };

    // Track remove reaction calls
    SlackClient.prototype.removeReaction = async (
      channel: string,
      timestamp: string,
      emoji: string
    ): Promise<void> => {
      this.mockCalls.push({
        method: 'removeReaction',
        args: { channel, timestamp, emoji },
        timestamp: Date.now(),
      });

      const key = `${channel}:${timestamp}`;
      if (this.mockReactions.has(key)) {
        this.mockReactions.get(key)!.delete(emoji);
      }
    };

    // Track post message calls
    SlackClient.prototype.postMessage = async (
      channel: string,
      text: string,
      threadTs?: string
    ): Promise<{ ts: string; channel: string }> => {
      this.mockCalls.push({
        method: 'postMessage',
        args: { channel, text, thread_ts: threadTs },
        timestamp: Date.now(),
      });

      this.mockMessages.push({ channel, text, thread_ts: threadTs });

      return {
        ts: `${Date.now()}.${Math.random().toString(36).slice(2)}`,
        channel,
      };
    };

    // Store original methods for cleanup
    (this as any).__originalMethods = {
      addReaction: originalAddReaction,
      removeReaction: originalRemoveReaction,
      postMessage: originalPostMessage,
    };
  }

  /**
   * Cleanup: restore original Slack client methods
   */
  cleanup(): void {
    const originals = (this as any).__originalMethods;
    if (originals) {
      SlackClient.prototype.addReaction = originals.addReaction;
      SlackClient.prototype.removeReaction = originals.removeReaction;
      SlackClient.prototype.postMessage = originals.postMessage;
    }

    // Clear prompt state manager
    const promptMgr = getPromptStateManager();
    try {
      // Clear all waiting prompts
      (promptMgr as any).waitingPrompts.clear();
    } catch {
      // Ignore errors
    }

    // Reset memory store
    try {
      MemoryStore.resetInstance();
    } catch {
      // Ignore errors
    }
  }

  /**
   * Build bot session context from fixture
   */
  buildBotSessionContext(): BotSessionContext {
    const event = this.fixture.event;
    const thread = this.fixture.thread;

    // Build conversation history from thread
    const history: NormalizedMessage[] = [];

    if (thread && thread.messages) {
      for (const msg of thread.messages) {
        history.push(this.normalizeSlackMessage(msg));
      }
    }

    // Add the current triggering message
    const currentMessage: NormalizedMessage = {
      role: 'user',
      text: event.text,
      timestamp: event.ts,
    };

    history.push(currentMessage);

    // Build thread ID
    const threadId = event.thread_ts || event.ts;
    const threadUrl = `https://slack.com/archives/${event.channel}/p${threadId.replace('.', '')}`;

    return {
      id: `${event.channel}:${threadId}`,
      transport: 'slack',
      currentMessage,
      history,
      attributes: {
        channel: event.channel,
        user: event.user,
        thread_ts: threadId,
        event_id: event.event_id,
      },
      state: {
        channel: event.channel,
        threadTs: threadId,
        eventId: event.event_id,
      },
      thread: {
        id: `${event.channel}:${threadId}`,
        url: threadUrl,
      },
    } as BotSessionContext;
  }

  /**
   * Normalize Slack message to NormalizedMessage format
   */
  private normalizeSlackMessage(msg: SlackMessage): NormalizedMessage {
    const isBot = !!msg.bot_id || msg.user === this.botUserId;
    return {
      role: isBot ? 'bot' : 'user',
      text: msg.text,
      timestamp: msg.ts,
      origin: isBot ? 'visor' : undefined,
    };
  }

  /**
   * Execute workflow with bot context
   */
  async execute(
    config: any,
    checksToRun: string[],
    tagFilter?: { include?: string[]; exclude?: string[] }
  ): Promise<{
    res: any;
    outHistory: Record<string, unknown[]>;
    botContext: BotSessionContext;
  }> {
    // Build bot session context
    const botContext = this.buildBotSessionContext();

    // Set bot context on engine
    this.engine.setExecutionContext({
      botSession: botContext,
      mode: {
        test: true,
        slack: true,
      },
      hooks: {
        // Mock hook for testing
        onPromptCaptured: (_info: { step: string; provider: string; prompt: string }) => {
          // Prompts are tracked by the test execution wrapper
        },
      },
    } as any);

    // Build minimal PRInfo-like object (not a PR, but engine expects this structure)
    const prInfo = {
      number: 0,
      title: `Slack: ${this.fixture.event.text.slice(0, 50)}`,
      body: this.fixture.event.text,
      author: this.fixture.event.user,
      authorAssociation: 'MEMBER',
      base: '',
      head: '',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      eventType: 'manual' as const,
      isIssue: false,
      eventContext: {
        event_name: 'slack',
        slack: {
          event: this.fixture.event,
          bot_context: botContext,
        },
      },
    };

    // Execute workflow
    const res = await this.engine.executeGroupedChecks(
      prInfo as any,
      checksToRun,
      120000,
      config,
      'json',
      process.env.VISOR_DEBUG === 'true',
      undefined,
      false,
      tagFilter
    );

    const outHistory = this.engine.getOutputHistorySnapshot();

    return { res, outHistory, botContext };
  }

  /**
   * Execute multi-turn conversation (with workflow_messages)
   */
  async executeConversation(
    config: any,
    checksToRun: string[],
    tagFilter?: { include?: string[]; exclude?: string[] }
  ): Promise<{
    results: Array<{ res: any; outHistory: Record<string, unknown[]> }>;
    botContext: BotSessionContext;
    finalMessages: Array<{ channel: string; text: string; thread_ts?: string }>;
    finalReactions: Map<string, Set<string>>;
  }> {
    const results: Array<{ res: any; outHistory: Record<string, unknown[]> }> = [];

    // Execute initial event
    const firstResult = await this.execute(config, checksToRun, tagFilter);
    results.push({ res: firstResult.res, outHistory: firstResult.outHistory });

    // Execute workflow messages (follow-up turns)
    if (this.fixture.workflow_messages && this.fixture.workflow_messages.length > 0) {
      for (const workflowMsg of this.fixture.workflow_messages) {
        // Create a new event for this message
        const followUpEvent = {
          ...this.fixture.event,
          text: workflowMsg.text,
          ts: workflowMsg.ts,
          user: workflowMsg.user,
          event_id: `${this.fixture.event.event_id}_follow_${workflowMsg.ts}`,
        };

        // Update fixture event
        const updatedFixture = {
          ...this.fixture,
          event: followUpEvent,
        };

        // Create new driver with updated fixture
        const followUpDriver = new SlackTestDriver(updatedFixture, this.engine);

        // Execute follow-up
        const followUpResult = await followUpDriver.execute(config, checksToRun, tagFilter);
        results.push({ res: followUpResult.res, outHistory: followUpResult.outHistory });

        // Merge mock calls
        this.mockCalls.push(...followUpDriver.mockCalls);
        this.mockMessages.push(...followUpDriver.mockMessages);
        for (const [key, reactions] of followUpDriver.mockReactions) {
          if (!this.mockReactions.has(key)) {
            this.mockReactions.set(key, new Set());
          }
          for (const reaction of reactions) {
            this.mockReactions.get(key)!.add(reaction);
          }
        }

        followUpDriver.cleanup();
      }
    }

    return {
      results,
      botContext: firstResult.botContext,
      finalMessages: this.mockMessages,
      finalReactions: this.mockReactions,
    };
  }

  /**
   * Validate assertions against mock calls
   */
  validate(assertions: SlackTestAssertions): string[] {
    const errors: string[] = [];

    // Validate reactions
    if (assertions.reactions) {
      for (const expected of assertions.reactions) {
        const key = `${expected.channel}:${expected.timestamp}`;
        const actualReactions = this.mockReactions.get(key);

        if (expected.added !== false) {
          // Expect reaction to be added
          if (!actualReactions || !actualReactions.has(expected.name)) {
            errors.push(
              `Expected reaction '${expected.name}' on ${key}, but it was not added. Actual: ${actualReactions ? Array.from(actualReactions).join(', ') : 'none'}`
            );
          }
        } else {
          // Expect reaction to be removed (or not added)
          if (actualReactions && actualReactions.has(expected.name)) {
            errors.push(
              `Expected reaction '${expected.name}' on ${key} to be removed, but it is still present`
            );
          }
        }
      }
    }

    // Validate reaction sequence
    if (assertions.reaction_sequence) {
      const reactionCalls = this.mockCalls.filter(c => c.method === 'addReaction');
      const actualSequence = reactionCalls.map(c => c.args.emoji as string);

      for (let i = 0; i < assertions.reaction_sequence.length; i++) {
        if (actualSequence[i] !== assertions.reaction_sequence[i]) {
          errors.push(
            `Reaction sequence mismatch at position ${i}: expected '${assertions.reaction_sequence[i]}', got '${actualSequence[i] || 'none'}'`
          );
        }
      }

      if (actualSequence.length > assertions.reaction_sequence.length) {
        errors.push(
          `Expected ${assertions.reaction_sequence.length} reactions, but got ${actualSequence.length}: ${actualSequence.join(', ')}`
        );
      }
    }

    // Validate final reactions
    if (assertions.final_reactions) {
      const triggerKey = `${this.fixture.event.channel}:${this.fixture.event.ts}`;
      const actualReactions = this.mockReactions.get(triggerKey);
      const actualSet = actualReactions ? Array.from(actualReactions).sort() : [];
      const expectedSet = assertions.final_reactions.slice().sort();

      if (JSON.stringify(actualSet) !== JSON.stringify(expectedSet)) {
        errors.push(
          `Final reactions mismatch: expected [${expectedSet.join(', ')}], got [${actualSet.join(', ')}]`
        );
      }
    }

    // Validate messages
    if (assertions.messages) {
      for (const expected of assertions.messages) {
        const matchingMessages = this.mockMessages.filter(msg => {
          if (msg.channel !== expected.channel) return false;
          if (expected.thread_ts && msg.thread_ts !== expected.thread_ts) return false;
          return true;
        });

        if (matchingMessages.length === 0) {
          errors.push(
            `Expected message in channel ${expected.channel}${expected.thread_ts ? ` (thread ${expected.thread_ts})` : ''}, but none was posted`
          );
          continue;
        }

        // Check text constraints
        const messages = matchingMessages.map(m => m.text);

        if (expected.text) {
          const exactMatch = messages.some(text => text === expected.text);
          if (!exactMatch) {
            errors.push(
              `Expected exact message text "${expected.text}", but got: ${messages.join(' | ')}`
            );
          }
        }

        if (expected.contains) {
          const containsArray = Array.isArray(expected.contains)
            ? expected.contains
            : [expected.contains];

          for (const substring of containsArray) {
            const found = messages.some(text => text.includes(substring));
            if (!found) {
              errors.push(
                `Expected message to contain "${substring}", but it was not found in: ${messages.join(' | ')}`
              );
            }
          }
        }

        if (expected.matches) {
          const regex = new RegExp(expected.matches);
          const regexMatch = messages.some(text => regex.test(text));
          if (!regexMatch) {
            errors.push(
              `Expected message to match regex /${expected.matches}/, but none matched: ${messages.join(' | ')}`
            );
          }
        }
      }
    }

    return errors;
  }

  /**
   * Get all mock calls for debugging
   */
  getMockCalls(): MockSlackCall[] {
    return this.mockCalls;
  }

  /**
   * Get all mock messages for debugging
   */
  getMockMessages(): typeof this.mockMessages {
    return this.mockMessages;
  }

  /**
   * Get all mock reactions for debugging
   */
  getMockReactions(): Map<string, Set<string>> {
    return this.mockReactions;
  }
}
