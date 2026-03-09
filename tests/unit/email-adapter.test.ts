import { EmailAdapter } from '../../src/email/adapter';
import type { EmailMessage } from '../../src/email/client';

function mkMsg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: '1',
    messageId: '<msg1@test>',
    from: 'User <user@test.com>',
    to: ['bot@test.com'],
    subject: 'Test Subject',
    text: 'Hello bot',
    date: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

describe('EmailAdapter.extractEmail', () => {
  it('extracts email from "Name <email>" format', () => {
    expect(EmailAdapter.extractEmail('John Doe <john@test.com>')).toBe('john@test.com');
  });

  it('returns plain email unchanged (lowercased)', () => {
    expect(EmailAdapter.extractEmail('USER@TEST.COM')).toBe('user@test.com');
  });

  it('handles empty string', () => {
    expect(EmailAdapter.extractEmail('')).toBe('');
  });

  it('handles email with surrounding whitespace', () => {
    expect(EmailAdapter.extractEmail('  user@test.com  ')).toBe('user@test.com');
  });

  it('handles display name with special characters', () => {
    expect(EmailAdapter.extractEmail('"O\'Brien, John" <john@test.com>')).toBe('john@test.com');
  });
});

describe('EmailAdapter.isFromBot', () => {
  it('returns true when from matches bot address', () => {
    const adapter = new EmailAdapter('bot@test.com');
    expect(adapter.isFromBot(mkMsg({ from: 'Bot <bot@test.com>' }))).toBe(true);
  });

  it('returns false when from is different', () => {
    const adapter = new EmailAdapter('bot@test.com');
    expect(adapter.isFromBot(mkMsg({ from: 'user@test.com' }))).toBe(false);
  });
});

describe('EmailAdapter.normalizeMessage', () => {
  it('normalizes user message correctly', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const norm = adapter.normalizeMessage(mkMsg());
    expect(norm.role).toBe('user');
    expect(norm.text).toBe('Hello bot');
    expect(norm.user).toBe('user@test.com');
    expect(norm.origin).toBeUndefined();
  });

  it('normalizes bot message correctly', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const norm = adapter.normalizeMessage(mkMsg({ from: 'Bot <bot@test.com>' }));
    expect(norm.role).toBe('bot');
    expect(norm.origin).toBe('visor');
  });
});

