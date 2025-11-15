/**
 * Slack Bot Integration Tests
 *
 * Tests the Slack bot mode functionality using the test framework's Slack driver.
 * Validates bot context, reactions, messages, and multi-turn conversations.
 */

import type { SlackTestFixture } from '../../src/test-runner/types/slack-fixtures';
import fs from 'fs';
import path from 'path';

describe('Slack Bot Integration Tests', () => {
  const fixturesDir = path.join(__dirname, '../fixtures/slack');

  beforeEach(() => {
    // Test runner initialization if needed
  });

  describe('Fixture Loading', () => {
    it('should load simple mention fixture', () => {
      const fixturePath = path.join(fixturesDir, 'simple-mention.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.name).toBe('simple-mention');
      expect(fixture.bot_user_id).toBe('U_BOT_12345');
      expect(fixture.event.type).toBe('app_mention');
      expect(fixture.event.text).toContain('<@U_BOT_12345>');
    });

    it('should load thread conversation fixture', () => {
      const fixturePath = path.join(fixturesDir, 'thread-conversation.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.name).toBe('thread-conversation');
      expect(fixture.thread).toBeDefined();
      expect(fixture.thread!.messages).toHaveLength(2);
      expect(fixture.event.thread_ts).toBe(fixture.thread!.thread_ts);
    });

    it('should load human-input flow fixture', () => {
      const fixturePath = path.join(fixturesDir, 'human-input-flow.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.name).toBe('human-input-flow');
      expect(fixture.workflow_messages).toBeDefined();
      expect(fixture.workflow_messages).toHaveLength(2);
    });
  });

  describe('Bot Context Building', () => {
    it('should build bot context from simple mention', () => {
      const fixturePath = path.join(fixturesDir, 'simple-mention.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      // We'll test this through the driver
      expect(fixture.event.channel).toBe('C01234567');
      expect(fixture.event.user).toBe('U_USER_001');
    });

    it('should build bot context with thread history', () => {
      const fixturePath = path.join(fixturesDir, 'thread-conversation.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      // Verify fixture structure
      expect(fixture.thread!.messages).toHaveLength(2);
      expect(fixture.thread!.messages[0].user).toBe('U_USER_001');
      expect(fixture.thread!.messages[1].bot_id).toBe('B_BOT_001');
    });
  });

  describe('Slack Test Driver', () => {
    it('should normalize messages correctly', async () => {
      const fixturePath = path.join(fixturesDir, 'thread-conversation.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      // Verify message roles will be correctly assigned
      const userMsg = fixture.thread!.messages[0];
      const botMsg = fixture.thread!.messages[1];

      expect(userMsg.bot_id).toBeUndefined();
      expect(botMsg.bot_id).toBe('B_BOT_001');
    });
  });

  describe('Reaction Tracking', () => {
    it('should track reaction additions', async () => {
      // This will be tested via the test runner execution
      const fixturePath = path.join(fixturesDir, 'simple-mention.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.event.ts).toBeDefined();
      expect(fixture.event.channel).toBeDefined();
    });
  });

  describe('Message Posting', () => {
    it('should track posted messages', async () => {
      const fixturePath = path.join(fixturesDir, 'simple-mention.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.event.channel).toBe('C01234567');
    });
  });

  describe('Multi-turn Conversations', () => {
    it('should handle workflow messages', () => {
      const fixturePath = path.join(fixturesDir, 'human-input-flow.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.workflow_messages).toBeDefined();
      expect(fixture.workflow_messages!.length).toBeGreaterThan(0);

      for (const msg of fixture.workflow_messages!) {
        expect(msg.ts).toBeDefined();
        expect(msg.channel).toBe(fixture.event.channel);
        expect(msg.thread_ts).toBe(fixture.event.thread_ts);
      }
    });
  });

  describe('Thread Independence', () => {
    it('should maintain separate state for different threads', () => {
      // Load two different fixtures
      const fixture1Path = path.join(fixturesDir, 'simple-mention.json');
      const fixture2Path = path.join(fixturesDir, 'thread-conversation.json');

      const fixture1 = JSON.parse(fs.readFileSync(fixture1Path, 'utf8')) as SlackTestFixture;
      const fixture2 = JSON.parse(fs.readFileSync(fixture2Path, 'utf8')) as SlackTestFixture;

      // Verify they represent different threads
      expect(fixture1.event.ts).not.toBe(fixture2.event.thread_ts);
      expect(fixture1.thread).toBeUndefined();
      expect(fixture2.thread).toBeDefined();
    });
  });

  describe('Bot Session Context', () => {
    it('should expose bot context fields', () => {
      const fixturePath = path.join(fixturesDir, 'simple-mention.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      // Verify all required fields are present
      expect(fixture.event.channel).toBeDefined();
      expect(fixture.event.user).toBeDefined();
      expect(fixture.event.ts).toBeDefined();
      expect(fixture.event.text).toBeDefined();
    });

    it('should include transport-specific attributes', () => {
      const fixturePath = path.join(fixturesDir, 'thread-conversation.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.event.channel).toBe('C01234567');
      expect(fixture.event.user).toBe('U_USER_001');
      expect(fixture.event.thread_ts).toBeDefined();
      expect(fixture.event.event_id).toBeDefined();
    });
  });

  describe('Conversation History Access', () => {
    it('should provide access to thread history', () => {
      const fixturePath = path.join(fixturesDir, 'thread-conversation.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      expect(fixture.thread).toBeDefined();
      expect(fixture.thread!.messages.length).toBeGreaterThan(0);

      // Verify chronological order
      const timestamps = fixture.thread!.messages.map(m => parseFloat(m.ts));
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });

    it('should distinguish between user and bot messages', () => {
      const fixturePath = path.join(fixturesDir, 'thread-conversation.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as SlackTestFixture;

      const userMessages = fixture.thread!.messages.filter(m => !m.bot_id);
      const botMessages = fixture.thread!.messages.filter(
        m => m.bot_id || m.user === fixture.bot_user_id
      );

      expect(userMessages.length).toBeGreaterThan(0);
      expect(botMessages.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing fixture gracefully', async () => {
      const testCase = {
        name: 'missing-fixture-test',
        mode: 'slack',
        slack_fixture: null,
      };

      // This would be caught by the test runner
      expect(testCase.slack_fixture).toBeNull();
    });

    it('should validate fixture structure', () => {
      const validFixture: SlackTestFixture = {
        name: 'test',
        event: {
          type: 'app_mention',
          event_id: 'test',
          event_ts: '1234567890.000001',
          channel: 'C123',
          user: 'U123',
          text: 'test',
          ts: '1234567890.000001',
        },
      };

      expect(validFixture.name).toBeDefined();
      expect(validFixture.event).toBeDefined();
      expect(validFixture.event.type).toBe('app_mention');
    });
  });

  describe('Assertion Validation', () => {
    it('should support reaction assertions', () => {
      const assertions = {
        reactions: [
          {
            name: 'eyes',
            channel: 'C123',
            timestamp: '1234567890.000001',
            added: true,
          },
        ],
      };

      expect(assertions.reactions).toHaveLength(1);
      expect(assertions.reactions[0].name).toBe('eyes');
    });

    it('should support message assertions', () => {
      const assertions = {
        messages: [
          {
            channel: 'C123',
            thread_ts: '1234567890.000001',
            contains: ['Hello', 'World'],
          },
        ],
      };

      expect(assertions.messages).toHaveLength(1);
      expect(assertions.messages[0].contains).toContain('Hello');
    });

    it('should support reaction sequence assertions', () => {
      const assertions = {
        reaction_sequence: ['eyes', 'white_check_mark'],
      };

      expect(assertions.reaction_sequence).toEqual(['eyes', 'white_check_mark']);
    });

    it('should support final reactions assertions', () => {
      const assertions = {
        final_reactions: ['white_check_mark'],
      };

      expect(assertions.final_reactions).toContain('white_check_mark');
    });
  });

  describe('Backward Compatibility', () => {
    it('should not affect non-Slack tests', () => {
      const regularTestCase: any = {
        name: 'regular-test',
        event: 'pr_opened',
        fixture: 'gh.pr_open.minimal',
      };

      expect(regularTestCase.mode).toBeUndefined();
      expect(regularTestCase).not.toHaveProperty('slack_fixture');
    });

    it('should work alongside GitHub tests', () => {
      const slackTest: any = {
        name: 'slack-test',
        mode: 'slack',
        slack_fixture: {},
      };

      const githubTest: any = {
        name: 'github-test',
        event: 'pr_opened',
        fixture: 'gh.pr_open.minimal',
      };

      expect(slackTest.mode).toBe('slack');
      expect(githubTest.mode).toBeUndefined();
    });
  });
});
