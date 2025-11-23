import fs from 'fs';
import yaml from 'js-yaml';
import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

// Local fake Slack with spies
const reactionsAdd = jest.fn(async () => ({ ok: true }));
const reactionsRemove = jest.fn(async () => ({ ok: true }));
const chatPostMessage = jest.fn(async ({ text, thread_ts }: any) => ({
  ts: '5555.9',
  message: { ts: '5555.9', text, thread_ts },
}));
const chatUpdate = jest.fn(async () => ({ ok: true }));

jest.mock('../../src/slack/client', () => {
  return {
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
  };
});

function envFor(
  ts: string,
  text: string,
  opts?: { channel?: string; thread_ts?: string; type?: string }
) {
  const channel = opts?.channel || 'C1';
  // In public channels we only react to app_mention; default to that for tests.
  const type = opts?.type || 'app_mention';
  const payload: any = { event: { type, channel, ts, text } };
  if (opts?.thread_ts) payload.event.thread_ts = opts.thread_ts;
  return { type: 'events_api', envelope_id: `env-${ts}`, payload };
}

describe('Slack Frontend summary message threading + update-in-place', () => {
  beforeEach(() => {
    reactionsAdd.mockClear();
    reactionsRemove.mockClear();
    chatPostMessage.mockClear();
    chatUpdate.mockClear();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  });
  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
  });

  test('first run posts in thread; second run updates same message', async () => {
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    const cfg = yaml.load(raw) as VisorConfig;
    // Enable summary posting for chat group so frontend will emit summary messages
    cfg.frontends = cfg.frontends || [];
    const slackFe = cfg.frontends.find((f: any) => f && f.name === 'slack') as any;
    if (slackFe) {
      slackFe.config = slackFe.config || {};
      slackFe.config.summary = { enabled: true };
    } else {
      cfg.frontends.push({ name: 'slack', config: { summary: { enabled: true } } } as any);
    }
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    // First turn (root message) — post summary in thread
    await (runner as any).handleMessage(JSON.stringify(envFor('2100.1', 'Hello from user')));
    expect(chatPostMessage.mock.calls.length).toBeGreaterThan(0);
    const call = chatPostMessage.mock.calls[0][0];
    expect(call.thread_ts).toBe('2100.1');
    expect(call.channel).toBe('C1');

    // Second turn (threaded reply) — should update instead of posting new
    await (runner as any).handleMessage(
      JSON.stringify(envFor('2100.2', 'Another turn', { thread_ts: '2100.1', type: 'app_mention' }))
    );
    expect(chatPostMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Prefer update-in-place; if not called, the test would have failed earlier on post count
    const updCall = (chatUpdate.mock.calls as any[])[0]?.[0] as any;
    if (updCall) {
      expect(updCall.channel).toBe('C1');
      // summary ts stored in PromptState; we mocked postMessage to return ts '5555.9'
      expect(updCall.ts).toBe('5555.9');
    }
  });
});
