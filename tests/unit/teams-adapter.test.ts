// Mock botbuilder before import
jest.mock('botbuilder', () => {
  return {
    CloudAdapter: jest.fn().mockImplementation(() => ({
      continueConversationAsync: jest.fn(),
      onTurnError: null,
      process: jest.fn(),
    })),
    ConfigurationBotFrameworkAuthentication: jest.fn(),
    TurnContext: {
      getConversationReference: jest.fn(activity => ({
        activityId: activity.id,
        bot: { id: 'bot-id', name: 'Bot' },
        channelId: 'msteams',
        conversation: activity.conversation || { id: 'conv-1' },
        serviceUrl: 'https://smba.trafficmanager.net/teams/',
      })),
    },
    MessageFactory: {
      text: jest.fn(t => ({ type: 'message', text: t })),
    },
    ActivityTypes: { Message: 'message' },
  };
});

import { TeamsAdapter, type TeamsMessageInfo } from '../../src/teams/adapter';

function mkMsg(overrides: Partial<TeamsMessageInfo> = {}): TeamsMessageInfo {
  return {
    activityId: 'act.test1',
    conversationId: 'conv-1',
    conversationType: 'personal',
    from: {
      id: 'user-1',
      name: 'Test User',
    },
    text: 'Hello bot',
    timestamp: '2024-01-01T00:00:00.000Z',
    conversationReference: {
      activityId: 'act.test1',
      bot: { id: 'bot-id', name: 'Bot' },
      channelId: 'msteams',
      conversation: { id: 'conv-1' },
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
    } as any,
    ...overrides,
  };
}

describe('TeamsAdapter.isFromBot', () => {
  it('returns true when from.id matches appId', () => {
    const adapter = new TeamsAdapter('user-1');
    expect(adapter.isFromBot(mkMsg({ from: { id: 'user-1', name: 'Bot' } }))).toBe(true);
  });

  it('returns false when from.id is different', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    expect(adapter.isFromBot(mkMsg({ from: { id: 'user-1', name: 'Test User' } }))).toBe(false);
  });
});

describe('TeamsAdapter.normalizeMessage', () => {
  it('normalizes user message correctly', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const norm = adapter.normalizeMessage(mkMsg());
    expect(norm.role).toBe('user');
    expect(norm.text).toBe('Hello bot');
    expect(norm.user).toBe('user-1');
    expect(norm.origin).toBeUndefined();
  });

  it('normalizes bot message correctly', () => {
    const adapter = new TeamsAdapter('user-1');
    const norm = adapter.normalizeMessage(mkMsg({ from: { id: 'user-1', name: 'Bot' } }));
    expect(norm.role).toBe('bot');
    expect(norm.origin).toBe('visor');
  });

  it('returns empty text when text is empty', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const norm = adapter.normalizeMessage(mkMsg({ text: '' }));
    expect(norm.text).toBe('');
  });

  it('returns empty text when text is undefined', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const norm = adapter.normalizeMessage(mkMsg({ text: undefined as any }));
    expect(norm.text).toBe('');
  });
});

describe('TeamsAdapter.buildConversationContext', () => {
  it('uses conversationId as thread ID', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg());
    expect(ctx.transport).toBe('teams');
    expect(ctx.thread.id).toBe('conv-1');
    expect(ctx.current.role).toBe('user');
    expect(ctx.messages.length).toBe(1);
  });

  it('includes activity_id in attributes', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ activityId: 'act.abc123' }));
    expect(ctx.attributes.activity_id).toBe('act.abc123');
  });

  it('includes conversation_id in attributes', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg());
    expect(ctx.attributes.conversation_id).toBe('conv-1');
  });

  it('includes from_id in attributes', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg());
    expect(ctx.attributes.from_id).toBe('user-1');
  });

  it('includes from_name when present', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(
      mkMsg({ from: { id: 'user-1', name: 'John Doe' } })
    );
    expect(ctx.attributes.from_name).toBe('John Doe');
  });

  it('omits from_name when absent', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ from: { id: 'user-1' } }));
    expect(ctx.attributes.from_name).toBeUndefined();
  });

  it('includes reply_to_id when present', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ replyToId: 'act.parent' }));
    expect(ctx.attributes.reply_to_id).toBe('act.parent');
  });

  it('omits reply_to_id when absent', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ replyToId: undefined }));
    expect(ctx.attributes.reply_to_id).toBeUndefined();
  });

  it('includes channel_id when present', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ channelId: 'channel-1' }));
    expect(ctx.attributes.channel_id).toBe('channel-1');
  });

  it('includes team_id when present', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ teamId: 'team-1' }));
    expect(ctx.attributes.team_id).toBe('team-1');
  });

  it('includes tenant_id when present', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ tenantId: 'tenant-1' }));
    expect(ctx.attributes.tenant_id).toBe('tenant-1');
  });

  it('includes conversation_type in attributes', () => {
    const adapter = new TeamsAdapter('bot-app-id');
    const ctx = adapter.buildConversationContext(mkMsg({ conversationType: 'groupChat' }));
    expect(ctx.attributes.conversation_type).toBe('groupChat');
  });
});

