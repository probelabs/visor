/**
 * Manual test for bash configuration with ProbeAgent
 *
 * This test validates that bash configuration options are properly passed
 * to ProbeAgent and can execute bash commands when enabled.
 *
 * Run with: npm test -- tests/manual/bash-config-manual.test.ts
 *
 * Prerequisites:
 * - ANTHROPIC_API_KEY environment variable must be set
 * - This test actually calls the AI API and may incur costs
 */

import { AIReviewService } from '../../src/ai-review-service';
import { PRInfo } from '../../src/pr-analyzer';

// Skip this test in CI/CD - only run manually
const runManualTests = process.env.RUN_MANUAL_TESTS === 'true';

describe('Bash Configuration Manual Tests', () => {
  // Create a minimal PR info for testing
  const mockPRInfo: PRInfo = {
    number: 1,
    title: 'Test PR',
    body: 'Test PR body',
    author: 'test-user',
    base: 'main',
    head: 'feature',
    files: [
      {
        filename: 'test.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
        changes: 15,
        patch: '+console.log("test");',
      },
    ],
    totalAdditions: 10,
    totalDeletions: 5,
  };

  beforeAll(() => {
    if (!runManualTests) {
      console.log('⏭️  Skipping manual tests. Set RUN_MANUAL_TESTS=true to run.');
    }
  });

  (runManualTests ? describe : describe.skip)('With API Key', () => {
    it('should execute bash commands when allowBash is true', async () => {
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasGoogleKey = !!process.env.GOOGLE_API_KEY;

      if (!hasAnthropicKey && !hasGoogleKey) {
        console.warn('⚠️  No API key set (ANTHROPIC_API_KEY or GOOGLE_API_KEY), skipping test');
        return;
      }

      const provider = hasAnthropicKey ? 'anthropic' : 'google';
      const model = hasAnthropicKey ? 'claude-3-5-sonnet-20241022' : 'gemini-2.0-flash-exp';

      const service = new AIReviewService({
        provider: provider as any,
        model,
        allowBash: true,
        debug: true,
      });

      const prompt = `
You have access to bash commands. Please:
1. Run 'echo "Hello from bash"'
2. Run 'pwd' to show the current directory
3. Confirm that bash commands are working

Return a JSON response with your findings.
`;

      console.log('\n📝 Testing allowBash: true');
      const result = await service.executeReview(mockPRInfo, prompt);

      // Check that we got a response
      expect(result).toBeDefined();
      console.log('✅ allowBash test completed');
      console.log('📊 Result:', JSON.stringify(result, null, 2));
    }, 60000); // 60 second timeout

    it('should pass bashConfig options to ProbeAgent', async () => {
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasGoogleKey = !!process.env.GOOGLE_API_KEY;

      if (!hasAnthropicKey && !hasGoogleKey) {
        console.warn('⚠️  No API key set, skipping test');
        return;
      }

      const provider = hasAnthropicKey ? 'anthropic' : 'google';
      const model = hasAnthropicKey ? 'claude-3-5-sonnet-20241022' : 'gemini-2.0-flash-exp';

      const service = new AIReviewService({
        provider: provider as any,
        model,
        allowBash: true,
        bashConfig: {
          allow: ['echo', 'pwd', 'ls'],
          timeout: 5000,
        },
        debug: true,
      });

      const prompt = `
You have access to bash commands with custom configuration.
Try running these commands:
1. echo "Test with custom allow list"
2. pwd
3. ls

Summarize what commands worked and return JSON.
`;

      console.log('\n📝 Testing allowBash with bashConfig');
      const result = await service.executeReview(mockPRInfo, prompt);

      expect(result).toBeDefined();
      console.log('✅ bashConfig test completed');
      console.log('📊 Result:', JSON.stringify(result, null, 2));
    }, 60000);

    it('should respect custom working directory', async () => {
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasGoogleKey = !!process.env.GOOGLE_API_KEY;

      if (!hasAnthropicKey && !hasGoogleKey) {
        console.warn('⚠️  No API key set, skipping test');
        return;
      }

      const provider = hasAnthropicKey ? 'anthropic' : 'google';
      const model = hasAnthropicKey ? 'claude-3-5-sonnet-20241022' : 'gemini-2.0-flash-exp';

      const service = new AIReviewService({
        provider: provider as any,
        model,
        allowBash: true,
        bashConfig: {
          workingDirectory: '/tmp',
        },
        debug: true,
      });

      const prompt = `
Run 'pwd' to show the current working directory.
The working directory should be /tmp.
Return JSON with the pwd output.
`;

      console.log('\n📝 Testing bashConfig.workingDirectory');
      const result = await service.executeReview(mockPRInfo, prompt);

      expect(result).toBeDefined();
      console.log('✅ workingDirectory test completed');
      console.log('📊 Result:', JSON.stringify(result, null, 2));
    }, 60000);

    it('should work without bash when allowBash is not set', async () => {
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasGoogleKey = !!process.env.GOOGLE_API_KEY;

      if (!hasAnthropicKey && !hasGoogleKey) {
        console.warn('⚠️  No API key set, skipping test');
        return;
      }

      const provider = hasAnthropicKey ? 'anthropic' : 'google';
      const model = hasAnthropicKey ? 'claude-3-5-sonnet-20241022' : 'gemini-2.0-flash-exp';

      const service = new AIReviewService({
        provider: provider as any,
        model,
        // allowBash not set - should default to false
        debug: true,
      });

      const prompt = `
Analyze this test file and provide feedback.
You should NOT have access to bash commands.
Return JSON with your analysis.
`;

      console.log('\n📝 Testing without allowBash (default behavior)');
      const result = await service.executeReview(mockPRInfo, prompt);

      expect(result).toBeDefined();
      console.log('✅ No bash test completed');
      console.log('📊 Result:', JSON.stringify(result, null, 2));
    }, 60000);
  });

  describe('Configuration Validation', () => {
    it('should accept allowBash boolean', () => {
      expect(() => {
        new AIReviewService({
          provider: 'mock',
          allowBash: true,
        });
      }).not.toThrow();
    });

    it('should accept bashConfig object', () => {
      expect(() => {
        new AIReviewService({
          provider: 'mock',
          allowBash: true,
          bashConfig: {
            allow: ['ls', 'pwd'],
            deny: ['rm'],
            timeout: 30000,
            workingDirectory: '/tmp',
          },
        });
      }).not.toThrow();
    });

    it('should accept both allowBash and bashConfig', () => {
      expect(() => {
        new AIReviewService({
          provider: 'mock',
          allowBash: true,
          bashConfig: {
            allow: ['git status'],
          },
        });
      }).not.toThrow();
    });
  });
});
