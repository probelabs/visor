import { SessionRegistry } from '../../src/session-registry';
import { ProbeAgent } from '@probelabs/probe';

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

  it('should filter out schema-specific formatting messages when cloning', async () => {
    // Create mock agent with history containing schema messages
    const sourceAgent = new ProbeAgent({
      sessionId: 'source-session',
      debug: true,
      model: 'claude-3-sonnet',
      provider: 'anthropic',
    });

    // Simulate a conversation history with schema-related messages
    const mockHistory = [
      // System message (should be kept)
      {
        role: 'system',
        content: 'You are a code review assistant.',
      },
      // Initial user request (should be kept)
      {
        role: 'user',
        content: 'Review this PR for security issues:\n```diff\n+ function test() {}\n```',
      },
      // Assistant response (should be kept)
      {
        role: 'assistant',
        content: 'I found the following issues in your code...',
      },
      // Schema formatting prompt (should be REMOVED)
      {
        role: 'user',
        content:
          'CRITICAL: You MUST respond with ONLY valid JSON DATA that conforms to this schema structure.',
      },
      // JSON formatting response (should be REMOVED)
      {
        role: 'assistant',
        content: '{"issues": [{"file": "test.js", "line": 1}]}',
      },
      // JSON validation error (should be REMOVED)
      {
        role: 'user',
        content:
          'Your previous JSON response was invalid. Please correct the following JSON errors...',
      },
      // Mermaid validation prompt (should be REMOVED)
      {
        role: 'user',
        content: 'The mermaid diagram in your response has syntax errors. Please fix it.',
      },
      // Tool result (should be kept)
      {
        role: 'user',
        content: '<tool_result>\nSearch found 10 files\n</tool_result>',
      },
      // Regular conversation (should be kept)
      {
        role: 'assistant',
        content: 'Based on the search results, I recommend...',
      },
    ];

    // Set the mock history
    (sourceAgent as any).history = mockHistory;

    // Register the source agent
    registry.registerSession('source-session', sourceAgent);

    // Clone the session
    const clonedAgent = await registry.cloneSession('source-session', 'cloned-session');

    expect(clonedAgent).toBeDefined();

    // Get the cloned history
    const clonedHistory = (clonedAgent as any).history;

    // Verify that schema-related messages were filtered out
    expect(clonedHistory.length).toBeLessThan(mockHistory.length);

    // Check specific messages were kept
    const historyContents = clonedHistory.map((msg: any) => msg.content);
    expect(historyContents).toContain('You are a code review assistant.');
    expect(historyContents).toContain(
      'Review this PR for security issues:\n```diff\n+ function test() {}\n```'
    );
    expect(historyContents).toContain('I found the following issues in your code...');
    expect(historyContents).toContain('<tool_result>\nSearch found 10 files\n</tool_result>');
    expect(historyContents).toContain('Based on the search results, I recommend...');

    // Check specific messages were filtered out
    expect(historyContents).not.toContain(
      'CRITICAL: You MUST respond with ONLY valid JSON DATA that conforms to this schema structure.'
    );
    expect(historyContents).not.toContain(
      'Your previous JSON response was invalid. Please correct the following JSON errors...'
    );
    expect(historyContents).not.toContain(
      'The mermaid diagram in your response has syntax errors. Please fix it.'
    );

    // The cloned agent should exist and have filtered history
    expect(clonedAgent).toBeDefined();
  });

  it('should preserve minimal history if filtering removes too much', async () => {
    const sourceAgent = new ProbeAgent({
      sessionId: 'source-minimal',
      debug: false,
    });

    // Create a history with mostly schema messages
    const mockHistory = [
      {
        role: 'system',
        content: 'System message',
      },
      {
        role: 'user',
        content: 'First user message',
      },
      {
        role: 'user',
        content: 'Please reformat your previous response to match this schema exactly.',
      },
      {
        role: 'user',
        content: 'Now you need to respond according to this schema',
      },
    ];

    (sourceAgent as any).history = mockHistory;
    registry.registerSession('source-minimal', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-minimal', 'cloned-minimal');
    const clonedHistory = (clonedAgent as any).history;

    // Should keep at least system and first user message
    expect(clonedHistory.length).toBeGreaterThanOrEqual(2);
    expect(clonedHistory[0].content).toBe('System message');
    expect(clonedHistory[1].content).toBe('First user message');
  });

  it('should handle empty history gracefully', async () => {
    const sourceAgent = new ProbeAgent({
      sessionId: 'source-empty',
    });

    (sourceAgent as any).history = [];
    registry.registerSession('source-empty', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-empty', 'cloned-empty');
    const clonedHistory = (clonedAgent as any).history || [];

    expect(clonedHistory).toEqual([]);
  });

  it('should filter CRITICAL JSON ERROR messages from real AI', async () => {
    // This test case is based on real behavior observed with Google Gemini AI
    const sourceAgent = new ProbeAgent({
      sessionId: 'source-real-ai',
      debug: false,
    });

    // Simulate real AI conversation with JSON error correction (as observed in our testing)
    const realAIHistory = [
      {
        role: 'system',
        content: 'You are ProbeChat Code Explorer, a specialized AI assistant...',
      },
      {
        role: 'user',
        content: 'Return a simple object with name="test" and value=42',
      },
      {
        role: 'assistant',
        content: '<thinking>\nThe user wants me to find a piece of code...\n</thinking>',
      },
      {
        role: 'user',
        content:
          '<tool_result>\n/Users/leonidbugaev/go/src/gates/.conductor/dallas:\ndir      128B  __mocks__\n</tool_result>',
      },
      {
        role: 'assistant',
        content: '{ name: "test", value: 42 }', // Invalid JSON (no quotes on keys)
      },
      // This is the CRITICAL JSON ERROR message that should be filtered
      {
        role: 'user',
        content:
          "CRITICAL JSON ERROR: Your previous response is not valid JSON and cannot be parsed. Here's what you returned:\n\n{ name: \"test\", value: 42 }\n\nError: Expected property name or '}' in JSON at position 2",
      },
      {
        role: 'assistant',
        content: '{"name": "test", "value": 42}', // Corrected JSON
      },
    ];

    (sourceAgent as any).history = realAIHistory;
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
    // Check that tool_result message is preserved
    const hasToolResult = historyContents.some((content: string) =>
      content.includes('<tool_result>')
    );
    expect(hasToolResult).toBe(true);
  });

  it('should filter multiple schema-related messages in sequence', async () => {
    // Test case for when AI needs multiple attempts to get schema right
    const sourceAgent = new ProbeAgent({
      sessionId: 'source-multiple-attempts',
      debug: false,
    });

    const multiAttemptHistory = [
      {
        role: 'system',
        content: 'System prompt',
      },
      {
        role: 'user',
        content: 'Create an overview with mermaid diagram',
      },
      {
        role: 'assistant',
        content: 'Here is the overview with diagram...',
      },
      // First attempt - schema formatting
      {
        role: 'user',
        content:
          'Now you need to respond according to this schema:\n\n{"type": "object", "properties": {...}}',
      },
      {
        role: 'assistant',
        content: '{"summary": "test", "diagram": "graph TD"}',
      },
      // Second attempt - mermaid fix
      {
        role: 'user',
        content:
          'The mermaid diagram in your response has syntax errors. Please fix the following mermaid diagram',
      },
      {
        role: 'assistant',
        content: '{"summary": "test", "diagram": "graph TD\\n  A --> B"}',
      },
      // Third attempt - JSON validation
      {
        role: 'user',
        content:
          'Your previous response is not valid JSON. Please correct the following JSON errors',
      },
      {
        role: 'assistant',
        content: '{"summary": "test", "diagram": "graph TD\\n  A --> B", "components": []}',
      },
    ];

    (sourceAgent as any).history = multiAttemptHistory;
    registry.registerSession('source-multiple-attempts', sourceAgent);

    const clonedAgent = await registry.cloneSession('source-multiple-attempts', 'cloned-multiple');
    const clonedHistory = (clonedAgent as any).history;

    // Should filter out all 3 schema/formatting messages
    expect(clonedHistory.length).toBe(6); // 9 original - 3 filtered = 6

    const historyContents = clonedHistory.map((msg: any) => msg.content);

    // Verify schema messages were filtered
    expect(historyContents).not.toContain(
      expect.stringContaining('Now you need to respond according to this schema')
    );
    expect(historyContents).not.toContain(
      expect.stringContaining('mermaid diagram in your response has syntax errors')
    );
    expect(historyContents).not.toContain(
      expect.stringContaining('Your previous response is not valid JSON')
    );

    // Verify important content is preserved
    expect(historyContents).toContain('Create an overview with mermaid diagram');
    expect(historyContents).toContain('Here is the overview with diagram...');
  });
});
