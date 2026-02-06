import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import { getPromptStateManager, resetPromptStateManager } from '../../src/slack/prompt-state';

// Mock resumeFromSnapshot from the engine module (used via dynamic import inside the runner)
jest.mock('../../src/state-machine-execution-engine', () => {
  const real = jest.requireActual('../../src/state-machine-execution-engine');
  return {
    ...real,
    resumeFromSnapshot: jest.fn(async () => ({
      results: { default: [] },
      statistics: {
        totalChecks: 1,
        checksByGroup: {},
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      },
    })),
  };
});

describe('Slack resume from snapshot (integration-lite)', () => {
  beforeEach(() => resetPromptStateManager());

  test('socket runner loads snapshot and calls resumeFromSnapshot instead of cold run', async () => {
    const engine = new StateMachineExecutionEngine();
    const cfg: VisorConfig = {
      version: '1.0',
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      checks: { ask: { type: 'human-input' as any } },
    } as any;
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
    });

    // Prepare prompt-state with snapshot path
    const mgr = getPromptStateManager();
    mgr.setWaiting('C1', '111.333', {
      checkName: 'ask',
      prompt: 'Your name?',
      promptMessageTs: '111.334',
    });
    mgr.update('C1', '111.333', { snapshotPath: '/tmp/snap.json' });

    // Mock engine.loadSnapshotFromFile to return a minimal snapshot JSON
    const snapshot = {
      version: 1,
      sessionId: 'sess',
      state: {
        currentState: 'Routing',
        wave: 1,
        levelQueue: [],
        eventQueue: [],
        activeDispatches: [],
        completedChecks: [],
        stats: [],
        historyLog: [],
        forwardRunGuards: [],
        currentLevelChecks: [],
        pendingRunScopes: [],
      },
      journal: [],
      requestedChecks: ['ask'],
    };
    jest
      .spyOn((StateMachineExecutionEngine as any).prototype, 'loadSnapshotFromFile')
      .mockResolvedValue(snapshot);

    // Spy on cold run path to ensure it is NOT called
    const coldSpy = jest.spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks');

    // Build a Slack events_api envelope for the same thread
    const env = {
      type: 'events_api',
      envelope_id: 'e1',
      payload: { event: { type: 'app_mention', channel: 'C1', ts: '111.333', text: 'Alice' } },
    };

    // Call private handleMessage for direct testing
    await (runner as any).handleMessage(JSON.stringify(env));

    // Assert that snapshot load was attempted and cold run was skipped
    const loadSpy = (StateMachineExecutionEngine as any).prototype
      .loadSnapshotFromFile as jest.Mock;
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(coldSpy).not.toHaveBeenCalled();
  });
});
