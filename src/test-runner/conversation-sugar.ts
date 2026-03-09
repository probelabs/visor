/**
 * Expands the `conversation:` sugar format into a standard `flow:` array.
 *
 * Input format:
 * ```yaml
 * - name: my-test
 *   conversation:
 *     transport: slack          # optional, default: slack
 *     thread_id: "test-thread"  # optional, auto-generated if missing
 *     fixture: local.minimal    # optional, default: local.minimal
 *     routing: { max_loops: 0 } # optional, default: { max_loops: 0 }
 *     turns:
 *       - role: user
 *         text: "Hello"
 *         mocks:
 *           chat: { text: "Hi!", intent: chat }
 *         expect:
 *           outputs: [...]
 *           llm_judge: [...]
 * ```
 *
 * Or shorthand (turns directly under conversation):
 * ```yaml
 * - name: my-test
 *   conversation:
 *     - role: user
 *       text: "Hello"
 *       mocks: ...
 *       expect: ...
 * ```
 */

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  mocks?: Record<string, unknown>;
  expect?: Record<string, unknown>;
}

export interface ConversationConfig {
  transport?: string;
  thread_id?: string;
  fixture?: string;
  routing?: Record<string, unknown>;
  turns?: ConversationTurn[];
  // Allow array shorthand at top level
  [index: number]: ConversationTurn;
}

export function expandConversationToFlow(testCase: any): any {
  const conv = testCase.conversation;
  if (!conv) return testCase;

  // Support both array shorthand and object with turns
  let turns: ConversationTurn[];
  let transport = 'slack';
  let threadId = `conv-${testCase.name || 'test'}-${Date.now()}`;
  let fixture = 'local.minimal';
  let routing: Record<string, unknown> = { max_loops: 0 };

  if (Array.isArray(conv)) {
    turns = conv;
  } else {
    turns = conv.turns || [];
    if (conv.transport) transport = conv.transport;
    if (conv.thread_id) threadId = conv.thread_id;
    if (conv.fixture) fixture = conv.fixture;
    if (conv.routing) routing = conv.routing;
  }

  if (turns.length === 0) return testCase;

  // Build flow stages from turns, only user turns become stages
  const flow: any[] = [];
  const messageHistory: Array<{ role: string; text: string }> = [];
  let turnNumber = 0; // 1-based turn counter for user turns

  for (const turn of turns) {
    if (turn.role === 'assistant') {
      // Assistant turns just add to message history (typically mock responses)
      messageHistory.push({ role: 'assistant', text: turn.text });
      continue;
    }

    turnNumber++;
    // Add the user message to history for this stage
    const currentMessages = [...messageHistory, { role: 'user', text: turn.text }];

    // Transform turn-based llm_judge references
    const expect = turn.expect ? transformExpectTurns(turn.expect, turnNumber) : undefined;

    const stage: any = {
      name: `turn-${turnNumber}`,
      event: 'manual',
      fixture,
      routing: { ...routing },
      execution_context: {
        conversation: {
          transport,
          thread: { id: threadId },
          messages: [...currentMessages],
          current: { role: 'user', text: turn.text },
        },
      },
      ...(turn.mocks ? { mocks: turn.mocks } : {}),
      ...(expect ? { expect } : {}),
    };

    flow.push(stage);

    // After this stage, add user message + assumed assistant response to history
    messageHistory.push({ role: 'user', text: turn.text });
    // Look for mock response text to add as assistant message for next turn.
    // Record the index so the runner can replace it with the real response in --no-mocks mode.
    const assistantText = extractMockResponseText(turn.mocks);
    if (assistantText) {
      stage._mockAssistantMsgIndex = messageHistory.length; // index of the assistant msg about to be pushed
      messageHistory.push({ role: 'assistant', text: assistantText });
    }
  }

  // Return new case with flow instead of conversation
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { conversation: _conv, ...rest } = testCase;
  return { ...rest, flow, _conversationSugar: true };
}

/**
 * Transform `turn: N` references in llm_judge expectations to `index: N-1`.
 * `turn: 'current'` maps to `index: 'last'`.
 */
function transformExpectTurns(expect: any, _currentTurn: number): any {
  if (!expect || typeof expect !== 'object') return expect;
  const result = { ...expect };

  if (Array.isArray(result.llm_judge)) {
    result.llm_judge = result.llm_judge.map((judge: any) => {
      if (judge.turn === undefined) return judge;
      const { turn, ...rest } = judge;
      let index: number | 'first' | 'last';
      if (turn === 'current') {
        index = 'last';
      } else if (typeof turn === 'number') {
        index = turn - 1; // turn is 1-based, index is 0-based
      } else {
        return judge;
      }
      return { ...rest, index };
    });
  }

  // Also support turn in outputs expectations
  if (Array.isArray(result.outputs)) {
    result.outputs = result.outputs.map((out: any) => {
      if (out.turn === undefined) return out;
      const { turn, ...rest } = out;
      let index: number | 'first' | 'last';
      if (turn === 'current') {
        index = 'last';
      } else if (typeof turn === 'number') {
        index = turn - 1;
      } else {
        return out;
      }
      return { ...rest, index };
    });
  }

  return result;
}

/**
 * Extract the mock response text to use as assistant message in history.
 * Handles both direct mocks and array mocks.
 */
function extractMockResponseText(mocks: Record<string, unknown> | undefined): string | undefined {
  if (!mocks) return undefined;

  // Look for common chat step names
  for (const key of Object.keys(mocks)) {
    const mock = mocks[key];
    if (typeof mock === 'object' && mock !== null && !Array.isArray(mock)) {
      const text = (mock as any).text;
      if (typeof text === 'string') return text;
    }
    if (Array.isArray(mock) && mock.length > 0) {
      const first = mock[0];
      if (typeof first === 'object' && first !== null) {
        const text = (first as any).text;
        if (typeof text === 'string') return text;
      }
    }
  }

  return undefined;
}
