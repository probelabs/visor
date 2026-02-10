import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

/**
 * Regression test: `assume` expressions referencing `conversation.current.text`
 * must work when conversation is injected via Slack's webhookContext path
 * (providerConfig.eventContext.conversation), not just executionContext.conversation.
 *
 * Before the fix, Slack mode crashed with:
 *   "conversation.current.text != null TypeError: Cannot get property current of null"
 * because `assume` only read from executionContext.conversation (the TUI/CLI path).
 */
describe('assume: conversation from Slack webhook context', () => {
  const makeConversation = (text: string) => ({
    transport: 'slack',
    messages: [{ role: 'user', text, timestamp: new Date().toISOString() }],
    current: { role: 'user', text, timestamp: new Date().toISOString() },
  });

  const makeConfig = (assumeExpr: string): VisorConfig =>
    ({
      version: '1.0',
      output: { pr_comment: { enabled: false } } as any,
      checks: {
        guarded: {
          type: 'script',
          assume: assumeExpr,
          content: 'return { ok: true };',
        } as any,
      },
    }) as any;

  it('runs check when conversation.current.text is available via Slack webhookContext', async () => {
    const cfg = makeConfig(
      'conversation != null && conversation.current != null && conversation.current.text != null'
    );
    const engine = new StateMachineExecutionEngine();

    // Simulate Slack path: conversation via webhookContext.webhookData (slack_conversation)
    const webhookData = new Map<string, unknown>();
    webhookData.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '1234.5', text: 'Hello bot!' },
      slack_conversation: makeConversation('Hello bot!'),
    });
    (engine as any).setExecutionContext({
      webhookContext: { webhookData },
    });

    const res = await engine.executeChecks({
      checks: ['guarded'],
      config: cfg,
      debug: false,
    });

    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    // The check should have run (not skipped by assume)
    expect(byName['guarded']?.totalRuns).toBe(1);
  });

  it('runs check when conversation is available via executionContext (TUI/CLI path)', async () => {
    const cfg = makeConfig(
      'conversation != null && conversation.current != null && conversation.current.text != null'
    );
    const engine = new StateMachineExecutionEngine();

    // Simulate TUI/CLI path: conversation directly on executionContext
    (engine as any).setExecutionContext({
      conversation: makeConversation('Hello from CLI!'),
    });

    const res = await engine.executeChecks({
      checks: ['guarded'],
      config: cfg,
      debug: false,
    });

    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    expect(byName['guarded']?.totalRuns).toBe(1);
  });

  it('skips check when no conversation is available (assume evaluates to false)', async () => {
    const cfg = makeConfig(
      'conversation != null && conversation.current != null && conversation.current.text != null'
    );
    const engine = new StateMachineExecutionEngine();

    // No conversation injected at all
    const res = await engine.executeChecks({
      checks: ['guarded'],
      config: cfg,
      debug: false,
    });

    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    // Should be skipped (assume evaluates to false/throws → check does not run)
    expect(byName['guarded']?.totalRuns || 0).toBe(0);
  });

  it('does not crash when assume uses conversation.current.text with Slack data', async () => {
    // This is the exact expression from the user's production config that caused the crash
    const cfg = makeConfig('conversation.current.text != null');
    const engine = new StateMachineExecutionEngine();

    // Slack path: only webhookContext, no executionContext.conversation
    const webhookData = new Map<string, unknown>();
    webhookData.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '9999.1', text: 'test message' },
      slack_conversation: makeConversation('test message'),
    });
    (engine as any).setExecutionContext({
      webhookContext: { webhookData },
    });

    // Should not throw "Cannot get property current of null"
    const res = await engine.executeChecks({
      checks: ['guarded'],
      config: cfg,
      debug: false,
    });

    const byName: Record<string, any> = {};
    for (const s of res.executionStatistics?.checks || []) byName[s.checkName] = s;
    expect(byName['guarded']?.totalRuns).toBe(1);
  });
});
