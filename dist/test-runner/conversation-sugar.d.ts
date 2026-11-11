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
    /** Optional user identifier, exposed as `conversation.current.user` in Liquid templates.
     *  Useful for simulating multi-user (group chat) scenarios in tests. */
    user?: string;
    /** Fire this turn in the background without waiting for the response.
     *  The next turn will start immediately, useful for testing progress/status
     *  queries while a long-running task is still executing. */
    background?: boolean;
    /** Delay in milliseconds before executing this turn.
     *  Useful after a background turn to give it time to start. */
    delay_ms?: number;
    mocks?: Record<string, unknown>;
    expect?: Record<string, unknown>;
}
export interface ConversationConfig {
    transport?: string;
    thread_id?: string;
    fixture?: string;
    routing?: Record<string, unknown>;
    turns?: ConversationTurn[];
    [index: number]: ConversationTurn;
}
export declare function expandConversationToFlow(testCase: any): any;
//# sourceMappingURL=conversation-sugar.d.ts.map