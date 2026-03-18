import { GracefulRestartManager } from '../../../src/runners/graceful-restart';
import { RunnerHost } from '../../../src/runners/runner-host';
import type { Runner } from '../../../src/runners/runner';
import * as childProcess from 'child_process';

jest.mock('child_process');

/** Create a mock Runner with jest.fn() methods. */
function mockRunner(name: string, overrides?: Partial<Runner>): Runner {
  return {
    name,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    updateConfig: jest.fn(),
    ...overrides,
  };
}

/** Create a fake child process EventEmitter with mock methods. */
function createFakeChild(opts?: { autoReady?: boolean; exitCode?: number }): any {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  emitter.kill = jest.fn();
  emitter.killed = false;
  emitter.unref = jest.fn();
  emitter.disconnect = jest.fn();
  emitter.connected = true;

  if (opts?.autoReady) {
    const origOn = emitter.on.bind(emitter);
    emitter.on = (event: string, listener: (...args: any[]) => void) => {
      origOn(event, listener);
      if (event === 'message') {
        setImmediate(() => emitter.emit('message', { type: 'ready' }));
      }
      return emitter;
    };
  }

  if (opts?.exitCode !== undefined) {
    const origOn = emitter.on.bind(emitter);
    emitter.on = (event: string, listener: (...args: any[]) => void) => {
      origOn(event, listener);
      if (event === 'exit') {
        setImmediate(() => emitter.emit('exit', opts.exitCode, null));
      }
      return emitter;
    };
  }

  return emitter;
}

describe('GracefulRestartManager', () => {
  let host: RunnerHost;

  beforeEach(() => {
    host = new RunnerHost();
    jest.clearAllMocks();
  });

  it('prevents double restart', async () => {
    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockResolvedValue(undefined),
      drain: jest.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    });
    host.addRunner(r1);

    const fakeChild = createFakeChild({ autoReady: true });
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);

    const manager = new GracefulRestartManager(host, {
      child_ready_timeout_ms: 100,
    });

    // Start first restart (will hang on drain after spawn)
    manager.initiateRestart();
    // Give time for stopListening + spawn + ready
    await new Promise(resolve => setTimeout(resolve, 50));

    // Second call should be ignored
    await manager.initiateRestart();
    expect(manager.isRestarting).toBe(true);
  });

  it('stops listening before spawning, then drains in parallel', async () => {
    const callOrder: string[] = [];
    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockImplementation(async () => {
        callOrder.push('stopListening');
      }),
      drain: jest.fn().mockImplementation(async () => {
        callOrder.push('drain');
      }),
    });
    host.addRunner(r1);

    const manager = new GracefulRestartManager(host);

    const fakeChild = createFakeChild({ autoReady: true });
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await manager.initiateRestart();

    // stopListening must happen BEFORE spawn, drain happens AFTER
    expect(callOrder).toEqual(['stopListening', 'drain']);
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
  });

  it('spawns child with correct args for direct execution', async () => {
    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockResolvedValue(undefined),
      drain: jest.fn().mockResolvedValue(undefined),
    });
    host.addRunner(r1);

    const manager = new GracefulRestartManager(host);

    const fakeChild = createFakeChild({ autoReady: true });
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await manager.initiateRestart();

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = (childProcess.spawn as jest.Mock).mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(process.argv.slice(1));
    expect(opts.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
    expect(opts.env.VISOR_RESTART_GENERATION).toBe('1');

    exitSpy.mockRestore();
  });

  it('detects npx and uses npx command', async () => {
    const origUserAgent = process.env.npm_config_user_agent;
    process.env.npm_config_user_agent = 'npm/10.0.0 npx/10.0.0 node/v20.0.0';

    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockResolvedValue(undefined),
      drain: jest.fn().mockResolvedValue(undefined),
    });
    host.addRunner(r1);

    const manager = new GracefulRestartManager(host);

    const fakeChild = createFakeChild({ autoReady: true });
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await manager.initiateRestart();

    const [cmd, args] = (childProcess.spawn as jest.Mock).mock.calls[0];
    expect(cmd).toBe('npx');
    expect(args[0]).toBe('-y');
    expect(args[1]).toBe('@probelabs/visor@latest');

    process.env.npm_config_user_agent = origUserAgent;
    exitSpy.mockRestore();
  });

  it('uses restart_command config override', async () => {
    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockResolvedValue(undefined),
      drain: jest.fn().mockResolvedValue(undefined),
    });
    host.addRunner(r1);

    const manager = new GracefulRestartManager(host, {
      restart_command: '/usr/bin/visor --slack --config /etc/visor.yaml',
    });

    const fakeChild = createFakeChild({ autoReady: true });
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await manager.initiateRestart();

    const [cmd, args] = (childProcess.spawn as jest.Mock).mock.calls[0];
    expect(cmd).toBe('/usr/bin/visor');
    expect(args).toEqual(['--slack', '--config', '/etc/visor.yaml']);

    exitSpy.mockRestore();
  });

  it('aborts if child fails to become ready', async () => {
    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockResolvedValue(undefined),
    });
    host.addRunner(r1);

    const manager = new GracefulRestartManager(host, {
      child_ready_timeout_ms: 100,
    });

    // Child that never sends ready
    const fakeChild = createFakeChild();
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);

    await manager.initiateRestart();

    // Should abort and reset
    expect(manager.isRestarting).toBe(false);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('aborts if child exits before ready', async () => {
    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockResolvedValue(undefined),
    });
    host.addRunner(r1);

    const manager = new GracefulRestartManager(host, {
      child_ready_timeout_ms: 5000,
    });

    const fakeChild = createFakeChild({ exitCode: 1 });
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);

    await manager.initiateRestart();

    expect(manager.isRestarting).toBe(false);
  });

  it('runs cleanup callbacks before exit', async () => {
    const r1 = mockRunner('slack', {
      stopListening: jest.fn().mockResolvedValue(undefined),
      drain: jest.fn().mockResolvedValue(undefined),
    });
    host.addRunner(r1);

    const manager = new GracefulRestartManager(host);
    const cleanupFn = jest.fn().mockResolvedValue(undefined);
    manager.onCleanup(cleanupFn);

    const fakeChild = createFakeChild({ autoReady: true });
    (childProcess.spawn as jest.Mock).mockReturnValue(fakeChild);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await manager.initiateRestart();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});