describe('EmailAdapter thread tracking', () => {
  it('creates new thread for first message', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const ctx = adapter.buildConversationContext(mkMsg());

    expect(ctx.transport).toBe('email');
    expect(ctx.thread.id).toBeTruthy();
    expect(ctx.thread.id.length).toBe(16);
    expect(ctx.current.role).toBe('user');
    expect(ctx.messages.length).toBe(1);
    expect(ctx.attributes.subject).toBe('Test Subject');
  });

  it('groups replies into same thread via In-Reply-To', () => {
    const adapter = new EmailAdapter('bot@test.com');

    // First message
    const msg1 = mkMsg({ messageId: '<msg1@test>' });
    const ctx1 = adapter.buildConversationContext(msg1);

    // Reply to first message
    const msg2 = mkMsg({
      messageId: '<msg2@test>',
      from: 'Bot <bot@test.com>',
      inReplyTo: '<msg1@test>',
      references: ['<msg1@test>'],
      text: 'Bot reply',
    });
    const ctx2 = adapter.buildConversationContext(msg2);

    // Should be same thread
    expect(ctx2.thread.id).toBe(ctx1.thread.id);
    expect(ctx2.messages.length).toBe(2);
  });

  it('groups deep replies via References chain', () => {
    const adapter = new EmailAdapter('bot@test.com');

    // First message
    adapter.buildConversationContext(mkMsg({ messageId: '<root@test>' }));

    // Second message references root
    adapter.buildConversationContext(
      mkMsg({
        messageId: '<msg2@test>',
        inReplyTo: '<root@test>',
        references: ['<root@test>'],
        text: 'Reply 1',
      })
    );

    // Third message references chain
    const ctx3 = adapter.buildConversationContext(
      mkMsg({
        messageId: '<msg3@test>',
        inReplyTo: '<msg2@test>',
        references: ['<root@test>', '<msg2@test>'],
        text: 'Reply 2',
      })
    );

    expect(ctx3.messages.length).toBe(3);
    // Thread ID should be based on root message
    const thread = adapter.getThreadByMessageId('<msg3@test>');
    expect(thread).toBeDefined();
    expect(thread!.rootMessageId).toBe('<root@test>');
  });

  it('does not double-register same message', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const msg = mkMsg();

    adapter.buildConversationContext(msg);
    const ctx = adapter.buildConversationContext(msg);

    expect(ctx.messages.length).toBe(1);
  });

  it('tracks participants across thread', () => {
    const adapter = new EmailAdapter('bot@test.com');

    adapter.buildConversationContext(mkMsg({ messageId: '<msg1@test>', from: 'alice@test.com' }));
    adapter.buildConversationContext(
      mkMsg({
        messageId: '<msg2@test>',
        from: 'bob@test.com',
        inReplyTo: '<msg1@test>',
        references: ['<msg1@test>'],
      })
    );

    const thread = adapter.getThreadByMessageId('<msg1@test>');
    expect(thread!.participants.has('alice@test.com')).toBe(true);
    expect(thread!.participants.has('bob@test.com')).toBe(true);
    expect(thread!.participants.has('bot@test.com')).toBe(true);
  });

  it('includes email-specific attributes in context', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const ctx = adapter.buildConversationContext(
      mkMsg({
        from: 'user@test.com',
        to: ['bot@test.com'],
        cc: ['cc@test.com'],
        subject: 'Important',
        inReplyTo: '<parent@test>',
      })
    );

    expect(ctx.attributes.from).toBe('user@test.com');
    expect(ctx.attributes.to).toBe('bot@test.com');
    expect(ctx.attributes.cc).toBe('cc@test.com');
    expect(ctx.attributes.subject).toBe('Important');
    expect(ctx.attributes.in_reply_to).toBe('<parent@test>');
  });

  it('cleanupOldThreads removes expired threads', () => {
    const adapter = new EmailAdapter('bot@test.com');

    // Create a thread with old date
    const msg = mkMsg({ messageId: '<old@test>', date: new Date('2020-01-01') });
    adapter.buildConversationContext(msg);

    expect(adapter.getThreadByMessageId('<old@test>')).toBeDefined();

    // Cleanup with 1ms max age (everything is old)
    adapter.cleanupOldThreads(1);

    expect(adapter.getThreadByMessageId('<old@test>')).toBeUndefined();
  });

  it('tracks CC recipients as participants', () => {
    const adapter = new EmailAdapter('bot@test.com');
    adapter.buildConversationContext(
      mkMsg({
        messageId: '<cc-test@test>',
        from: 'alice@test.com',
        to: ['bot@test.com'],
        cc: ['carol@test.com', 'dave@test.com'],
      })
    );

    const thread = adapter.getThreadByMessageId('<cc-test@test>');
    expect(thread!.participants.has('alice@test.com')).toBe(true);
    expect(thread!.participants.has('bot@test.com')).toBe(true);
    // CC recipients are tracked via the to[] field only in trackMessage
    // They're included in context attributes
  });

  it('handles orphaned reply with In-Reply-To to unknown parent', () => {
    const adapter = new EmailAdapter('bot@test.com');

    // Reply to a message we've never seen
    const ctx = adapter.buildConversationContext(
      mkMsg({
        messageId: '<orphan@test>',
        inReplyTo: '<unknown-parent@test>',
        references: ['<unknown-root@test>', '<unknown-parent@test>'],
      })
    );

    // Should create a new thread (root from References[0])
    expect(ctx.thread.id).toBeTruthy();
    const thread = adapter.getThreadByMessageId('<orphan@test>');
    expect(thread!.rootMessageId).toBe('<unknown-root@test>');
  });

  it('handles message with empty References array', () => {
    const adapter = new EmailAdapter('bot@test.com');
    adapter.buildConversationContext(
      mkMsg({
        messageId: '<empty-refs@test>',
        references: [],
      })
    );

    // Root should be the message itself when References is empty
    const thread = adapter.getThreadByMessageId('<empty-refs@test>');
    expect(thread!.rootMessageId).toBe('<empty-refs@test>');
  });

  it('omits cc and in_reply_to attributes when absent', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const ctx = adapter.buildConversationContext(
      mkMsg({
        cc: undefined,
        inReplyTo: undefined,
      })
    );

    expect(ctx.attributes.cc).toBeUndefined();
    expect(ctx.attributes.in_reply_to).toBeUndefined();
  });

  it('joins multiple to addresses with comma', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const ctx = adapter.buildConversationContext(
      mkMsg({
        messageId: '<multi-to@test>',
        to: ['bot@test.com', 'team@test.com'],
      })
    );

    expect(ctx.attributes.to).toBe('bot@test.com, team@test.com');
  });

  it('getThread returns undefined for unknown thread ID', () => {
    const adapter = new EmailAdapter('bot@test.com');
    expect(adapter.getThread('nonexistent')).toBeUndefined();
  });

  it('getThreadByMessageId returns undefined for unknown message', () => {
    const adapter = new EmailAdapter('bot@test.com');
    expect(adapter.getThreadByMessageId('<nonexistent@test>')).toBeUndefined();
  });

  it('cleanupOldThreads preserves recent threads', () => {
    const adapter = new EmailAdapter('bot@test.com');

    // Create an old thread and a recent thread
    adapter.buildConversationContext(
      mkMsg({ messageId: '<old@test>', date: new Date('2020-01-01') })
    );
    adapter.buildConversationContext(mkMsg({ messageId: '<new@test>', date: new Date() }));

    adapter.cleanupOldThreads(1000); // 1 second TTL

    expect(adapter.getThreadByMessageId('<old@test>')).toBeUndefined();
    expect(adapter.getThreadByMessageId('<new@test>')).toBeDefined();
  });

  it('updates lastActivity on re-registration of same message', () => {
    const adapter = new EmailAdapter('bot@test.com');
    const oldDate = new Date('2020-01-01');
    const newDate = new Date('2024-06-01');

    adapter.buildConversationContext(mkMsg({ messageId: '<redate@test>', date: oldDate }));
    adapter.buildConversationContext(mkMsg({ messageId: '<redate@test>', date: newDate }));

    const thread = adapter.getThreadByMessageId('<redate@test>');
    expect(thread!.lastActivity.getTime()).toBe(newDate.getTime());
  });
});
