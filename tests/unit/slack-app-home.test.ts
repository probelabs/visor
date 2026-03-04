import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { SlackClient } from '../../src/slack/client';
import type { Schedule } from '../../src/scheduler/schedule-store';
import type { MessageTrigger } from '../../src/scheduler/store/types';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Minimal schedule factory
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-1',
    creatorId: 'U123',
    timezone: 'UTC',
    schedule: '0 9 * * 1',
    isRecurring: true,
    originalExpression: 'every Monday at 9am',
    workflow: 'weekly-report',
    status: 'active',
    createdAt: Date.now(),
    runCount: 0,
    failureCount: 0,
    nextRunAt: Date.now() + 86400000,
    ...overrides,
  };
}

// Minimal trigger factory
function makeTrigger(overrides: Partial<MessageTrigger> = {}): MessageTrigger {
  return {
    id: 'trig-1',
    creatorId: 'U123',
    workflow: 'on-message-handler',
    fromBots: false,
    threads: 'any',
    status: 'active',
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('SlackSocketRunner.buildHomeBlocks', () => {
  let runner: SlackSocketRunner;

  beforeEach(() => {
    // Create runner with minimal config — constructor requires appToken
    const mockEngine: any = {};
    const cfg: any = { checks: {} };
    runner = new SlackSocketRunner(mockEngine, cfg, {
      appToken: 'xapp-test-token',
    });
  });

  test('renders greeting with user real name', () => {
    const blocks = runner.buildHomeBlocks({ realName: 'Alice', name: 'alice' }, [], [], []);
    const header = blocks[0] as any;
    expect(header.type).toBe('header');
    expect(header.text.text).toBe('Hi, Alice!');
  });

  test('renders greeting with username fallback', () => {
    const blocks = runner.buildHomeBlocks({ name: 'bob' }, [], [], []);
    const header = blocks[0] as any;
    expect(header.text.text).toBe('Hi, bob!');
  });

  test('renders greeting with "there" when no user info', () => {
    const blocks = runner.buildHomeBlocks(null, [], [], []);
    const header = blocks[0] as any;
    expect(header.text.text).toBe('Hi, there!');
  });

  test('empty state shows placeholder messages for all sections', () => {
    const blocks = runner.buildHomeBlocks(null, [], [], []);

    // Find section blocks with mrkdwn text
    const sectionTexts = blocks
      .filter((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn')
      .map((b: any) => b.text.text);

    expect(sectionTexts).toContain('_No active schedules. Message the bot to create one._');
    expect(sectionTexts).toContain('_No active message triggers._');
    expect(sectionTexts).toContain('_No workflows registered._');
  });

  test('renders active schedules with status icons and details', () => {
    const schedules = [
      makeSchedule({ status: 'active', originalExpression: 'every Monday at 9am' }),
      makeSchedule({
        id: 'sched-2',
        status: 'paused',
        originalExpression: 'daily cleanup',
        isRecurring: false,
      }),
    ];
    const blocks = runner.buildHomeBlocks(null, schedules, [], []);

    const scheduleSections = blocks.filter(
      (b: any) =>
        b.type === 'section' && b.text?.type === 'mrkdwn' && b.text.text.includes('every Monday')
    );
    expect(scheduleSections.length).toBe(1);
    expect((scheduleSections[0] as any).text.text).toContain(':clock1:');
    expect((scheduleSections[0] as any).text.text).toContain('`0 9 * * 1`');

    const pausedSections = blocks.filter(
      (b: any) =>
        b.type === 'section' && b.text?.type === 'mrkdwn' && b.text.text.includes('daily cleanup')
    );
    expect(pausedSections.length).toBe(1);
    expect((pausedSections[0] as any).text.text).toContain(':double_vertical_bar:');
    expect((pausedSections[0] as any).text.text).toContain('one-time');
  });

  test('filters out completed/failed schedules', () => {
    const schedules = [
      makeSchedule({ status: 'completed', originalExpression: 'completed-task' }),
      makeSchedule({ status: 'failed', originalExpression: 'failed-task' }),
    ];
    const blocks = runner.buildHomeBlocks(null, schedules, [], []);

    const texts = blocks
      .filter((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn')
      .map((b: any) => b.text.text)
      .join('\n');

    expect(texts).not.toContain('completed-task');
    expect(texts).not.toContain('failed-task');
    expect(texts).toContain('_No active schedules');
  });

  test('truncates at 15 schedules and shows overflow', () => {
    const schedules = Array.from({ length: 20 }, (_, i) =>
      makeSchedule({ id: `sched-${i}`, originalExpression: `task-${i}` })
    );
    const blocks = runner.buildHomeBlocks(null, schedules, [], []);

    // Count rendered schedule sections (contain :clock1:)
    const rendered = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.text?.includes(':clock1:')
    );
    expect(rendered.length).toBe(15);

    // Check overflow context block
    const overflow = blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('…and 5 more')
    );
    expect(overflow).toBeDefined();
  });

  test('renders active triggers with filter info', () => {
    const triggers = [
      makeTrigger({
        description: 'Deploy trigger',
        channels: ['C123', 'C456'],
        contains: ['deploy', 'ship'],
        matchPattern: 'deploy \\w+',
        workflow: 'deploy-workflow',
      }),
    ];
    const blocks = runner.buildHomeBlocks(null, [], triggers, []);

    const triggerSections = blocks.filter(
      (b: any) =>
        b.type === 'section' && b.text?.type === 'mrkdwn' && b.text.text.includes('Deploy trigger')
    );
    expect(triggerSections.length).toBe(1);
    const text = (triggerSections[0] as any).text.text;
    expect(text).toContain(':large_green_circle:');
    expect(text).toContain('channels: C123, C456');
    expect(text).toContain('contains: deploy, ship');
    expect(text).toContain('pattern: `deploy \\w+`');
    expect(text).toContain('`deploy-workflow`');
  });

  test('renders disabled trigger with white circle', () => {
    const triggers = [makeTrigger({ enabled: false, workflow: 'disabled-wf' })];
    const blocks = runner.buildHomeBlocks(null, [], triggers, []);

    const triggerSections = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.text?.includes(':white_circle:')
    );
    expect(triggerSections.length).toBe(1);
  });

  test('filters out non-active triggers', () => {
    const triggers = [
      makeTrigger({ status: 'paused', description: 'paused-trigger' }),
      makeTrigger({ status: 'deleted', description: 'deleted-trigger' }),
    ];
    const blocks = runner.buildHomeBlocks(null, [], triggers, []);

    const texts = blocks
      .filter((b: any) => b.type === 'section' && b.text?.type === 'mrkdwn')
      .map((b: any) => b.text.text)
      .join('\n');

    expect(texts).not.toContain('paused-trigger');
    expect(texts).not.toContain('deleted-trigger');
    expect(texts).toContain('_No active message triggers._');
  });

  test('truncates at 10 triggers and shows overflow', () => {
    const triggers = Array.from({ length: 13 }, (_, i) =>
      makeTrigger({ id: `trig-${i}`, description: `trigger-${i}` })
    );
    const blocks = runner.buildHomeBlocks(null, [], triggers, []);

    const rendered = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.text?.includes(':large_green_circle:')
    );
    expect(rendered.length).toBe(10);

    const overflow = blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('…and 3 more')
    );
    expect(overflow).toBeDefined();
  });

  test('renders workflows with name and description', () => {
    const workflows = [
      { id: 'wf-1', name: 'Deploy', description: 'Deploy to production' },
      { id: 'wf-2', name: 'Test', description: undefined },
    ];
    const blocks = runner.buildHomeBlocks(null, [], [], workflows);

    const wfSections = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.text?.includes('*Deploy*')
    );
    expect(wfSections.length).toBe(1);
    expect((wfSections[0] as any).text.text).toContain('Deploy to production');

    const testSections = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.text?.includes('*Test*')
    );
    expect(testSections.length).toBe(1);
    // No description line
    expect((testSections[0] as any).text.text).toBe('*Test*');
  });

  test('truncates at 15 workflows and shows overflow', () => {
    const workflows = Array.from({ length: 18 }, (_, i) => ({
      id: `wf-${i}`,
      name: `Workflow ${i}`,
    }));
    const blocks = runner.buildHomeBlocks(null, [], [], workflows);

    const rendered = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.text?.startsWith('*Workflow ')
    );
    expect(rendered.length).toBe(15);

    const overflow = blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('…and 3 more')
    );
    expect(overflow).toBeDefined();
  });

  test('uses workflow id as fallback when name is empty', () => {
    const workflows = [{ id: 'my-workflow', name: '', description: 'desc' }];
    const blocks = runner.buildHomeBlocks(null, [], [], workflows);

    const wfSections = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.text?.includes('*my-workflow*')
    );
    expect(wfSections.length).toBe(1);
  });

  test('schedule without nextRunAt shows N/A', () => {
    const schedules = [makeSchedule({ nextRunAt: undefined })];
    const blocks = runner.buildHomeBlocks(null, schedules, [], []);

    const sched = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('Next: N/A')
    );
    expect(sched).toBeDefined();
  });
});

describe('SlackClient.views.publish', () => {
  let client: SlackClient;

  beforeEach(() => {
    client = new SlackClient('xoxb-test-token');
    mockFetch.mockReset();
  });

  test('calls views.publish API with user_id and view', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true }),
    });

    const result = await client.views.publish({
      user_id: 'U123',
      view: { type: 'home', blocks: [{ type: 'divider' }] },
    });

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/views.publish',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          user_id: 'U123',
          view: { type: 'home', blocks: [{ type: 'divider' }] },
        }),
      })
    );
  });

  test('returns error on API failure', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: 'invalid_blocks' }),
    });

    const result = await client.views.publish({
      user_id: 'U123',
      view: { type: 'home', blocks: [] },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_blocks');
  });

  test('returns error on network exception', async () => {
    mockFetch.mockRejectedValue(new Error('network timeout'));

    const result = await client.views.publish({
      user_id: 'U123',
      view: { type: 'home', blocks: [] },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('network timeout');
  });
});
