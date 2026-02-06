/* eslint-disable @typescript-eslint/no-explicit-any */
import { AIReviewService } from '../../src/ai-review-service';
import { PRInfo } from '../../src/pr-analyzer';

// Test constants
const TEST_SESSION_IDS = {
  PARENT: 'parent-session-123',
  DEPENDENT: 'dependent-check',
  INITIAL: 'initial-check',
} as const;

// Helper function to create mock diff content
function createMockDiff(oldCode: string, newCode: string, fileName = 'test.js'): string {
  return `diff --git a/${fileName} b/${fileName}
index 1234567..abcdefg 100644
--- a/${fileName}
+++ b/${fileName}
@@ -1,3 +1,4 @@
 ${oldCode}
+${newCode}
 console.log('more code');`;
}

// Helper function to create mock PRInfo with diff
function createPRInfoWithDiff(diff: string, overrides?: Partial<PRInfo>): PRInfo {
  return {
    number: 123,
    title: 'Test PR',
    body: 'Test PR body',
    author: 'test-user',
    base: 'main',
    head: 'feature-branch',
    files: [],
    fullDiff: diff,
    totalAdditions: 10,
    totalDeletions: 5,
    isIncremental: false,
    ...overrides,
  };
}

// Mock ProbeAgent
const mockProbeAgent = {
  initialize: jest.fn().mockResolvedValue(undefined),
  answer: jest.fn(),
};

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn().mockImplementation(() => mockProbeAgent),
}));

// Mock SessionRegistry
const mockSessionRegistry = {
  getInstance: jest.fn(),
  registerSession: jest.fn(),
  getSession: jest.fn(),
  unregisterSession: jest.fn(),
  hasSession: jest.fn(),
  clearAllSessions: jest.fn(),
  getActiveSessionIds: jest.fn(),
  cloneSession: jest.fn(),
};

jest.mock('../../src/session-registry', () => ({
  SessionRegistry: {
    getInstance: () => mockSessionRegistry,
  },
}));

