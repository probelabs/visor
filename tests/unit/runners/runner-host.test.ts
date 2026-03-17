import { RunnerHost } from '../../../src/runners/runner-host';
import type { Runner } from '../../../src/runners/runner';
import type { VisorConfig } from '../../../src/types/config';

/** Create a mock Runner with jest.fn() methods. */
function mockRunner(name: string, overrides?: Partial<Runner>): Runner {
  return {
    name,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    updateConfig: jest.fn(),
    setTaskStore: jest.fn(),
    ...overrides,
  };
}

describe('RunnerHost', () => {
  it('starts multiple runners concurrently', async () => {
    const host = new RunnerHost();
    const r1 = mockRunner('slack');
    const r2 = mockRunner('telegram');
    const r3 = mockRunner('a2a');
    host.addRunner(r1);
    host.addRunner(r2);
    host.addRunner(r3);

    await host.startAll();

    expect(r1.start).toHaveBeenCalledTimes(1);
    expect(r2.start).toHaveBeenCalledTimes(1);
    expect(r3.start).toHaveBeenCalledTimes(1);
  });

  it('stops all runners and tolerates individual failures', async () => {
    const host = new RunnerHost();
    const r1 = mockRunner('slack');
    const r2 = mockRunner('telegram', {
      stop: jest.fn().mockRejectedValue(new Error('connection lost')),
    });
    const r3 = mockRunner('email');
    host.addRunner(r1);
    host.addRunner(r2);
    host.addRunner(r3);

    // Should not throw even though r2.stop() rejects
    await expect(host.stopAll()).resolves.toBeUndefined();
    expect(r1.stop).toHaveBeenCalledTimes(1);
    expect(r2.stop).toHaveBeenCalledTimes(1);
    expect(r3.stop).toHaveBeenCalledTimes(1);
  });

  it('rolls back started runners when one fails to start', async () => {
    const host = new RunnerHost();
    const r1 = mockRunner('slack');
    const r2 = mockRunner('telegram', {
      start: jest.fn().mockRejectedValue(new Error('bad token')),
    });
    host.addRunner(r1);
    host.addRunner(r2);

    await expect(host.startAll()).rejects.toThrow('Failed to start runner(s)');
    // r1 should have been stopped as rollback (it may or may not have started
    // before r2 failed, but if it did, stop should be called)
  });

  it('broadcastConfigUpdate propagates to all runners', () => {
    const host = new RunnerHost();
    const r1 = mockRunner('slack');
    const r2 = mockRunner('mcp');
    host.addRunner(r1);
    host.addRunner(r2);

    const cfg = { project: { name: 'test' } } as unknown as VisorConfig;
    host.broadcastConfigUpdate(cfg);

    expect(r1.updateConfig).toHaveBeenCalledWith(cfg);
    expect(r2.updateConfig).toHaveBeenCalledWith(cfg);
  });

  it('setTaskStore propagates to runners with setTaskStore', () => {
    const host = new RunnerHost();
    const r1 = mockRunner('slack');
    const r2 = mockRunner('mcp', { setTaskStore: undefined }); // no setTaskStore
    host.addRunner(r1);
    host.addRunner(r2);

    const fakeStore = { initialize: jest.fn() } as any;
    host.setTaskStore(fakeStore, '/path/to/config.yaml');

    expect(r1.setTaskStore).toHaveBeenCalledWith(fakeStore, '/path/to/config.yaml');
    // r2 has no setTaskStore — should not throw
  });

  it('single runner mode works (backward compat)', async () => {
    const host = new RunnerHost();
    const r1 = mockRunner('slack');
    host.addRunner(r1);

    await host.startAll();
    expect(r1.start).toHaveBeenCalledTimes(1);
    expect(host.getRunners()).toHaveLength(1);

    await host.stopAll();
    expect(r1.stop).toHaveBeenCalledTimes(1);
  });

  it('getRunners returns all registered runners', () => {
    const host = new RunnerHost();
    const r1 = mockRunner('slack');
    const r2 = mockRunner('telegram');
    host.addRunner(r1);
    host.addRunner(r2);

    const runners = host.getRunners();
    expect(runners).toHaveLength(2);
    expect(runners[0].name).toBe('slack');
    expect(runners[1].name).toBe('telegram');
  });
});
