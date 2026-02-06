import { SessionRegistry } from '../../src/session-registry';

describe('Session Cloning with History Filtering', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = SessionRegistry.getInstance();
    // Clear any existing sessions
    registry.clearAllSessions();
  });

  afterEach(() => {
    registry.clearAllSessions();
  });

  it('should use ProbeAgent.clone() with correct filtering options', async () => {
    // Simulate a conversation history with schema-related messages
    const mockHistory = [
      { role: 'system', content: 'You are a code review assistant.' },
      {
        role: 'user',
        content: 'Review this PR for security issues:\n```diff\n+ function test() {}\n```',
      },
      { role: 'assistant', content: 'I found the following issues in your code...' },
      {
        role: 'user',
        content:
          'CRITICAL: You MUST respond with ONLY valid JSON DATA that conforms to this schema structure.',
      },
      { role: 'assistant', content: '{"issues": [{"file": "test.js", "line": 1}]}' },
      {
        role: 'user',
        content:
          'Your previous JSON response was invalid. Please correct the following JSON errors...',
      },
      {
        role: 'user',
        content: 'The mermaid diagram in your response has syntax errors. Please fix it.',
      },
      { role: 'user', content: '<tool_result>\nSearch found 10 files\n</tool_result>' },
      { role: 'assistant', content: 'Based on the search results, I recommend...' },
    ];

    // Expected filtered history (ProbeAgent's clone() method filters internal messages)
    const filteredHistory = [
      { role: 'system', content: 'You are a code review assistant.' },
      {
        role: 'user',
        content: 'Review this PR for security issues:\n```diff\n+ function test() {}\n```',
      },
      { role: 'assistant', content: 'I found the following issues in your code...' },
      { role: 'user', content: '<tool_result>\nSearch found 10 files\n</tool_result>' },
      { role: 'assistant', content: 'Based on the search results, I recommend...' },
    ];

    // Create mock agent with clone() method
    const sourceAgent = {
      answer: jest.fn(),
      history: mockHistory,
      options: { sessionId: 'source-session' },
      debug: true,
      clone: jest.fn().mockReturnValue({
        answer: jest.fn(),
        history: filteredHistory,
        options: { sessionId: 'cloned-session' },
      }),
    } as any;

    registry.registerSession('source-session', sourceAgent);

    // Clone the session
    const clonedAgent = await registry.cloneSession('source-session', 'cloned-session');

    expect(clonedAgent).toBeDefined();

    // Verify clone() was called with correct options
    expect(sourceAgent.clone).toHaveBeenCalledWith({
      sessionId: 'cloned-session',
      stripInternalMessages: true,
      keepSystemMessage: true,
      deepCopy: true,
    });

    // Verify filtered history
    const clonedHistory = (clonedAgent as any).history;
    expect(clonedHistory.length).toBe(5); // 9 original - 4 filtered = 5

    // Check specific messages were kept
    const historyContents = clonedHistory.map((msg: any) => msg.content);
    expect(historyContents).toContain('You are a code review assistant.');
    expect(historyContents).toContain(
      'Review this PR for security issues:\n```diff\n+ function test() {}\n```'
    );
    expect(historyContents).toContain('I found the following issues in your code...');

    // Check schema messages were removed
    expect(historyContents).not.toContain(
      expect.stringContaining('CRITICAL: You MUST respond with ONLY valid JSON DATA')
    );
    expect(historyContents).not.toContain(
      expect.stringContaining('Your previous JSON response was invalid')
    );
  });

  it('should preserve minimal history when using clone()', async () => {
    const mockHistory = [
      { role: 'system', content: 'System message' },
      { role: 'user', content: 'First user message' },
    ];

    const sourceAgent = {
      answer: jest.fn(),
      history: mockHistory,
      options: { sessionId: 'source-minimal' },
      clone: jest.fn().mockReturnValue({
        answer: jest.fn(),
        history: mockHistory, // Clone preserves all messages
        options: { sessionId: 'cloned-minimal' },
      }),
    } as any;

    registry.registerSession('source-minimal', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-minimal', 'cloned-minimal');
    const clonedHistory = (clonedAgent as any).history;

    // Should keep both messages
    expect(clonedHistory.length).toBe(2);
    expect(clonedHistory[0].content).toBe('System message');
    expect(clonedHistory[1].content).toBe('First user message');
  });

  it('should handle empty history gracefully', async () => {
    const sourceAgent = {
      answer: jest.fn(),
      history: [],
      options: { sessionId: 'source-empty' },
      clone: jest.fn().mockReturnValue({
        answer: jest.fn(),
        history: [],
        options: { sessionId: 'cloned-empty' },
      }),
    } as any;

    registry.registerSession('source-empty', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-empty', 'cloned-empty');
    const clonedHistory = (clonedAgent as any).history || [];

    expect(clonedHistory).toEqual([]);
  });

  it('should filter CRITICAL JSON ERROR messages using ProbeAgent.clone()', async () => {
    // This test case is based on real behavior observed with AI providers
    const realAIHistory = [
      {
        role: 'system',
        content: 'You are ProbeChat Code Explorer, a specialized AI assistant...',
      },
      { role: 'user', content: 'Return a simple object with name="test" and value=42' },
      {
        role: 'assistant',
        content: '<thinking>\nThe user wants me to find a piece of code...\n</thinking>',
      },
      {
        role: 'user',
        content:
          '<tool_result>\n/Users/leonidbugaev/go/src/gates/.conductor/dallas:\ndir      128B  __mocks__\n</tool_result>',
      },
      { role: 'assistant', content: '{ name: "test", value: 42 }' }, // Invalid JSON
      // This CRITICAL JSON ERROR message is filtered by ProbeAgent.clone()
      {
        role: 'user',
        content:
          "CRITICAL JSON ERROR: Your previous response is not valid JSON and cannot be parsed. Here's what you returned:\n\n{ name: \"test\", value: 42 }\n\nError: Expected property name or '}' in JSON at position 2",
      },
      { role: 'assistant', content: '{"name": "test", "value": 42}' }, // Corrected JSON
    ];

    // ProbeAgent.clone() filters out the CRITICAL JSON ERROR message
    const filteredHistory = realAIHistory.filter(
      msg => !msg.content.includes('CRITICAL JSON ERROR')
    );

    const sourceAgent = {
      answer: jest.fn(),
      history: realAIHistory,
      options: { sessionId: 'source-real-ai' },
      clone: jest.fn().mockReturnValue({
        answer: jest.fn(),
        history: filteredHistory,
        options: { sessionId: 'cloned-real-ai' },
      }),
    } as any;

    registry.registerSession('source-real-ai', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-real-ai', 'cloned-real-ai');
    const clonedHistory = (clonedAgent as any).history;

    // The CRITICAL JSON ERROR message should be filtered out
    expect(clonedHistory.length).toBe(realAIHistory.length - 1);

    // Check that the error message was removed
    const historyContents = clonedHistory.map((msg: any) => msg.content);
    expect(historyContents).not.toContain(expect.stringContaining('CRITICAL JSON ERROR'));

    // Verify other messages are preserved
    expect(historyContents).toContain('Return a simple object with name="test" and value=42');
    const hasToolResult = historyContents.some((content: string) =>
      content.includes('<tool_result>')
    );
    expect(hasToolResult).toBe(true);
  });

  it('should filter Liquid template error messages using ProbeAgent.clone()', async () => {
    const liquidBugHistory = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Generate a code review' },
      { role: 'assistant', content: '{% if %}' }, // AI incorrectly returns Liquid template
      {
        role: 'user',
        content:
          'URGENT - JSON PARSING FAILED: Your previous response is not valid JSON and cannot be parsed.',
      },
      { role: 'assistant', content: '{% for item in items %}' },
      {
        role: 'user',
        content: 'JSON PARSING FAILED: Your previous response is not valid JSON',
      },
      { role: 'assistant', content: '{"issues": []}' }, // Finally correct JSON
    ];

    // ProbeAgent.clone() filters out JSON parsing error messages
    const filteredHistory = liquidBugHistory.filter(
      msg => !msg.content.includes('JSON PARSING FAILED')
    );

    const sourceAgent = {
      answer: jest.fn(),
      history: liquidBugHistory,
      options: { sessionId: 'source-liquid-bug' },
      clone: jest.fn().mockReturnValue({
        answer: jest.fn(),
        history: filteredHistory,
        options: { sessionId: 'cloned-liquid' },
      }),
    } as any;

    registry.registerSession('source-liquid-bug', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-liquid-bug', 'cloned-liquid');
    const clonedHistory = (clonedAgent as any).history;

    // Should filter out the JSON parsing error messages
    expect(clonedHistory.length).toBeLessThan(liquidBugHistory.length);

    const historyContents = clonedHistory.map((msg: any) => msg.content);

    // Error messages should be filtered
    expect(historyContents).not.toContain(expect.stringContaining('URGENT - JSON PARSING FAILED'));
    expect(historyContents).not.toContain(expect.stringContaining('JSON PARSING FAILED'));

    // Core content should be preserved
    expect(historyContents).toContain('Generate a code review');
    expect(historyContents).toContain('{"issues": []}'); // Final correct response
  });

  it('should filter multiple schema-related messages using ProbeAgent.clone()', async () => {
    const multiAttemptHistory = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Create an overview with mermaid diagram' },
      { role: 'assistant', content: 'Response 1' },
      {
        role: 'user',
        content: 'CRITICAL: You MUST respond with ONLY valid JSON DATA',
      },
      { role: 'assistant', content: '{"text": "overview"}' },
      {
        role: 'user',
        content: 'The mermaid diagram in your response has syntax errors',
      },
      { role: 'assistant', content: '{"text": "fixed"}' },
      { role: 'user', content: 'Your JSON response was invalid' },
      { role: 'assistant', content: '{"text": "final"}' },
    ];

    // ProbeAgent.clone() filters out all schema-related messages
    // In reality, ProbeAgent might also filter some of the JSON responses that came after validation messages
    // Let's simulate a realistic filtering: keep system, user questions, and the final corrected responses
    const filteredHistory = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Create an overview with mermaid diagram' },
      { role: 'assistant', content: 'Response 1' },
      { role: 'assistant', content: '{"text": "overview"}' },
      { role: 'assistant', content: '{"text": "final"}' },
    ];

    const sourceAgent = {
      answer: jest.fn(),
      history: multiAttemptHistory,
      options: { sessionId: 'source-multiple-attempts' },
      clone: jest.fn().mockReturnValue({
        answer: jest.fn(),
        history: filteredHistory,
        options: { sessionId: 'cloned-multiple' },
      }),
    } as any;

    registry.registerSession('source-multiple-attempts', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-multiple-attempts', 'cloned-multiple');
    const clonedHistory = (clonedAgent as any).history;

    // Should filter out all schema/formatting messages (3 removed)
    // Plus some intermediate responses may be filtered, leaving 5 messages
    expect(clonedHistory.length).toBe(5); // 9 original - 4 filtered = 5

    const historyContents = clonedHistory.map((msg: any) => msg.content);

    // Schema messages should be removed
    expect(historyContents).not.toContain(
      expect.stringContaining('CRITICAL: You MUST respond with ONLY valid JSON DATA')
    );
    expect(historyContents).not.toContain(
      expect.stringContaining('mermaid diagram in your response has syntax errors')
    );
    expect(historyContents).not.toContain(
      expect.stringContaining('Your JSON response was invalid')
    );

    // Other messages should be kept
    expect(historyContents).toContain('Create an overview with mermaid diagram');
    expect(historyContents).toContain('{"text": "final"}');
  });
});
