/**
 * Unit tests for toSlackMessageTrigger conversion function
 */
import { toSlackMessageTrigger } from '../../../src/scheduler/store/types';
import type { MessageTrigger } from '../../../src/scheduler/store/types';

describe('toSlackMessageTrigger', () => {
  function makeTrigger(overrides: Partial<MessageTrigger> = {}): MessageTrigger {
    return {
      id: 'trigger-1',
      creatorId: 'U123',
      fromBots: false,
      threads: 'any',
      workflow: 'handle-cicd',
      status: 'active',
      enabled: true,
      createdAt: 1700000000000,
      ...overrides,
    };
  }

  it('should map all fields from MessageTrigger to SlackMessageTrigger', () => {
    const trigger = makeTrigger({
      channels: ['C0CICD', 'CSEC'],
      fromUsers: ['U456'],
      fromBots: true,
      contains: ['failed', 'error'],
      matchPattern: 'build.*failed',
      threads: 'root_only',
      workflow: 'alert-handler',
      inputs: { severity: 'high' },
      outputContext: { type: 'slack', target: 'C0ALERT', threadId: '123.456' },
      description: 'CI failure watcher',
      enabled: true,
    });

    const result = toSlackMessageTrigger(trigger);

    expect(result.channels).toEqual(['C0CICD', 'CSEC']);
    expect(result.from).toEqual(['U456']);
    expect(result.from_bots).toBe(true);
    expect(result.contains).toEqual(['failed', 'error']);
    expect(result.match).toBe('build.*failed');
    expect(result.threads).toBe('root_only');
    expect(result.workflow).toBe('alert-handler');
    expect(result.inputs).toEqual({ severity: 'high' });
    expect(result.output).toEqual({
      type: 'slack',
      target: 'C0ALERT',
      thread_id: '123.456',
    });
    expect(result.description).toBe('CI failure watcher');
    expect(result.enabled).toBe(true);
  });

  it('should map fromUsers → from (field rename)', () => {
    const trigger = makeTrigger({ fromUsers: ['U1', 'U2'] });
    const result = toSlackMessageTrigger(trigger);
    expect(result.from).toEqual(['U1', 'U2']);
  });

  it('should map matchPattern → match (field rename)', () => {
    const trigger = makeTrigger({ matchPattern: 'error\\d+' });
    const result = toSlackMessageTrigger(trigger);
    expect(result.match).toBe('error\\d+');
  });

  it('should map outputContext.threadId → output.thread_id (nested field rename)', () => {
    const trigger = makeTrigger({
      outputContext: { type: 'slack', target: '#channel', threadId: '111.222' },
    });
    const result = toSlackMessageTrigger(trigger);
    expect(result.output?.thread_id).toBe('111.222');
  });

  it('should handle undefined optional fields', () => {
    const trigger = makeTrigger({
      channels: undefined,
      fromUsers: undefined,
      contains: undefined,
      matchPattern: undefined,
      inputs: undefined,
      outputContext: undefined,
      description: undefined,
    });

    const result = toSlackMessageTrigger(trigger);

    expect(result.channels).toBeUndefined();
    expect(result.from).toBeUndefined();
    expect(result.contains).toBeUndefined();
    expect(result.match).toBeUndefined();
    expect(result.inputs).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('should cast output type to the correct union', () => {
    for (const type of ['slack', 'github', 'webhook', 'none'] as const) {
      const trigger = makeTrigger({
        outputContext: { type },
      });
      const result = toSlackMessageTrigger(trigger);
      expect(result.output?.type).toBe(type);
    }
  });

  it('should not include DB-only fields (id, creatorId, createdAt, status)', () => {
    const trigger = makeTrigger();
    const result = toSlackMessageTrigger(trigger);

    // These DB-model fields should not appear on the config model
    expect((result as any).id).toBeUndefined();
    expect((result as any).creatorId).toBeUndefined();
    expect((result as any).createdAt).toBeUndefined();
    expect((result as any).status).toBeUndefined();
  });
});
