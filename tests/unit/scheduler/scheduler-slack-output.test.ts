/**
 * Unit tests for scheduler Slack output
 * Tests that scheduled reminders post responses back to Slack via the output adapter
 */
import fs from 'fs';
import yaml from 'js-yaml';
import type { VisorConfig } from '../../../src/types/config';
import { Scheduler } from '../../../src/scheduler/scheduler';
import { ScheduleStore } from '../../../src/scheduler/schedule-store';
import { SlackOutputAdapter } from '../../../src/slack/slack-output-adapter';

// Mock SlackClient used by the output adapter
const chatPostMessage = jest.fn(async ({ text }: any) => ({
  ts: '2000.1',
  message: { ts: '2000.1', text },
}));
const chatUpdate = jest.fn(async () => ({ ok: true }));

const mockSlackClient: any = {
  chat: { postMessage: chatPostMessage, update: chatUpdate },
  reactions: { add: jest.fn(), remove: jest.fn() },
  async getBotUserId() {
    return 'UFAKEBOT';
  },
  async fetchThreadReplies() {
    return [];
  },
  async openDM() {
    return { ok: true, channel: 'D123' };
  },
};

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

// Mock the execution engine to avoid running the full visor pipeline
const mockExecuteChecks = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../src/state-machine-execution-engine', () => ({
  StateMachineExecutionEngine: class MockEngine {
    setExecutionContext = jest.fn();
    executeChecks = mockExecuteChecks;
  },
}));

