import fs from 'fs';
import yaml from 'js-yaml';
import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

// Mock SlackClient used by the Slack frontend so we can observe calls
const reactionsAdd = jest.fn(async () => ({ ok: true }));
const reactionsRemove = jest.fn(async () => ({ ok: true }));
const chatPostMessage = jest.fn(async ({ text }: any) => ({
  ts: '2000.1',
  message: { ts: '2000.1', text },
}));
const chatUpdate = jest.fn(async () => ({ ok: true }));

jest.mock('../../src/slack/client', () => ({
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

function mkEnv(
  text: string,
  channel = 'C1',
  ts = '1800.1',
  opts?: { type?: string; thread_ts?: string }
) {
  const type = opts?.type || (opts?.thread_ts ? 'app_mention' : 'app_mention');
  const payload: any = { event: { type, channel, ts, text } };
  if (opts?.thread_ts) payload.event.thread_ts = opts.thread_ts;
  return { type: 'events_api', envelope_id: `env-${ts}`, payload };
}

describe('Slack simple chat e2e (first message consume, no prompt)', () => {
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

  test('two turns consume user messages; prompt posted when waiting', async () => {
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    const cfg = yaml.load(raw) as VisorConfig;
    const engine = new StateMachineExecutionEngine();
    // Inject mock responses for AI checks via execution context hooks
    (engine as any).setExecutionContext({
      hooks: {
        mockForStep: (stepName: string) => {
          if (stepName === 'route-intent') return { intent: 'chat', topic: 'test' };
          if (stepName === 'chat-answer') return { text: 'Mock AI response' };
          return undefined;
        },
      },
    });
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    // Turn 1: root mention (starts thread)
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('Hello bot!', 'C1', '1900.1', { type: 'app_mention' }))
    );
    // Turn 2: reply in the same thread (thread_ts points at root)
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('Next', 'C1', '1900.2', { type: 'app_mention', thread_ts: '1900.1' }))
    );

    // Eyes should be added at least once across the two runs
    expect(reactionsAdd).toHaveBeenCalled();

    // In Slack mode we no longer post the human-input prompt as a separate
    // message; the previous AI step speaks to the user directly.
    const bodies = chatPostMessage.mock.calls.map(c =>
      c[0] && c[0].text ? String(c[0].text) : ''
    );
    // There should be at least one AI-visible message, and we must not
    // see an uncontrolled loop of replies for a single pair of turns.
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies.length).toBeLessThanOrEqual(2);
  });

  test('mentions in a thread produce replies; plain messages are ignored', async () => {
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    const cfg = yaml.load(raw) as VisorConfig;
    const engine = new StateMachineExecutionEngine();
    // Inject mock responses for AI checks via execution context hooks
    (engine as any).setExecutionContext({
      hooks: {
        mockForStep: (stepName: string) => {
          if (stepName === 'route-intent') return { intent: 'chat', topic: 'test' };
          if (stepName === 'chat-answer') return { text: 'Mock AI response' };
          return undefined;
        },
      },
    });
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    // Turn 1: root mention
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('Hello 1', 'C1', '2100.1', { type: 'app_mention' }))
    );
    // Turn 2: same thread (mention)
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('Hello 2', 'C1', '2100.2', { type: 'app_mention', thread_ts: '2100.1' }))
    );
    // Interleaved plain message in the same thread (no mention) — should be ignored by gating
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('noise', 'C1', '2100.25', { type: 'message', thread_ts: '2100.1' }))
    );
    // Turn 3: same thread (mention)
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('Hello 3', 'C1', '2100.3', { type: 'app_mention', thread_ts: '2100.1' }))
    );

    const bodies = chatPostMessage.mock.calls.map(c =>
      c[0] && c[0].text ? String(c[0].text) : ''
    );
    // At least one reply per app_mention, but no runaway loop.
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.length).toBeLessThanOrEqual(3);
  });
});
