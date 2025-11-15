/**
 * Slack Test Fixture Types
 *
 * Defines the structure of mock Slack events and expected outcomes for testing
 * Slack bot mode without hitting real Slack APIs.
 */

export interface SlackMessage {
  /** Message timestamp (unique ID in Slack) */
  ts: string;
  /** User ID who sent the message */
  user: string;
  /** Message text content */
  text: string;
  /** Message type (defaults to 'message') */
  type?: string;
  /** Bot ID if message is from a bot */
  bot_id?: string;
  /** Thread timestamp if this is a threaded message */
  thread_ts?: string;
}

export interface SlackThread {
  /** Channel ID where thread exists */
  channel: string;
  /** Thread timestamp (root message ts) */
  thread_ts: string;
  /** Thread message history */
  messages: SlackMessage[];
}

export interface SlackReaction {
  /** Reaction emoji name (without colons) */
  name: string;
  /** Channel where reaction was added */
  channel: string;
  /** Message timestamp */
  timestamp: string;
}

export interface SlackEvent {
  /** Event type (e.g., 'app_mention') */
  type: string;
  /** Event ID for deduplication */
  event_id: string;
  /** Event timestamp */
  event_ts: string;
  /** Channel ID */
  channel: string;
  /** User ID who triggered the event */
  user: string;
  /** Message text */
  text: string;
  /** Thread timestamp if in a thread */
  thread_ts?: string;
  /** Message timestamp */
  ts: string;
}

export interface SlackWorkflowMessage {
  /** Message timestamp */
  ts: string;
  /** Channel ID */
  channel: string;
  /** Thread timestamp */
  thread_ts: string;
  /** User ID */
  user: string;
  /** Message text */
  text: string;
}

export interface SlackTestFixture {
  /** Fixture name for identification */
  name: string;

  /** Description of what this fixture tests */
  description?: string;

  /** Bot user ID (defaults to 'U_BOT_ID') */
  bot_user_id?: string;

  /** Initial thread state (history before trigger event) */
  thread?: SlackThread;

  /** The triggering Slack event (e.g., app_mention) */
  event: SlackEvent;

  /** Sequence of follow-up messages for multi-turn conversations */
  workflow_messages?: SlackWorkflowMessage[];

  /** Initial reactions state (before workflow execution) */
  initial_reactions?: SlackReaction[];
}

export interface ExpectedSlackMessage {
  /** Channel where message should be posted */
  channel: string;
  /** Thread timestamp (if threaded response expected) */
  thread_ts?: string;
  /** Expected message text (exact match) */
  text?: string;
  /** Expected message text (substring match) */
  contains?: string | string[];
  /** Expected message text (regex match) */
  matches?: string;
}

export interface ExpectedSlackReaction {
  /** Reaction emoji name (without colons) */
  name: string;
  /** Channel where reaction should be added */
  channel: string;
  /** Message timestamp */
  timestamp: string;
  /** Whether reaction should be added (true) or removed (false) */
  added?: boolean;
}

export interface SlackTestAssertions {
  /** Expected reactions to be added/removed */
  reactions?: ExpectedSlackReaction[];

  /** Expected messages to be posted */
  messages?: ExpectedSlackMessage[];

  /** Expected reaction sequence (in order) */
  reaction_sequence?: string[];

  /** Expected final reactions on the triggering message */
  final_reactions?: string[];

  /** Expected workflow completion status */
  workflow_completed?: boolean;

  /** Expected workflow error (if any) */
  workflow_error?: string | { contains: string };
}

/**
 * Slack mode test case configuration
 */
export interface SlackModeTestCase {
  /** Test case name */
  name: string;

  /** Test description */
  description?: string;

  /** Test mode (must be 'slack' for Slack tests) */
  mode: 'slack';

  /** Slack fixture to use */
  slack_fixture: SlackTestFixture;

  /** Workflow name to execute */
  workflow?: string;

  /** Expected outcomes for Slack interactions */
  expect_slack?: SlackTestAssertions;

  /** Regular Visor test assertions (for check execution) */
  expect?: any;

  /** Mocks for providers (same as regular tests) */
  mocks?: Record<string, unknown>;

  /** Environment variables to set */
  env?: Record<string, string>;

  /** Skip this test */
  skip?: boolean;
}
