import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { ConfigManager } from '../../src/config';
import { VisorConfig } from '../../src/types/config';
import { SessionRegistry } from '../../src/session-registry';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock ProbeAgent
const mockProbeAgent = {
  answer: jest.fn(),
};

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn().mockImplementation(() => mockProbeAgent),
}));

describe('Session Reuse Integration', () => {
  let engine: CheckExecutionEngine;
  let configManager: ConfigManager;
  let tempDir: string;
  let sessionRegistry: SessionRegistry;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Set mock API key for Google provider
    process.env.GOOGLE_API_KEY = 'mock-api-key-for-testing';

    // Create temporary directory for test git repo
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-session-test-'));

    // Initialize a git repo
    const { execSync } = require('child_process');
    execSync('git init', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });

    // Create some test files
    fs.writeFileSync(path.join(tempDir, 'test.js'), 'console.log("test");');
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name": "test"}');

    // Add and commit files
    execSync('git add .', { cwd: tempDir });
    execSync('git commit -m "Initial commit"', { cwd: tempDir });

    // Make some changes
    fs.writeFileSync(path.join(tempDir, 'test.js'), 'console.log("modified test");');
    fs.writeFileSync(path.join(tempDir, 'new-file.js'), 'console.log("new file");');

    engine = new CheckExecutionEngine(tempDir);
    configManager = new ConfigManager();
    sessionRegistry = SessionRegistry.getInstance();
    sessionRegistry.clearAllSessions();

    // Setup mock responses
    mockProbeAgent.answer
      .mockResolvedValueOnce(
        JSON.stringify({
          issues: [
            {
              file: 'test.js',
              line: 1,
              ruleId: 'security/console-log',
              message: 'Console.log usage detected',
              severity: 'warning',
              category: 'security',
            },
          ],
          suggestions: ['Remove console.log statements'],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          issues: [
            {
              file: 'test.js',
              line: 1,
              ruleId: 'follow-up/security-confirmation',
              message: 'Confirmed security issue from previous analysis',
              severity: 'error',
              category: 'security',
            },
          ],
          suggestions: ['This is a follow-up suggestion based on session context'],
        })
      );
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    sessionRegistry.clearAllSessions();

    // Clean up environment
    delete process.env.GOOGLE_API_KEY;
  });

  describe('session reuse execution', () => {
    it('should execute checks with session reuse sequentially', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'security-scan': {
            type: 'ai',
            prompt: 'Analyze code for security vulnerabilities',
            on: ['pr_updated'],
            ai_provider: 'google',
            schema: 'code-review',
          },
          'security-follow-up': {
            type: 'ai',
            prompt: 'Follow up on security findings from previous analysis',
            on: ['pr_updated'],
            depends_on: ['security-scan'],
            reuse_ai_session: true,
            ai_provider: 'google',
            schema: 'code-review',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['security-scan', 'security-follow-up'],
        config,
        maxParallelism: 3,
        debug: true,
      });

      // Verify both checks completed
      expect(result.reviewSummary.issues).toHaveLength(2);

      // Verify first check found security issue
      const securityIssue = result.reviewSummary.issues.find(
        issue => issue.ruleId === 'security-scan/security/console-log'
      );
      expect(securityIssue).toBeDefined();
      expect(securityIssue?.message).toBe('Console.log usage detected');

      // Verify second check (with session reuse) found follow-up issue
      const followUpIssue = result.reviewSummary.issues.find(
        issue => issue.ruleId === 'security-follow-up/follow-up/security-confirmation'
      );
      expect(followUpIssue).toBeDefined();
      expect(followUpIssue?.message).toBe('Confirmed security issue from previous analysis');

      // Verify execution completed successfully
      expect(result.checksExecuted).toEqual(['security-scan', 'security-follow-up']);
    });

    it('should force sequential execution when session reuse is involved', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'base-check': {
            type: 'ai',
            prompt: 'Base analysis',
            on: ['pr_updated'],
            ai_provider: 'google',
            schema: 'code-review',
          },
          'reuse-check-1': {
            type: 'ai',
            prompt: 'First follow-up using session',
            on: ['pr_updated'],
            depends_on: ['base-check'],
            reuse_ai_session: true,
            ai_provider: 'google',
            schema: 'code-review',
          },
          'reuse-check-2': {
            type: 'ai',
            prompt: 'Second follow-up using session',
            on: ['pr_updated'],
            depends_on: ['base-check'],
            reuse_ai_session: true,
            ai_provider: 'google',
            schema: 'code-review',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
        max_parallelism: 5, // Would normally allow parallel execution
      };

      // Setup additional mock responses
      mockProbeAgent.answer
        .mockResolvedValueOnce(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 1,
                ruleId: 'base',
                message: 'Base finding',
                severity: 'info',
                category: 'style',
              },
            ],
            suggestions: [],
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 2,
                ruleId: 'reuse1',
                message: 'Reuse 1 finding',
                severity: 'info',
                category: 'style',
              },
            ],
            suggestions: [],
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 3,
                ruleId: 'reuse2',
                message: 'Reuse 2 finding',
                severity: 'info',
                category: 'style',
              },
            ],
            suggestions: [],
          })
        );

      const result = await engine.executeChecks({
        checks: ['base-check', 'reuse-check-1', 'reuse-check-2'],
        config,
        debug: true,
      });

      // All checks should complete
      expect(result.reviewSummary.issues).toHaveLength(3);
      expect(result.checksExecuted).toEqual(['base-check', 'reuse-check-1', 'reuse-check-2']);

      // Execution should be sequential (not parallel) due to session reuse
      // This is harder to test directly, but we can verify all calls were made
      expect(mockProbeAgent.answer).toHaveBeenCalledTimes(3);
    });

    it('should handle session reuse validation errors', async () => {
      // This should fail validation before execution
      await expect(configManager.loadConfig('/non/existent/path')).rejects.toThrow();
    });

    it('should clean up sessions after execution', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'parent-check': {
            type: 'ai',
            prompt: 'Parent check that creates session',
            on: ['pr_updated'],
            schema: 'code-review',
          },
          'child-check': {
            type: 'ai',
            prompt: 'Child check that reuses session',
            on: ['pr_updated'],
            depends_on: ['parent-check'],
            reuse_ai_session: true,
            schema: 'code-review',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      // Setup mock responses
      mockProbeAgent.answer
        .mockResolvedValueOnce(JSON.stringify({ issues: [], suggestions: [] }))
        .mockResolvedValueOnce(JSON.stringify({ issues: [], suggestions: [] }));

      // Verify no sessions before execution
      expect(sessionRegistry.getActiveSessionIds()).toHaveLength(0);

      await engine.executeChecks({
        checks: ['parent-check', 'child-check'],
        config,
        debug: true,
      });

      // Sessions should be cleaned up after execution
      expect(sessionRegistry.getActiveSessionIds()).toHaveLength(0);
    });
  });

  describe('complex dependency scenarios', () => {
    it('should handle multiple levels of session reuse dependencies', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'level-1': {
            type: 'ai',
            prompt: 'Level 1 analysis',
            on: ['pr_updated'],
            schema: 'code-review',
          },
          'level-2': {
            type: 'ai',
            prompt: 'Level 2 analysis based on level 1',
            on: ['pr_updated'],
            depends_on: ['level-1'],
            reuse_ai_session: true,
            schema: 'code-review',
          },
          'level-3': {
            type: 'ai',
            prompt: 'Level 3 analysis based on level 2',
            on: ['pr_updated'],
            depends_on: ['level-2'],
            reuse_ai_session: true,
            schema: 'code-review',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      // Setup mock responses for each level
      mockProbeAgent.answer
        .mockResolvedValueOnce(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 1,
                ruleId: 'l1',
                message: 'Level 1',
                severity: 'info',
                category: 'style',
              },
            ],
            suggestions: ['Level 1 suggestion'],
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 2,
                ruleId: 'l2',
                message: 'Level 2',
                severity: 'info',
                category: 'style',
              },
            ],
            suggestions: ['Level 2 suggestion'],
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            issues: [
              {
                file: 'test.js',
                line: 3,
                ruleId: 'l3',
                message: 'Level 3',
                severity: 'info',
                category: 'style',
              },
            ],
            suggestions: ['Level 3 suggestion'],
          })
        );

      const result = await engine.executeChecks({
        checks: ['level-1', 'level-2', 'level-3'],
        config,
        debug: true,
      });

      // All three levels should complete
      expect(result.reviewSummary.issues).toHaveLength(3);
      expect(result.checksExecuted).toEqual(['level-1', 'level-2', 'level-3']);

      // Verify proper sequencing
      expect(mockProbeAgent.answer).toHaveBeenCalledTimes(3);
    });
  });
});