describe('TeamsAdapter.parseActivity', () => {
  it('extracts message from a standard Bot Framework Activity', () => {
    const activity = {
      type: 'message',
      id: 'act.msg1',
      text: 'Hello!',
      from: { id: 'user-1', name: 'John Doe' },
      conversation: { id: 'conv-1', conversationType: 'personal' },
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    const result = TeamsAdapter.parseActivity(activity as any);
    expect(result).not.toBeNull();
    expect(result!.activityId).toBe('act.msg1');
    expect(result!.from.id).toBe('user-1');
    expect(result!.from.name).toBe('John Doe');
    expect(result!.text).toBe('Hello!');
    expect(result!.conversationId).toBe('conv-1');
    expect(result!.conversationType).toBe('personal');
  });

  it('returns null for non-message activity types', () => {
    const activity = {
      type: 'conversationUpdate',
      id: 'act.update1',
      text: 'ignored',
      from: { id: 'user-1' },
      conversation: { id: 'conv-1' },
    };

    expect(TeamsAdapter.parseActivity(activity as any)).toBeNull();
  });

  it('returns null for empty text after mention stripping', () => {
    const activity = {
      type: 'message',
      id: 'act.mention1',
      text: '<at>Bot</at>',
      from: { id: 'user-1' },
      conversation: { id: 'conv-1' },
      entities: [
        {
          type: 'mention',
          text: '<at>Bot</at>',
          mentioned: { id: 'bot-id', name: 'Bot' },
        },
      ],
    };

    expect(TeamsAdapter.parseActivity(activity as any)).toBeNull();
  });

  it('strips @mention text from message', () => {
    const activity = {
      type: 'message',
      id: 'act.mention2',
      text: '<at>Bot</at> Hello there',
      from: { id: 'user-1', name: 'User' },
      conversation: { id: 'conv-1', conversationType: 'groupChat' },
      entities: [
        {
          type: 'mention',
          text: '<at>Bot</at>',
          mentioned: { id: 'bot-id', name: 'Bot' },
        },
      ],
    };

    const result = TeamsAdapter.parseActivity(activity as any);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('Hello there');
  });

  it('returns null when text is empty', () => {
    const activity = {
      type: 'message',
      id: 'act.empty',
      text: '',
      from: { id: 'user-1' },
      conversation: { id: 'conv-1' },
    };

    expect(TeamsAdapter.parseActivity(activity as any)).toBeNull();
  });

  it('extracts channelData fields', () => {
    const activity = {
      type: 'message',
      id: 'act.channel1',
      text: 'Hello',
      from: { id: 'user-1' },
      conversation: { id: 'conv-1', conversationType: 'channel', tenantId: 'tenant-1' },
      channelData: {
        channel: { id: 'channel-1' },
        team: { id: 'team-1' },
      },
    };

    const result = TeamsAdapter.parseActivity(activity as any);
    expect(result).not.toBeNull();
    expect(result!.channelId).toBe('channel-1');
    expect(result!.teamId).toBe('team-1');
    expect(result!.tenantId).toBe('tenant-1');
  });

  it('extracts aadObjectId from from field', () => {
    const activity = {
      type: 'message',
      id: 'act.aad1',
      text: 'Hello',
      from: { id: 'user-1', name: 'User', aadObjectId: 'aad-object-123' },
      conversation: { id: 'conv-1' },
    };

    const result = TeamsAdapter.parseActivity(activity as any);
    expect(result).not.toBeNull();
    expect(result!.from.aadObjectId).toBe('aad-object-123');
  });

  it('includes conversationReference from TurnContext', () => {
    const activity = {
      type: 'message',
      id: 'act.ref1',
      text: 'Hello',
      from: { id: 'user-1' },
      conversation: { id: 'conv-1' },
    };

    const result = TeamsAdapter.parseActivity(activity as any);
    expect(result).not.toBeNull();
    expect(result!.conversationReference).toBeDefined();
    expect(result!.conversationReference.channelId).toBe('msteams');
  });

  it('defaults conversationType to personal when missing', () => {
    const activity = {
      type: 'message',
      id: 'act.default1',
      text: 'Hello',
      from: { id: 'user-1' },
      conversation: { id: 'conv-1' },
    };

    const result = TeamsAdapter.parseActivity(activity as any);
    expect(result).not.toBeNull();
    expect(result!.conversationType).toBe('personal');
  });
});
