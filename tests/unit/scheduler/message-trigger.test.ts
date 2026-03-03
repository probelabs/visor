import {
  MessageTriggerEvaluator,
  type IncomingMessage,
} from '../../../src/scheduler/message-trigger';
function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'C0CICD',
    user: 'U123',
    text: 'build failed for main',
    isBot: false,
    ts: '1700.001',
    ...overrides,
  };
}

describe('MessageTriggerEvaluator', () => {
  describe('basic matching', () => {
    test('matches a simple trigger with no filters', () => {
      const evaluator = new MessageTriggerEvaluator({
        'catch-all': { workflow: 'handle-all' },
      });
      const result = evaluator.evaluate(msg());
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('catch-all');
    });

    test('returns empty when no triggers configured', () => {
      const evaluator = new MessageTriggerEvaluator({});
      expect(evaluator.evaluate(msg())).toHaveLength(0);
    });

    test('returns multiple matches when multiple triggers match', () => {
      const evaluator = new MessageTriggerEvaluator({
        first: { workflow: 'wf1' },
        second: { workflow: 'wf2' },
      });
      expect(evaluator.evaluate(msg())).toHaveLength(2);
    });
  });

  describe('enabled filter', () => {
    test('skips disabled triggers', () => {
      const evaluator = new MessageTriggerEvaluator({
        disabled: { workflow: 'wf1', enabled: false },
        active: { workflow: 'wf2' },
      });
      const result = evaluator.evaluate(msg());
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('active');
    });

    test('treats enabled: true as active', () => {
      const evaluator = new MessageTriggerEvaluator({
        explicit: { workflow: 'wf1', enabled: true },
      });
      expect(evaluator.evaluate(msg())).toHaveLength(1);
    });
  });

  describe('channel filter', () => {
    test('matches exact channel', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', channels: ['C0CICD'] },
      });
      expect(evaluator.evaluate(msg())).toHaveLength(1);
      expect(evaluator.evaluate(msg({ channel: 'C0OTHER' }))).toHaveLength(0);
    });

    test('matches wildcard channel', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', channels: ['CENG*'] },
      });
      expect(evaluator.evaluate(msg({ channel: 'CENG123' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ channel: 'CENGDEV' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ channel: 'C0CICD' }))).toHaveLength(0);
    });

    test('matches any of multiple channels', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', channels: ['C0CICD', 'C0DEPLOY'] },
      });
      expect(evaluator.evaluate(msg({ channel: 'C0CICD' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ channel: 'C0DEPLOY' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ channel: 'C0OTHER' }))).toHaveLength(0);
    });

    test('omitted channels matches all', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf' },
      });
      expect(evaluator.evaluate(msg({ channel: 'CANYCHANNEL' }))).toHaveLength(1);
    });
  });

  describe('user filter', () => {
    test('matches specific user', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', from: ['U123'] },
      });
      expect(evaluator.evaluate(msg({ user: 'U123' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ user: 'U999' }))).toHaveLength(0);
    });

    test('matches any of multiple users', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', from: ['U123', 'U456'] },
      });
      expect(evaluator.evaluate(msg({ user: 'U123' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ user: 'U456' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ user: 'U789' }))).toHaveLength(0);
    });

    test('omitted from matches all users', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf' },
      });
      expect(evaluator.evaluate(msg({ user: 'UANY' }))).toHaveLength(1);
    });
  });

  describe('bot filter', () => {
    test('rejects bot messages by default', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf' },
      });
      expect(evaluator.evaluate(msg({ isBot: true }))).toHaveLength(0);
    });

    test('accepts bot messages when from_bots is true', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', from_bots: true },
      });
      expect(evaluator.evaluate(msg({ isBot: true }))).toHaveLength(1);
    });

    test('non-bot messages always pass bot filter', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', from_bots: false },
      });
      expect(evaluator.evaluate(msg({ isBot: false }))).toHaveLength(1);
    });
  });

  describe('contains filter (keyword match)', () => {
    test('matches case-insensitive keyword', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', contains: ['FAILED'] },
      });
      expect(evaluator.evaluate(msg({ text: 'build failed for main' }))).toHaveLength(1);
    });

    test('matches any keyword (OR logic)', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', contains: ['error', 'failed'] },
      });
      expect(evaluator.evaluate(msg({ text: 'build failed' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ text: 'runtime error' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ text: 'all good' }))).toHaveLength(0);
    });

    test('matches partial keyword in text', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', contains: ['fail'] },
      });
      expect(evaluator.evaluate(msg({ text: 'build failed' }))).toHaveLength(1);
    });

    test('omitted contains matches all text', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf' },
      });
      expect(evaluator.evaluate(msg({ text: 'anything at all' }))).toHaveLength(1);
    });
  });

  describe('match filter (regex)', () => {
    test('matches regex pattern', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', match: 'build.*failed' },
      });
      expect(evaluator.evaluate(msg({ text: 'build #42 failed' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ text: 'all good' }))).toHaveLength(0);
    });

    test('regex is case-insensitive', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', match: 'BUILD.*FAILED' },
      });
      expect(evaluator.evaluate(msg({ text: 'build #42 failed' }))).toHaveLength(1);
    });

    test('invalid regex never matches', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', match: '[invalid(' },
      });
      expect(evaluator.evaluate(msg({ text: '[invalid(' }))).toHaveLength(0);
    });
  });

  describe('thread scope filter', () => {
    test('root_only accepts root messages', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', threads: 'root_only' },
      });
      // Root message: no threadTs
      expect(evaluator.evaluate(msg({ ts: '1700.001', threadTs: undefined }))).toHaveLength(1);
      // Root message: threadTs === ts
      expect(evaluator.evaluate(msg({ ts: '1700.001', threadTs: '1700.001' }))).toHaveLength(1);
    });

    test('root_only rejects thread replies', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', threads: 'root_only' },
      });
      expect(evaluator.evaluate(msg({ ts: '1700.002', threadTs: '1700.001' }))).toHaveLength(0);
    });

    test('thread_only accepts thread replies', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', threads: 'thread_only' },
      });
      expect(evaluator.evaluate(msg({ ts: '1700.002', threadTs: '1700.001' }))).toHaveLength(1);
    });

    test('thread_only rejects root messages', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', threads: 'thread_only' },
      });
      expect(evaluator.evaluate(msg({ ts: '1700.001', threadTs: undefined }))).toHaveLength(0);
      expect(evaluator.evaluate(msg({ ts: '1700.001', threadTs: '1700.001' }))).toHaveLength(0);
    });

    test('any (default) accepts both root and thread replies', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf', threads: 'any' },
      });
      expect(evaluator.evaluate(msg({ ts: '1700.001', threadTs: undefined }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ ts: '1700.002', threadTs: '1700.001' }))).toHaveLength(1);
    });

    test('omitted threads defaults to any', () => {
      const evaluator = new MessageTriggerEvaluator({
        t: { workflow: 'wf' },
      });
      expect(evaluator.evaluate(msg({ ts: '1700.001' }))).toHaveLength(1);
      expect(evaluator.evaluate(msg({ ts: '1700.002', threadTs: '1700.001' }))).toHaveLength(1);
    });
  });

  describe('combined filters (AND logic)', () => {
    test('all filters must pass', () => {
      const evaluator = new MessageTriggerEvaluator({
        strict: {
          workflow: 'wf',
          channels: ['C0CICD'],
          from: ['U123BOT'],
          from_bots: true,
          contains: ['failed'],
          match: 'build.*failed',
          threads: 'root_only',
        },
      });

      // All conditions met
      expect(
        evaluator.evaluate(
          msg({
            channel: 'C0CICD',
            user: 'U123BOT',
            isBot: true,
            text: 'build #42 failed',
            ts: '1700.001',
            threadTs: undefined,
          })
        )
      ).toHaveLength(1);

      // Wrong channel
      expect(
        evaluator.evaluate(
          msg({
            channel: 'C0OTHER',
            user: 'U123BOT',
            isBot: true,
            text: 'build #42 failed',
            ts: '1700.001',
          })
        )
      ).toHaveLength(0);

      // Wrong user
      expect(
        evaluator.evaluate(
          msg({
            channel: 'C0CICD',
            user: 'UWRONG',
            isBot: true,
            text: 'build #42 failed',
            ts: '1700.001',
          })
        )
      ).toHaveLength(0);

      // Missing keyword
      expect(
        evaluator.evaluate(
          msg({
            channel: 'C0CICD',
            user: 'U123BOT',
            isBot: true,
            text: 'build #42 succeeded',
            ts: '1700.001',
          })
        )
      ).toHaveLength(0);

      // Thread reply (root_only)
      expect(
        evaluator.evaluate(
          msg({
            channel: 'C0CICD',
            user: 'U123BOT',
            isBot: true,
            text: 'build #42 failed',
            ts: '1700.002',
            threadTs: '1700.001',
          })
        )
      ).toHaveLength(0);
    });
  });
});
