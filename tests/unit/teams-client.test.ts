// Teams client tests using mock botbuilder SDK.

// Mock botbuilder before import
const mockContinueConversationAsync = jest.fn();
const mockSendActivity = jest.fn();

jest.mock('botbuilder', () => {
  return {
    CloudAdapter: jest.fn().mockImplementation(() => ({
      continueConversationAsync: mockContinueConversationAsync,
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

import { TeamsClient } from '../../src/teams/client';

beforeEach(() => {
  mockContinueConversationAsync.mockReset();
  mockSendActivity.mockReset();
});

const fakeConversationRef: any = {
  activityId: 'act.1',
  bot: { id: 'bot-id', name: 'Bot' },
  channelId: 'msteams',
  conversation: { id: 'conv-1' },
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
};

describe('TeamsClient constructor', () => {
  it('creates client with valid options', () => {
    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });
    expect(client.getAppId()).toBe('test-app-id');
  });

  it('throws on empty appId', () => {
    expect(() => new TeamsClient({ appId: '', appPassword: 'test-app-password' })).toThrow(
      'appId is required'
    );
  });

  it('throws on empty appPassword', () => {
    expect(() => new TeamsClient({ appId: 'test-app-id', appPassword: '' })).toThrow(
      'appPassword is required'
    );
  });

  it('accepts optional tenantId', () => {
    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
      tenantId: 'tenant-123',
    });
    expect(client.getAppId()).toBe('test-app-id');
  });
});

describe('TeamsClient.getAdapter', () => {
  it('returns the underlying CloudAdapter', () => {
    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });
    const adapter = client.getAdapter();
    expect(adapter).toBeDefined();
    expect(adapter.continueConversationAsync).toBeDefined();
  });
});

describe('TeamsClient.sendMessage', () => {
  it('sends a simple text message', async () => {
    mockContinueConversationAsync.mockImplementation(
      async (_appId: string, _ref: any, callback: Function) => {
        const fakeTurnContext = {
          sendActivity: mockSendActivity.mockResolvedValue({ id: 'act.reply1' }),
        };
        await callback(fakeTurnContext);
      }
    );

    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const result = await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: 'Hello!',
    });

    expect(result).toEqual({ ok: true, activityId: 'act.reply1' });
    expect(mockContinueConversationAsync).toHaveBeenCalledTimes(1);
    expect(mockSendActivity).toHaveBeenCalledTimes(1);
  });

  it('includes replyToId for threaded replies', async () => {
    let capturedActivity: any;
    mockContinueConversationAsync.mockImplementation(
      async (_appId: string, _ref: any, callback: Function) => {
        const fakeTurnContext = {
          sendActivity: jest.fn((activity: any) => {
            capturedActivity = activity;
            return Promise.resolve({ id: 'act.reply2' });
          }),
        };
        await callback(fakeTurnContext);
      }
    );

    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: 'Reply',
      replyToActivityId: 'act.original',
    });

    expect(capturedActivity.replyToId).toBe('act.original');
  });

  it('auto-chunks long messages at 28000 characters', async () => {
    mockContinueConversationAsync.mockImplementation(
      async (_appId: string, _ref: any, callback: Function) => {
        const fakeTurnContext = {
          sendActivity: mockSendActivity.mockResolvedValue({ id: 'act.chunk' }),
        };
        await callback(fakeTurnContext);
      }
    );

    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const longText = 'a'.repeat(27000) + '\n' + 'b'.repeat(27000);
    await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: longText,
    });

    expect(mockContinueConversationAsync).toHaveBeenCalledTimes(2);
  });

  it('returns error on adapter failure', async () => {
    mockContinueConversationAsync.mockRejectedValue(new Error('Bot Framework error'));

    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const result = await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: 'Hello',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Bot Framework error');
  });

  it('returns error on sendActivity failure', async () => {
    mockContinueConversationAsync.mockImplementation(
      async (_appId: string, _ref: any, callback: Function) => {
        const fakeTurnContext = {
          sendActivity: jest.fn().mockRejectedValue(new Error('Send failed')),
        };
        await callback(fakeTurnContext);
      }
    );

    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const result = await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: 'Hello',
    });

    // The error is caught inside continueConversationAsync callback and re-thrown
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Send failed');
  });

  it('passes the correct appId to continueConversationAsync', async () => {
    mockContinueConversationAsync.mockImplementation(
      async (_appId: string, _ref: any, callback: Function) => {
        const fakeTurnContext = {
          sendActivity: mockSendActivity.mockResolvedValue({ id: 'act.1' }),
        };
        await callback(fakeTurnContext);
      }
    );

    const client = new TeamsClient({
      appId: 'my-specific-app-id',
      appPassword: 'test-app-password',
    });

    await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: 'Test',
    });

    expect(mockContinueConversationAsync.mock.calls[0][0]).toBe('my-specific-app-id');
  });

  it('passes the conversation reference to continueConversationAsync', async () => {
    mockContinueConversationAsync.mockImplementation(
      async (_appId: string, _ref: any, callback: Function) => {
        const fakeTurnContext = {
          sendActivity: mockSendActivity.mockResolvedValue({ id: 'act.1' }),
        };
        await callback(fakeTurnContext);
      }
    );

    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: 'Test',
    });

    expect(mockContinueConversationAsync.mock.calls[0][1]).toBe(fakeConversationRef);
  });

  it('returns ok with undefined activityId when sendActivity returns no id', async () => {
    mockContinueConversationAsync.mockImplementation(
      async (_appId: string, _ref: any, callback: Function) => {
        const fakeTurnContext = {
          sendActivity: jest.fn().mockResolvedValue(undefined),
        };
        await callback(fakeTurnContext);
      }
    );

    const client = new TeamsClient({
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const result = await client.sendMessage({
      conversationReference: fakeConversationRef,
      text: 'Test',
    });

    expect(result.ok).toBe(true);
    expect(result.activityId).toBeUndefined();
  });
});
