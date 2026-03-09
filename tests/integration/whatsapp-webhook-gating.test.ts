// WhatsApp webhook runner tests for message filtering.
// Uses mock global.fetch for WhatsApp Cloud API calls.

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { WhatsAppWebhookRunner } from '../../src/whatsapp/webhook-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import type { WhatsAppMessageInfo } from '../../src/whatsapp/adapter';

const baseCfg: VisorConfig = {
  version: '1',
  output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
  checks: { reply: { type: 'ai' as any, on: ['manual'] } },
} as any;

beforeEach(() => {
  mockFetch.mockReset();
  // Default: markAsRead succeeds
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true }),
  });
});

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

describe('WhatsAppWebhookRunner message gating', () => {
  test('text messages are accepted and dispatched', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
      verifyToken: 'verify-me',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    await (runner as any).handleMessage(mkMsg());

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips messages without text content', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(
      mkMsg({
        text: undefined,
        caption: undefined,
      })
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('phone allowlist filters messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
      phoneAllowlist: ['15551234567', '15559999999'],
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    // Allowed number
    await (runner as any).handleMessage(
      mkMsg({
        messageId: 'wamid.allowed',
        from: '15551234567',
      })
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // Not in allowlist
    await (runner as any).handleMessage(
      mkMsg({
        messageId: 'wamid.blocked',
        from: '15550000000',
      })
    );
    expect(spy).toHaveBeenCalledTimes(1); // Still 1

    spy.mockRestore();
  });

  test('deduplication prevents processing same message twice', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    const msg = mkMsg({ messageId: 'wamid.dedup1' });

    await (runner as any).handleMessage(msg);
    await (runner as any).handleMessage(msg);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips processing when no checks configured', async () => {
    const emptyCfg: VisorConfig = {
      version: '1',
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      checks: {},
    } as any;

    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, emptyCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({ messageId: 'wamid.empty' }));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('marks messages as read on receipt', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    jest.spyOn(StateMachineExecutionEngine.prototype, 'executeChecks').mockResolvedValue({
      results: { default: [] },
      statistics: {
        totalChecks: 1,
        checksByGroup: {},
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      },
    } as any);

    await (runner as any).handleMessage(mkMsg({ messageId: 'wamid.readreceipt' }));

    // markAsRead calls fetch
    expect(mockFetch).toHaveBeenCalled();
    const readCall = mockFetch.mock.calls.find((call: any[]) => {
      try {
        const body = JSON.parse(call[1].body);
        return body.status === 'read';
      } catch {
        return false;
      }
    });
    expect(readCall).toBeDefined();

    jest.restoreAllMocks();
  });

  test('challenge-response verification works', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
      verifyToken: 'my-verify-token',
    });

    // Valid challenge
    const validResult = await runner.handleWebhookGet({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-verify-token',
      'hub.challenge': 'challenge123',
    });
    expect(validResult.status).toBe(200);
    expect(validResult.body).toBe('challenge123');

    // Invalid token
    const invalidResult = await runner.handleWebhookGet({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge456',
    });
    expect(invalidResult.status).toBe(403);
  });

  test('webhook signature verification rejects invalid signatures', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
      appSecret: 'my-secret',
    });

    const result = await runner.handleWebhookPost('{"entry":[]}', {
      'x-hub-signature-256': 'sha256=invalid',
    });

    expect(result.status).toBe(403);
  });

  test('webhook processes valid signed payload', async () => {
    const { createHmac } = require('crypto');
    const secret = 'my-secret';
    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '15559876543' },
                messages: [
                  {
                    id: 'wamid.signed1',
                    from: '15551234567',
                    timestamp: '1704067200',
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
      appSecret: secret,
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    const result = await runner.handleWebhookPost(payload, { 'x-hub-signature-256': sig });
    expect(result.status).toBe(200);

    // Give async handleMessage time to execute
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('rejects malformed JSON body', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const result = await runner.handleWebhookPost('not-json', {});
    expect(result.status).toBe(400);
  });

  test('handles engine execution errors gracefully', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockRejectedValue(new Error('Engine boom'));

    // Should not throw
    await expect(
      (runner as any).handleMessage(mkMsg({ messageId: 'wamid.error1' }))
    ).resolves.toBeUndefined();

    jest.restoreAllMocks();
  });

  test('updateConfig updates the config', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const newCfg = { ...baseCfg, checks: { newCheck: { type: 'ai' as any } } } as any;
    runner.updateConfig(newCfg);
    expect((runner as any).cfg).toBe(newCfg);
  });

  test('getClient returns the WhatsAppClient', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const client = runner.getClient();
    expect(client.getPhoneNumberId()).toBe('15559876543');
  });

  test('setTaskStore sets the task store', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const fakeStore = { addTask: jest.fn() } as any;
    runner.setTaskStore(fakeStore, '/path/to/config');
    expect((runner as any).taskStore).toBe(fakeStore);
    expect((runner as any).configPath).toBe('/path/to/config');
  });

  test('accepts messages with caption from media types', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new WhatsAppWebhookRunner(engine, baseCfg, {
      accessToken: 'test-token',
      phoneNumberId: '15559876543',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    await (runner as any).handleMessage(
      mkMsg({
        messageId: 'wamid.caption1',
        type: 'image',
        text: undefined,
        caption: 'Check this image',
      })
    );

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
