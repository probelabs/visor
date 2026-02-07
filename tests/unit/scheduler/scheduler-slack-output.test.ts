/**
 * Unit tests for scheduler Slack output
 * Tests that scheduled reminders post responses back to Slack
 */
import fs from 'fs';
import yaml from 'js-yaml';
import type { VisorConfig } from '../../../src/types/config';
import { Scheduler } from '../../../src/scheduler/scheduler';
import { ScheduleStore } from '../../../src/scheduler/schedule-store';

// Mock SlackClient used by the Slack frontend so we can observe calls
const reactionsAdd = jest.fn(async () => ({ ok: true }));
const reactionsRemove = jest.fn(async () => ({ ok: true }));
const chatPostMessage = jest.fn(async ({ text }: any) => ({
  ts: '2000.1',
  message: { ts: '2000.1', text },
}));
const chatUpdate = jest.fn(async () => ({ ok: true }));

const mockSlackClient = {
  chat: { postMessage: chatPostMessage, update: chatUpdate },
  reactions: { add: reactionsAdd, remove: reactionsRemove },
  async getBotUserId() {
    return 'UFAKEBOT';
  },
  async fetchThreadReplies() {
    return [];
  },
};

jest.mock('../../../src/slack/client', () => ({
  SlackClient: class FakeSlackClient {
    public chat = { postMessage: chatPostMessage, update: chatUpdate };
    public reactions = { add: reactionsAdd, remove: reactionsRemove };
    async getBotUserId() {
      return 'UFAKEBOT';
    }
    async fetchThreadReplies() {
      return [];
    }
  },
}));

// Mock fs/promises for schedule store
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('Scheduler Slack Output', () => {
  let scheduler: Scheduler;
  let cfg: VisorConfig;

  beforeEach(() => {
    reactionsAdd.mockClear();
    reactionsRemove.mockClear();
    chatPostMessage.mockClear();
    chatUpdate.mockClear();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

    // Reset schedule store singleton
    ScheduleStore.resetInstance();

    // Load a config with AI checks
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    cfg = yaml.load(raw) as VisorConfig;
  });

  afterEach(async () => {
    delete process.env.SLACK_BOT_TOKEN;
    if (scheduler) {
      await scheduler.stop();
    }
    ScheduleStore.resetInstance();
  });

  test('simple reminder should post AI response to Slack channel', async () => {
    // Create scheduler with mock Slack client
    scheduler = new Scheduler(cfg, {
      storagePath: '.test-schedules.json',
    });

    // Set execution context with Slack client
    scheduler.setExecutionContext({
      slack: mockSlackClient,
      slackClient: mockSlackClient,
      hooks: {
        mockForStep: (stepName: string) => {
          if (stepName === 'route-intent') return { intent: 'chat', topic: 'test' };
          if (stepName === 'chat-answer') return { text: 'Here is the Jira ticket count: 47' };
          return undefined;
        },
      },
    });

    // Initialize store
    const store = scheduler.getStore();
    await store.initialize();

    // Create a simple reminder schedule
    const schedule = store.create({
      creatorId: 'U123',
      creatorContext: 'slack:U123',
      timezone: 'UTC',
      schedule: '',
      isRecurring: false,
      originalExpression: 'now',
      runAt: Date.now() - 1000, // Already due
      // No workflow - this is a simple reminder
      workflowInputs: {
        text: 'check how many Jira tickets were created this week',
      },
      outputContext: {
        type: 'slack',
        target: 'C123456', // Channel ID
      },
    });

    // Run the schedule directly (simulating what happens when the scheduler fires)
    await (scheduler as any).executeSchedule(schedule);

    // The Slack frontend should have posted the AI response
    expect(chatPostMessage).toHaveBeenCalled();

    // Check that the message was posted to the correct channel
    const calls = chatPostMessage.mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    // Find the call with the AI response
    const aiResponseCall = calls.find(
      (call: any) => call[0]?.text && call[0].text.includes('Jira ticket count')
    );
    expect(aiResponseCall).toBeDefined();
    expect(aiResponseCall![0].channel).toBe('C123456');
  });

  test('reminder to DM should post to correct DM channel', async () => {
    scheduler = new Scheduler(cfg, {
      storagePath: '.test-schedules.json',
    });

    scheduler.setExecutionContext({
      slack: mockSlackClient,
      slackClient: mockSlackClient,
      hooks: {
        mockForStep: (stepName: string) => {
          if (stepName === 'route-intent') return { intent: 'chat', topic: 'test' };
          if (stepName === 'chat-answer') return { text: 'Daily standup reminder!' };
          return undefined;
        },
      },
    });

    const store = scheduler.getStore();
    await store.initialize();

    const schedule = store.create({
      creatorId: 'U123',
      creatorContext: 'slack:U123',
      timezone: 'UTC',
      schedule: '',
      isRecurring: false,
      originalExpression: 'now',
      runAt: Date.now() - 1000,
      workflowInputs: {
        text: 'remind me about standup',
      },
      outputContext: {
        type: 'slack',
        target: 'D09SZABNLG3', // DM channel ID
      },
    });

    await (scheduler as any).executeSchedule(schedule);

    expect(chatPostMessage).toHaveBeenCalled();

    const calls = chatPostMessage.mock.calls;
    const dmCall = calls.find((call: any) => call[0]?.text && call[0].text.includes('standup'));
    expect(dmCall).toBeDefined();
    expect(dmCall![0].channel).toBe('D09SZABNLG3');
  });
});
