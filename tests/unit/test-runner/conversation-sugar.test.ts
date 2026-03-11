import { expandConversationToFlow } from '../../../src/test-runner/conversation-sugar';

describe('expandConversationToFlow', () => {
  it('returns case unchanged when no conversation field', () => {
    const tc = { name: 'no-conv', event: 'manual', expect: {} };
    expect(expandConversationToFlow(tc)).toBe(tc);
  });

  it('expands array shorthand into flow stages', () => {
    const tc = {
      name: 'basic-conv',
      conversation: [
        {
          role: 'user',
          text: 'Hello',
          mocks: { chat: { text: 'Hi there!', intent: 'chat' } },
          expect: { calls: [{ step: 'chat', exactly: 1 }] },
        },
        {
          role: 'user',
          text: 'How are you?',
          mocks: { chat: { text: 'I am fine.', intent: 'chat' } },
          expect: { calls: [{ step: 'chat', exactly: 1 }] },
        },
      ],
    };

    const result = expandConversationToFlow(tc);

    // Should have flow, not conversation
    expect(result.conversation).toBeUndefined();
    expect(result.flow).toHaveLength(2);

    // Stage 1: only user message
    const s1 = result.flow[0];
    expect(s1.name).toBe('turn-1');
    expect(s1.event).toBe('manual');
    expect(s1.execution_context.conversation.messages).toEqual([{ role: 'user', text: 'Hello' }]);
    expect(s1.execution_context.conversation.current).toEqual({ role: 'user', text: 'Hello' });
    expect(s1.mocks).toEqual({ chat: { text: 'Hi there!', intent: 'chat' } });

    // Stage 2: accumulated history
    const s2 = result.flow[1];
    expect(s2.name).toBe('turn-2');
    expect(s2.execution_context.conversation.messages).toEqual([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi there!' },
      { role: 'user', text: 'How are you?' },
    ]);
    expect(s2.execution_context.conversation.current).toEqual({
      role: 'user',
      text: 'How are you?',
    });
  });

  it('expands object format with config overrides', () => {
    const tc = {
      name: 'obj-conv',
      conversation: {
        transport: 'cli',
        thread_id: 'custom-thread',
        fixture: 'custom.fixture',
        routing: { max_loops: 2 },
        turns: [
          {
            role: 'user',
            text: 'Test',
            mocks: { chat: { text: 'Response', intent: 'chat' } },
          },
        ],
      },
    };

    const result = expandConversationToFlow(tc);
    const s1 = result.flow[0];

    expect(s1.fixture).toBe('custom.fixture');
    expect(s1.routing).toEqual({ max_loops: 2 });
    expect(s1.execution_context.conversation.transport).toBe('cli');
    expect(s1.execution_context.conversation.thread.id).toBe('custom-thread');
  });

  it('transforms turn references to index in llm_judge', () => {
    const tc = {
      name: 'turn-ref',
      conversation: [
        {
          role: 'user',
          text: 'First',
          mocks: { chat: { text: 'R1', intent: 'chat' } },
        },
        {
          role: 'user',
          text: 'Second',
          mocks: { chat: { text: 'R2', intent: 'chat' } },
          expect: {
            llm_judge: [
              { step: 'chat', turn: 1, path: 'text', prompt: 'Was turn 1 good?' },
              { step: 'chat', turn: 'current', path: 'text', prompt: 'Is current good?' },
            ],
          },
        },
      ],
    };

    const result = expandConversationToFlow(tc);
    const s2 = result.flow[1];

    // turn: 1 -> index: 0
    expect(s2.expect.llm_judge[0].index).toBe(0);
    expect(s2.expect.llm_judge[0].turn).toBeUndefined();

    // turn: 'current' -> index: 'last'
    expect(s2.expect.llm_judge[1].index).toBe('last');
    expect(s2.expect.llm_judge[1].turn).toBeUndefined();
  });

  it('transforms turn references in outputs expectations', () => {
    const tc = {
      name: 'turn-outputs',
      conversation: [
        {
          role: 'user',
          text: 'First',
          mocks: { chat: { text: 'R1', intent: 'chat' } },
        },
        {
          role: 'user',
          text: 'Second',
          mocks: { chat: { text: 'R2', intent: 'chat' } },
          expect: {
            outputs: [
              { step: 'chat', turn: 1, path: 'text', matches: 'R1' },
              { step: 'chat', turn: 'current', path: 'text', matches: 'R2' },
            ],
          },
        },
      ],
    };

    const result = expandConversationToFlow(tc);
    const s2 = result.flow[1];

    expect(s2.expect.outputs[0].index).toBe(0);
    expect(s2.expect.outputs[1].index).toBe('last');
  });

  it('handles assistant turns in conversation (adds to history only)', () => {
    const tc = {
      name: 'with-assistant',
      conversation: [
        {
          role: 'user',
          text: 'Hello',
          mocks: { chat: { text: 'Hi!', intent: 'chat' } },
        },
        {
          role: 'assistant',
          text: 'Custom assistant text (overrides mock)',
        },
        {
          role: 'user',
          text: 'Follow up',
          mocks: { chat: { text: 'Sure', intent: 'chat' } },
        },
      ],
    };

    const result = expandConversationToFlow(tc);

    // Only 2 flow stages (user turns only)
    expect(result.flow).toHaveLength(2);

    // Stage 2 should have assistant text from explicit assistant turn
    const s2 = result.flow[1];
    expect(s2.execution_context.conversation.messages).toEqual([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi!' },
      { role: 'assistant', text: 'Custom assistant text (overrides mock)' },
      { role: 'user', text: 'Follow up' },
    ]);
  });

  it('preserves other case properties', () => {
    const tc = {
      name: 'keep-props',
      strict: true,
      tags: 'fast',
      conversation: [
        { role: 'user', text: 'Hi', mocks: { chat: { text: 'Hello', intent: 'chat' } } },
      ],
    };

    const result = expandConversationToFlow(tc);
    expect(result.strict).toBe(true);
    expect(result.tags).toBe('fast');
    expect(result.name).toBe('keep-props');
  });

  it('returns empty flow for empty turns', () => {
    const tc = { name: 'empty', conversation: [] };
    const result = expandConversationToFlow(tc);
    // No flow generated, no conversation — effectively passthrough
    expect(result).toEqual(tc);
  });

  it('extracts mock text from array mocks', () => {
    const tc = {
      name: 'array-mock',
      conversation: [
        {
          role: 'user',
          text: 'First',
          mocks: { 'chat[]': [{ text: 'Response 1', intent: 'chat' }] },
        },
        {
          role: 'user',
          text: 'Second',
          mocks: { chat: { text: 'R2', intent: 'chat' } },
        },
      ],
    };

    const result = expandConversationToFlow(tc);
    const s2 = result.flow[1];

    // Should pick up text from array mock for history
    expect(s2.execution_context.conversation.messages).toEqual([
      { role: 'user', text: 'First' },
      { role: 'assistant', text: 'Response 1' },
      { role: 'user', text: 'Second' },
    ]);
  });

  it('passes per-turn user into conversation.current', () => {
    const tc = {
      name: 'multi-user',
      conversation: [
        {
          role: 'user',
          text: 'Hello from user 1',
          user: 'user-1',
          mocks: { chat: { text: 'Hi user 1!', intent: 'chat' } },
        },
        {
          role: 'user',
          text: 'Hello from user 2',
          user: 'user-2',
          mocks: { chat: { text: 'Hi user 2!', intent: 'chat' } },
        },
      ],
    };

    const result = expandConversationToFlow(tc);

    // Stage 1: user-1
    expect(result.flow[0].execution_context.conversation.current).toEqual({
      role: 'user',
      text: 'Hello from user 1',
      user: 'user-1',
    });

    // Stage 2: user-2
    expect(result.flow[1].execution_context.conversation.current).toEqual({
      role: 'user',
      text: 'Hello from user 2',
      user: 'user-2',
    });
  });

  it('omits user from current when not specified on turn', () => {
    const tc = {
      name: 'no-user',
      conversation: [
        { role: 'user', text: 'Hi', mocks: { chat: { text: 'Hello', intent: 'chat' } } },
      ],
    };

    const result = expandConversationToFlow(tc);
    expect(result.flow[0].execution_context.conversation.current).toEqual({
      role: 'user',
      text: 'Hi',
    });
    // No user key at all
    expect('user' in result.flow[0].execution_context.conversation.current).toBe(false);
  });

  it('uses default values for transport, fixture, routing', () => {
    const tc = {
      name: 'defaults',
      conversation: [{ role: 'user', text: 'Hi' }],
    };

    const result = expandConversationToFlow(tc);
    const s1 = result.flow[0];

    expect(s1.fixture).toBe('local.minimal');
    expect(s1.routing).toEqual({ max_loops: 0 });
    expect(s1.execution_context.conversation.transport).toBe('slack');
  });
});