describe('RunnerHost.drainAll', () => {
  it('calls drain on runners that support it', async () => {
    const host = new RunnerHost();
    const drainFn = jest.fn().mockResolvedValue(undefined);
    const r1 = mockRunner('slack', { drain: drainFn });
    const r2 = mockRunner('telegram'); // no drain
    host.addRunner(r1);
    host.addRunner(r2);

    await host.drainAll();

    expect(drainFn).toHaveBeenCalledTimes(1);
    expect(r2.stop).toHaveBeenCalledTimes(1); // fallback to stop
  });

  it('waits indefinitely by default', async () => {
    const host = new RunnerHost();
    let resolveDrain: () => void;
    const drainPromise = new Promise<void>(resolve => {
      resolveDrain = resolve;
    });
    const r1 = mockRunner('slack', {
      drain: jest.fn().mockReturnValue(drainPromise),
    });
    host.addRunner(r1);

    let drained = false;
    const p = host.drainAll().then(() => {
      drained = true;
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(drained).toBe(false);

    resolveDrain!();
    await p;
    expect(drained).toBe(true);
  });
});

describe('RunnerHost.stopListeningAll', () => {
  it('calls stopListening on runners that support it', async () => {
    const host = new RunnerHost();
    const stopListeningFn = jest.fn().mockResolvedValue(undefined);
    const r1 = mockRunner('slack', { stopListening: stopListeningFn });
    const r2 = mockRunner('telegram'); // no stopListening
    host.addRunner(r1);
    host.addRunner(r2);

    await host.stopListeningAll();

    expect(stopListeningFn).toHaveBeenCalledTimes(1);
    // r2 has no stopListening — should not throw
  });
});