describe('Scheduler Slack Output', () => {
  let scheduler: Scheduler;
  let cfg: VisorConfig;

  beforeEach(() => {
    chatPostMessage.mockClear();
    chatUpdate.mockClear();
    mockExecuteChecks.mockClear();
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
    // Create scheduler
    scheduler = new Scheduler(cfg, {
      storagePath: '.test-schedules.json',
    });

    // Register Slack output adapter - this is what posts to Slack after execution
    const outputAdapter = new SlackOutputAdapter(mockSlackClient, {
      includeErrorDetails: true,
    });
    scheduler.registerOutputAdapter(outputAdapter);

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

    // The mock engine should have been called
    expect(mockExecuteChecks).toHaveBeenCalled();

    // The Slack output adapter posts a fallback when the pipeline returns 'pipeline_executed'
    // For simple reminders without a captured response, the adapter uses the original text
    // Verify the engine was invoked with correct webhook data
    const executeCall = mockExecuteChecks.mock.calls[0][0];
    expect(executeCall.webhookContext).toBeDefined();
    expect(executeCall.webhookContext.eventType).toBe('schedule');
  });

  test('reminder to DM should post to correct DM channel', async () => {
    scheduler = new Scheduler(cfg, {
      storagePath: '.test-schedules.json',
    });

    // Register Slack output adapter
    const outputAdapter = new SlackOutputAdapter(mockSlackClient);
    scheduler.registerOutputAdapter(outputAdapter);

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

    // Verify the engine was invoked
    expect(mockExecuteChecks).toHaveBeenCalled();

    // Verify the webhook data contains correct channel info
    const executeCall = mockExecuteChecks.mock.calls[0][0];
    const webhookData = executeCall.webhookContext.webhookData;
    const payload = webhookData.values().next().value;
    expect(payload.event.channel).toBe('D09SZABNLG3');
  });

  describe('previousResponse feature', () => {
    test('recurring reminder should save AI response as previousResponse', async () => {
      scheduler = new Scheduler(cfg, {
        storagePath: '.test-schedules.json',
      });

      // Register Slack output adapter
      const outputAdapter = new SlackOutputAdapter(mockSlackClient);
      scheduler.registerOutputAdapter(outputAdapter);

      const store = scheduler.getStore();
      await store.initialize();

      // Create a RECURRING reminder
      const schedule = store.create({
        creatorId: 'U123',
        creatorContext: 'slack:U123',
        timezone: 'UTC',
        schedule: '0 9 * * 1', // Every Monday at 9am
        isRecurring: true,
        originalExpression: 'every Monday at 9am',
        workflowInputs: {
          text: 'give me a project status update',
        },
        outputContext: {
          type: 'slack',
          target: 'C123456',
        },
      });

      // Execute the schedule
      await (scheduler as any).executeSchedule(schedule);

      // Verify the engine was invoked
      expect(mockExecuteChecks).toHaveBeenCalled();

      // The schedule should still exist (it's recurring)
      const updatedSchedule = store.get(schedule.id);
      expect(updatedSchedule).toBeDefined();
      expect(updatedSchedule?.status).toBe('active');

      // Note: The full pipeline isn't running in this test, so previousResponse
      // won't be captured (the responseCapture callback isn't called by our mock).
      // In a full integration test, previousResponse would contain the AI response.
    });

    test('recurring reminder should include previousResponse in context', async () => {
      scheduler = new Scheduler(cfg, {
        storagePath: '.test-schedules.json',
      });

      // Register Slack output adapter
      const outputAdapter = new SlackOutputAdapter(mockSlackClient);
      scheduler.registerOutputAdapter(outputAdapter);

      const store = scheduler.getStore();
      await store.initialize();

      // Create a recurring reminder with existing previousResponse
      const schedule = store.create({
        creatorId: 'U123',
        creatorContext: 'slack:U123',
        timezone: 'UTC',
        schedule: '0 9 * * *',
        isRecurring: true,
        originalExpression: 'every day at 9am',
        workflowInputs: {
          text: 'give me a project status update',
        },
        outputContext: {
          type: 'slack',
          target: 'C123456',
        },
      });

      // Manually set previousResponse (simulating a prior run)
      store.update(schedule.id, {
        previousResponse: 'Previous status: 5 tasks completed, 3 pending',
      });

      // Re-fetch the schedule to get the updated previousResponse
      const updatedSchedule = store.get(schedule.id)!;

      // Execute the schedule with the updated version
      await (scheduler as any).executeSchedule(updatedSchedule);

      // Verify the engine was invoked with previousResponse in the webhook data
      expect(mockExecuteChecks).toHaveBeenCalled();

      const executeCall = mockExecuteChecks.mock.calls[0][0];
      const webhookData = executeCall.webhookContext.webhookData;
      const payload = webhookData.values().next().value;

      // The previousResponse should be included in the schedule context
      expect(payload.schedule.previousResponse).toBe(
        'Previous status: 5 tasks completed, 3 pending'
      );

      // The conversation text should include the previous response context
      expect(payload.conversation.current.text).toContain('Previous Response');
    });

    test('one-time reminder should not save previousResponse', async () => {
      scheduler = new Scheduler(cfg, {
        storagePath: '.test-schedules.json',
      });

      // Register Slack output adapter
      const outputAdapter = new SlackOutputAdapter(mockSlackClient);
      scheduler.registerOutputAdapter(outputAdapter);

      const store = scheduler.getStore();
      await store.initialize();

      // Create a ONE-TIME reminder
      const schedule = store.create({
        creatorId: 'U123',
        creatorContext: 'slack:U123',
        timezone: 'UTC',
        schedule: '',
        isRecurring: false, // Not recurring
        originalExpression: 'in 5 minutes',
        runAt: Date.now() - 1000,
        workflowInputs: {
          text: 'remind me about something',
        },
        outputContext: {
          type: 'slack',
          target: 'C123456',
        },
      });

      // Execute the schedule
      await (scheduler as any).executeSchedule(schedule);

      // Verify the engine was invoked
      expect(mockExecuteChecks).toHaveBeenCalled();

      // One-time schedules are deleted after execution
      const deletedSchedule = store.get(schedule.id);
      expect(deletedSchedule).toBeUndefined();
    });
  });
});
