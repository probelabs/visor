import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import { getPromptStateManager, resetPromptStateManager } from '../../src/slack/prompt-state';

// Mock SlackClient used by the Slack frontend so we can observe calls and avoid network
const reactionsAdd = jest.fn(async () => ({ ok: true }));
const reactionsRemove = jest.fn(async () => ({ ok: true }));
const chatPostMessage = jest.fn(async ({ text }: any) => ({
  ts: '9000.1',
  message: { ts: '9000.1', text },
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

function mkEnv(
  text: string,
  ts: string,
  opts?: {
    channel?: string;
    thread_ts?: string;
    type?: string;
    subtype?: string;
    bot_id?: string;
  }
) {
  const channel = opts?.channel || 'C1';
  const type = opts?.type || (opts?.thread_ts ? 'app_mention' : 'app_mention');
  const payload: any = { event: { type, channel, ts, text } };
  if (opts?.thread_ts) payload.event.thread_ts = opts.thread_ts;
  if (opts?.subtype) payload.event.subtype = opts.subtype;
  if (opts?.bot_id) payload.event.bot_id = opts.bot_id;
  return { type: 'events_api', envelope_id: `env-${ts}`, payload };
}

describe('Slack pause/resume end-to-end', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetPromptStateManager();
    reactionsAdd.mockClear();
    reactionsRemove.mockClear();
    chatPostMessage.mockClear();
    chatUpdate.mockClear();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-snap-'));
    process.env.VISOR_SNAPSHOT_DIR = tmpDir;
  });

  afterEach(() => {
    resetPromptStateManager();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    delete process.env.VISOR_SNAPSHOT_DIR;
    delete process.env.SLACK_BOT_TOKEN;
  });

  test('snapshot saved on awaiting input and resumeFromSnapshot consumes next message', async () => {
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    const cfg = yaml.load(raw) as VisorConfig;
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    // Turn 1: root app_mention -> ask consumes message, route-intent/branch respond.
    // In the Slack org assistant example, the first simple turn is handled in
    // a single run without pausing for extra human input, so no snapshot is
    // written yet.
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('Hello bot!', '5000.1', { type: 'app_mention' }))
    );

    const filesAfterFirst = fs.readdirSync(tmpDir);
    expect(filesAfterFirst.length).toBe(0);

    const mgr = getPromptStateManager();
    expect(mgr.getWaiting('C1', '5000.1')).toBeFalsy();
  });

  test('bot messages are ignored by socket runner', async () => {
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    const cfg = yaml.load(raw) as VisorConfig;
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    const execSpy = jest
      .spyOn(StateMachineExecutionEngine.prototype as any, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 0,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      });

    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv('<@UFAKEBOT> ignore me', '6000.1', { subtype: 'bot_message', bot_id: 'B123' })
      )
    );
    expect(execSpy).not.toHaveBeenCalled();

    await (runner as any).handleMessage(
      JSON.stringify(mkEnv('real user', '6000.2', { type: 'app_mention' }))
    );
    expect(execSpy).toHaveBeenCalled();

    execSpy.mockRestore();
  });
});
