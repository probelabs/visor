import { WhatsAppAdapter, type WhatsAppMessageInfo } from '../../src/whatsapp/adapter';

function mkMsg(overrides: Partial<WhatsAppMessageInfo> = {}): WhatsAppMessageInfo {
  return {
    messageId: 'wamid.test1',
    from: '15551234567',
    timestamp: '1704067200',
    type: 'text',
    text: 'Hello bot',
    phoneNumberId: '15559876543',
    ...overrides,
  };
}

describe('WhatsAppAdapter.isFromBot', () => {
  it('returns true when from matches bot phone number ID', () => {
    const adapter = new WhatsAppAdapter('15551234567');
    expect(adapter.isFromBot(mkMsg({ from: '15551234567' }))).toBe(true);
  });

  it('returns false when from is different', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    expect(adapter.isFromBot(mkMsg({ from: '15551234567' }))).toBe(false);
  });
});

describe('WhatsAppAdapter.normalizeMessage', () => {
  it('normalizes user message correctly', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const norm = adapter.normalizeMessage(mkMsg());
    expect(norm.role).toBe('user');
    expect(norm.text).toBe('Hello bot');
    expect(norm.user).toBe('15551234567');
    expect(norm.origin).toBeUndefined();
  });

  it('normalizes bot message correctly', () => {
    const adapter = new WhatsAppAdapter('15551234567');
    const norm = adapter.normalizeMessage(mkMsg({ from: '15551234567' }));
    expect(norm.role).toBe('bot');
    expect(norm.origin).toBe('visor');
  });

  it('uses caption when text is empty', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const norm = adapter.normalizeMessage(mkMsg({ text: undefined, caption: 'Photo caption' }));
    expect(norm.text).toBe('Photo caption');
  });

  it('returns empty text when both text and caption are missing', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const norm = adapter.normalizeMessage(mkMsg({ text: undefined, caption: undefined }));
    expect(norm.text).toBe('');
  });
});

describe('WhatsAppAdapter.buildConversationContext', () => {
  it('uses phone number as thread ID', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const ctx = adapter.buildConversationContext(mkMsg());
    expect(ctx.transport).toBe('whatsapp');
    expect(ctx.thread.id).toBe('15551234567');
    expect(ctx.current.role).toBe('user');
    expect(ctx.messages.length).toBe(1);
  });

  it('includes message_id in attributes', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const ctx = adapter.buildConversationContext(mkMsg({ messageId: 'wamid.abc123' }));
    expect(ctx.attributes.message_id).toBe('wamid.abc123');
  });

  it('includes from in attributes', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const ctx = adapter.buildConversationContext(mkMsg());
    expect(ctx.attributes.from).toBe('15551234567');
  });

  it('includes display_name when present', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const ctx = adapter.buildConversationContext(mkMsg({ displayName: 'John Doe' }));
    expect(ctx.attributes.display_name).toBe('John Doe');
  });

  it('omits display_name when absent', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const ctx = adapter.buildConversationContext(mkMsg({ displayName: undefined }));
    expect(ctx.attributes.display_name).toBeUndefined();
  });

  it('includes reply_to_message_id when present', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const ctx = adapter.buildConversationContext(
      mkMsg({ context: { message_id: 'wamid.parent' } })
    );
    expect(ctx.attributes.reply_to_message_id).toBe('wamid.parent');
  });

  it('omits reply_to_message_id when absent', () => {
    const adapter = new WhatsAppAdapter('15559876543');
    const ctx = adapter.buildConversationContext(mkMsg({ context: undefined }));
    expect(ctx.attributes.reply_to_message_id).toBeUndefined();
  });
});

describe('WhatsAppAdapter.parseWebhookPayload', () => {
  it('extracts messages from nested Meta webhook format', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '15559876543' },
                contacts: [{ wa_id: '15551234567', profile: { name: 'John Doe' } }],
                messages: [
                  {
                    id: 'wamid.msg1',
                    from: '15551234567',
                    timestamp: '1704067200',
                    type: 'text',
                    text: { body: 'Hello!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = WhatsAppAdapter.parseWebhookPayload(payload);
    expect(messages.length).toBe(1);
    expect(messages[0].messageId).toBe('wamid.msg1');
    expect(messages[0].from).toBe('15551234567');
    expect(messages[0].text).toBe('Hello!');
    expect(messages[0].displayName).toBe('John Doe');
    expect(messages[0].phoneNumberId).toBe('15559876543');
  });

  it('handles multiple messages in one webhook', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '15559876543' },
                contacts: [],
                messages: [
                  {
                    id: 'wamid.1',
                    from: '111',
                    timestamp: '100',
                    type: 'text',
                    text: { body: 'a' },
                  },
                  {
                    id: 'wamid.2',
                    from: '222',
                    timestamp: '101',
                    type: 'text',
                    text: { body: 'b' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = WhatsAppAdapter.parseWebhookPayload(payload);
    expect(messages.length).toBe(2);
    expect(messages[0].messageId).toBe('wamid.1');
    expect(messages[1].messageId).toBe('wamid.2');
  });

  it('skips non-message change types', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'statuses', // Not "messages"
              value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] },
            },
          ],
        },
      ],
    };

    const messages = WhatsAppAdapter.parseWebhookPayload(payload);
    expect(messages.length).toBe(0);
  });

  it('returns empty array for invalid payload', () => {
    expect(WhatsAppAdapter.parseWebhookPayload(null)).toEqual([]);
    expect(WhatsAppAdapter.parseWebhookPayload({})).toEqual([]);
    expect(WhatsAppAdapter.parseWebhookPayload({ entry: [] })).toEqual([]);
  });

  it('extracts media caption', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.img1',
                    from: '111',
                    timestamp: '100',
                    type: 'image',
                    image: { caption: 'My photo', id: 'img-id' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = WhatsAppAdapter.parseWebhookPayload(payload);
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe('image');
    expect(messages[0].caption).toBe('My photo');
  });

  it('extracts reply context', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.reply1',
                    from: '111',
                    timestamp: '100',
                    type: 'text',
                    text: { body: 'Reply' },
                    context: { id: 'wamid.parent', from: '222' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = WhatsAppAdapter.parseWebhookPayload(payload);
    expect(messages[0].context).toEqual({
      message_id: 'wamid.parent',
      from: '222',
    });
  });

  it('handles unknown message type', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123' },
                messages: [{ id: 'wamid.1', from: '111', timestamp: '100', type: 'sticker' }],
              },
            },
          ],
        },
      ],
    };

    const messages = WhatsAppAdapter.parseWebhookPayload(payload);
    expect(messages[0].type).toBe('unknown');
  });
});