describe('AIReviewService Session Reuse', () => {
  let service: AIReviewService;
  let mockPRInfo: PRInfo;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new AIReviewService({
      provider: 'google', // Use non-mock provider to enable real session behavior
      model: 'test-model',
      debug: true,
    });

    mockPRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test PR body',
      author: 'test-user',
      base: 'main',
      head: 'feature-branch',
      files: [],
      fullDiff: 'mock diff',
      totalAdditions: 10,
      totalDeletions: 5,
      isIncremental: false,
    };

    // Reset mock implementations
    mockProbeAgent.answer.mockResolvedValue(
      JSON.stringify({
        issues: [],
      })
    );

    mockSessionRegistry.getSession.mockReturnValue(undefined);
    mockSessionRegistry.hasSession.mockReturnValue(false);
  });

  describe('executeReview', () => {
    it('should register session when checkName is provided', async () => {
      const checkName = 'test-check';

      await service.executeReview(mockPRInfo, 'Test prompt', undefined, checkName);

      // Since we're using a non-mock provider, the ProbeAgent should be called
      expect(mockProbeAgent.answer).toHaveBeenCalled();
      // Session should be registered with the checkName
      expect(mockSessionRegistry.registerSession).toHaveBeenCalledWith(
        expect.stringContaining(checkName),
        expect.any(Object)
      );
    });

    it('should not register session when checkName is not provided', async () => {
      await service.executeReview(mockPRInfo, 'Test prompt');

      expect(mockSessionRegistry.registerSession).not.toHaveBeenCalled();
    });
  });

  describe('executeReviewWithSessionReuse', () => {
    it('should reuse existing session successfully', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 1,
                ruleId: 'test-rule',
                message: 'Test issue',
                severity: 'warning',
                category: 'style',
              },
            ],
          })
        ),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);

      // Use append mode to test the original behavior
      const result = await service.executeReviewWithSessionReuse(
        mockPRInfo,
        'Reuse session prompt',
        parentSessionId,
        'code-review',
        'dependent-check',
        'append' // Use append mode for backward compatibility
      );

      expect(mockSessionRegistry.getSession).toHaveBeenCalledWith(parentSessionId);
      expect(existingAgent.answer).toHaveBeenCalledWith(
        expect.stringContaining('Reuse session prompt'),
        undefined,
        expect.objectContaining({
          schema: expect.stringContaining('code-review'),
        })
      );

      expect(result.issues).toHaveLength(1);
    });

    it('should throw error when parent session not found', async () => {
      const parentSessionId = 'non-existent-session';

      mockSessionRegistry.getSession.mockReturnValue(undefined);

      await expect(
        service.executeReviewWithSessionReuse(
          mockPRInfo,
          'Reuse session prompt',
          parentSessionId,
          undefined,
          'dependent-check'
        )
      ).rejects.toThrow(`Session not found for reuse: ${parentSessionId}`);

      expect(mockSessionRegistry.getSession).toHaveBeenCalledWith(parentSessionId);
    });

    it('should handle schema parameter in session reuse', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 1,
                ruleId: 'test-rule',
                message: 'Schema test response',
                severity: 'warning',
                category: 'style',
              },
            ],
          })
        ),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);

      // Mock loadSchemaContent method
      const mockLoadSchemaContent = jest.spyOn(service as any, 'loadSchemaContent');
      mockLoadSchemaContent.mockResolvedValue('{"type": "object"}');

      const result = await service.executeReviewWithSessionReuse(
        mockPRInfo,
        'Test prompt',
        parentSessionId,
        'code-review',
        'dependent-check',
        'append' // Use append mode
      );

      expect(existingAgent.answer).toHaveBeenCalledWith(
        expect.stringContaining('Test prompt'),
        undefined,
        { schema: '{"type": "object"}' }
      );

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toBe('Schema test response');

      mockLoadSchemaContent.mockRestore();
    });

    it('should return error in debug mode when session reuse fails', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = { answer: jest.fn().mockRejectedValue(new Error('AI service error')) };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);

      // Test should pass schema parameter to enable debug mode explicitly
      const result = await service.executeReviewWithSessionReuse(
        mockPRInfo,
        'Test prompt',
        parentSessionId,
        'code-review', // Pass schema to ensure debug path is taken
        'dependent-check',
        'append' // Use append mode
      );

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].ruleId).toBe('system/ai-session-reuse-error');
      expect(result.issues![0].message).toContain('AI service error');
      // Error should be captured in debug info
      expect(result.debug?.errors?.[0]).toContain('AI service error');
      expect(result.debug).toBeDefined();
    });
  });

  describe('session management methods', () => {
    it('should register session correctly', () => {
      const sessionId = 'test-session-123';
      const mockAgent = { answer: jest.fn() } as any;

      service.registerSession(sessionId, mockAgent);

      expect(mockSessionRegistry.registerSession).toHaveBeenCalledWith(sessionId, mockAgent);
    });

    it('should cleanup session correctly', () => {
      const sessionId = 'test-session-123';

      service.cleanupSession(sessionId);

      expect(mockSessionRegistry.unregisterSession).toHaveBeenCalledWith(sessionId);
    });
  });

  describe('mock provider integration', () => {
    it('should use mock provider for session reuse when configured', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = { answer: jest.fn() };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);

      // Create a service with mock provider for this test
      const mockService = new AIReviewService({
        provider: 'mock',
        model: 'mock',
        debug: true,
      });

      const result = await mockService.executeReviewWithSessionReuse(
        mockPRInfo,
        'Test prompt',
        parentSessionId,
        undefined,
        'dependent-check',
        'append' // Use append mode
      );

      // Should use mock response, not call the existing agent
      expect(existingAgent.answer).not.toHaveBeenCalled();
      expect(result.issues).toBeDefined();
    });
  });

  describe('Diff Information Not Duplicated on Session Reuse', () => {
    it('should NOT send diff context when reusing session', async () => {
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);

      // Create mock PRInfo with explicit diff content using helper
      const mockDiff = createMockDiff("console.log('old code');", "console.log('new code');");
      const prInfoWithDiff = createPRInfoWithDiff(mockDiff);

      await service.executeReviewWithSessionReuse(
        prInfoWithDiff,
        'Analyze new changes only',
        TEST_SESSION_IDS.PARENT,
        'code-review',
        TEST_SESSION_IDS.DEPENDENT,
        'append'
      );

      // Get the prompt that was sent to the agent
      const promptSent = existingAgent.answer.mock.calls[0][0];

      // Verify that the prompt does NOT contain the diff
      expect(promptSent).not.toContain('diff --git');
      expect(promptSent).not.toContain('console.log');
      expect(promptSent).not.toContain('fullDiff');
      expect(promptSent).not.toContain('full_diff');

      // Verify the prompt contains only the new instructions
      expect(promptSent).toContain('Analyze new changes only');
      expect(promptSent).toContain('<instructions>');
      expect(promptSent).toContain('</instructions>');

      // Verify it contains a reminder with proper XML structure
      expect(promptSent).toContain('<reminder>');
      expect(promptSent).toContain('code context and diff were provided in the previous message');
      expect(promptSent).toContain('Focus on the new analysis instructions above');
      expect(promptSent).toContain('</reminder>');
    });

    it('should NOT send PR context when reusing session (non-code-review schema)', async () => {
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);

      const prInfoWithMetadata = createPRInfoWithDiff('some diff content', {
        title: 'Add new feature',
        body: 'This is a detailed PR description with lots of context',
      });

      await service.executeReviewWithSessionReuse(
        prInfoWithMetadata,
        'Check for security issues',
        TEST_SESSION_IDS.PARENT,
        undefined, // no schema
        TEST_SESSION_IDS.DEPENDENT,
        'append'
      );

      const promptSent = existingAgent.answer.mock.calls[0][0];

      // Should NOT contain PR metadata or diff
      expect(promptSent).not.toContain('Add new feature');
      expect(promptSent).not.toContain('This is a detailed PR description');
      expect(promptSent).not.toContain('some diff content');

      // Verify prompt structure for non-code-review schema
      expect(promptSent).toContain('<instructions>');
      expect(promptSent).toContain('Check for security issues');
      expect(promptSent).toContain('</instructions>');

      // Should NOT contain review-specific wrapper or context sections
      expect(promptSent).not.toContain('<review_request>');
      expect(promptSent).not.toContain('<context>');
      expect(promptSent).not.toContain('<rules>');
    });

    it('should send full context on initial executeReview call', async () => {
      // This test verifies the baseline: initial calls DO include context
      // Ensure consistent mock setup
      mockProbeAgent.answer.mockResolvedValue(
        JSON.stringify({
          issues: [],
        })
      );

      const mockDiff = createMockDiff("console.log('baseline');", "console.log('test');");
      const prInfoWithDiff = createPRInfoWithDiff(mockDiff, {
        title: 'My PR Title',
      });

      await service.executeReview(
        prInfoWithDiff,
        'Initial analysis',
        'code-review',
        TEST_SESSION_IDS.INITIAL
      );

      // Get the prompt that was sent
      const promptSent = mockProbeAgent.answer.mock.calls[0][0];

      // Initial call SHOULD include full context with proper structure
      expect(promptSent).toContain('diff --git');
      expect(promptSent).toContain("console.log('baseline')");
      expect(promptSent).toContain('My PR Title');
      expect(promptSent).toContain('Initial analysis');

      // Verify it includes the complete review structure
      expect(promptSent).toContain('<review_request>');
      expect(promptSent).toContain('<context>');
      expect(promptSent).toContain('<instructions>');
      expect(promptSent).toContain('<rules>');
    });
  });

  describe('Session Mode: Clone vs Append', () => {
    beforeEach(() => {
      // Mock the cloneSession method
      mockSessionRegistry.cloneSession = jest.fn();
    });

    it('should clone session by default (session_mode not specified)', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };
      const clonedAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);
      mockSessionRegistry.cloneSession.mockResolvedValue(clonedAgent);

      await service.executeReviewWithSessionReuse(
        mockPRInfo,
        'Test prompt',
        parentSessionId,
        undefined,
        'dependent-check'
        // sessionMode defaults to 'clone'
      );

      // Should clone the session
      expect(mockSessionRegistry.cloneSession).toHaveBeenCalledWith(
        parentSessionId,
        expect.stringContaining('dependent-check-session-'),
        'dependent-check'
      );

      // Should use the cloned agent, not the original
      expect(clonedAgent.answer).toHaveBeenCalled();
      expect(existingAgent.answer).not.toHaveBeenCalled();
    });

    it('should clone session when session_mode is explicitly set to "clone"', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };
      const clonedAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);
      mockSessionRegistry.cloneSession.mockResolvedValue(clonedAgent);

      await service.executeReviewWithSessionReuse(
        mockPRInfo,
        'Test prompt',
        parentSessionId,
        undefined,
        'dependent-check',
        'clone'
      );

      expect(mockSessionRegistry.cloneSession).toHaveBeenCalledWith(
        parentSessionId,
        expect.stringContaining('dependent-check-session-'),
        'dependent-check'
      );
      expect(clonedAgent.answer).toHaveBeenCalled();
      expect(existingAgent.answer).not.toHaveBeenCalled();
    });

    it('should append to shared session when session_mode is "append"', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);

      await service.executeReviewWithSessionReuse(
        mockPRInfo,
        'Test prompt',
        parentSessionId,
        undefined,
        'dependent-check',
        'append'
      );

      // Should NOT clone the session
      expect(mockSessionRegistry.cloneSession).not.toHaveBeenCalled();

      // Should use the original agent directly
      expect(existingAgent.answer).toHaveBeenCalled();
    });

    it('should handle clone failure gracefully', async () => {
      const parentSessionId = 'parent-session-123';
      const existingAgent = {
        answer: jest.fn().mockResolvedValue(JSON.stringify({ issues: [] })),
      };

      mockSessionRegistry.getSession.mockReturnValue(existingAgent);
      mockSessionRegistry.cloneSession.mockResolvedValue(undefined); // Clone fails

      await expect(
        service.executeReviewWithSessionReuse(
          mockPRInfo,
          'Test prompt',
          parentSessionId,
          undefined,
          'dependent-check',
          'clone'
        )
      ).rejects.toThrow('Failed to clone session');
    });
  });
});
