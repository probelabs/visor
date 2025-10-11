import { EventMapper, GitHubEventContext, FileChangeContext } from '../../src/event-mapper';
import { VisorConfig } from '../../src/types/config';

describe('EventMapper', () => {
  let eventMapper: EventMapper;
  let testConfig: VisorConfig;

  beforeEach(() => {
    testConfig = {
      version: '1.0',
      checks: {
        'security-check': {
          type: 'ai',
          prompt: 'Review for security vulnerabilities',
          on: ['pr_opened', 'pr_updated'],
          triggers: ['**/*.{js,ts,py}', 'src/auth/**/*'],
        },
        'performance-check': {
          type: 'ai',
          prompt: 'Analyze performance implications',
          on: ['pr_opened', 'pr_updated'],
          triggers: ['**/*.sql', 'src/database/**/*'],
        },
        'style-check': {
          type: 'ai',
          prompt: 'Review code style and formatting',
          on: ['pr_opened', 'pr_updated', 'pr_closed'],
        },
      },
      output: {
        pr_comment: {
          format: 'table',
          group_by: 'check',
          collapse: true,
        },
      },
    };

    eventMapper = new EventMapper(testConfig);
  });

  describe('mapEventToExecution', () => {
    it('should map PR opened event correctly', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const result = eventMapper.mapEventToExecution(eventContext);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toEqual(['security-check', 'performance-check', 'style-check']);
      expect(result.executionContext.eventType).toBe('pr_opened');
      expect(result.executionContext.prNumber).toBe(123);
      expect(result.executionContext.repository).toBe('test-owner/test-repo');
      expect(result.executionContext.triggeredBy).toBe('pull_request_opened');
    });

    it('should map PR updated event correctly', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'synchronize',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 456,
          state: 'open',
          head: { sha: 'xyz789', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const result = eventMapper.mapEventToExecution(eventContext);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toEqual(['security-check', 'performance-check', 'style-check']);
      expect(result.executionContext.eventType).toBe('pr_updated');
      expect(result.executionContext.prNumber).toBe(456);
    });

    it('should handle PR comment events', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'issue_comment',
        action: 'created',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        issue: {
          number: 789,
          pull_request: { url: 'https://api.github.com/repos/test-owner/test-repo/pulls/789' },
        },
        comment: {
          body: '/review --focus=security',
          user: { login: 'reviewer' },
        },
      };

      const result = eventMapper.mapEventToExecution(eventContext);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toEqual(['security-check', 'performance-check', 'style-check']);
      expect(result.executionContext.eventType).toBe('pr_updated');
      expect(result.executionContext.prNumber).toBe(789);
      expect(result.executionContext.triggeredBy).toBe('comment by @reviewer');
    });

    it('should return no execution for unsupported events', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'push',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
      };

      const result = eventMapper.mapEventToExecution(eventContext);

      expect(result.shouldExecute).toBe(false);
      expect(result.checksToRun).toEqual([]);
    });
  });

  describe('file pattern matching', () => {
    it('should run security checks only for matching files', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const fileContext: FileChangeContext = {
        changedFiles: ['src/app.js', 'README.md'],
        addedFiles: ['src/auth/login.ts'],
        modifiedFiles: ['src/app.js'],
      };

      const result = eventMapper.mapEventToExecution(eventContext, fileContext);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toContain('security-check');
      expect(result.checksToRun).toContain('style-check'); // No file triggers, so runs for all
      expect(result.checksToRun).not.toContain('performance-check'); // SQL files not changed
    });

    it('should run performance checks for SQL file changes', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const fileContext: FileChangeContext = {
        changedFiles: ['migrations/001_create_users.sql', 'src/database/queries.sql'],
        addedFiles: ['migrations/001_create_users.sql'],
        modifiedFiles: ['src/database/queries.sql'],
      };

      const result = eventMapper.mapEventToExecution(eventContext, fileContext);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toContain('performance-check');
      expect(result.checksToRun).toContain('style-check'); // No file triggers
      expect(result.checksToRun).not.toContain('security-check'); // No JS/TS files
    });

    it('should handle complex glob patterns', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const fileContext: FileChangeContext = {
        changedFiles: ['src/auth/middleware.js', 'tests/auth.test.js'],
        modifiedFiles: ['src/auth/middleware.js', 'tests/auth.test.js'],
      };

      const result = eventMapper.mapEventToExecution(eventContext, fileContext);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toContain('security-check'); // Matches auth/**/* pattern
    });
  });

  describe('getSelectiveExecution', () => {
    it('should filter requested checks by availability and event matching', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'closed',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'closed',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const requestedChecks = [
        'security-check',
        'performance-check',
        'style-check',
        'non-existent-check',
      ];

      const result = eventMapper.getSelectiveExecution(eventContext, requestedChecks);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toEqual(['style-check']); // Only style-check runs on pr_closed
      expect(result.executionContext.triggeredBy).toBe('selective_execution');
    });

    it('should respect file patterns in selective execution', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const fileContext: FileChangeContext = {
        changedFiles: ['README.md', 'docs/api.md'],
        modifiedFiles: ['README.md'],
      };

      const requestedChecks = ['security-check', 'performance-check', 'style-check'];

      const result = eventMapper.getSelectiveExecution(eventContext, requestedChecks, fileContext);

      expect(result.shouldExecute).toBe(true);
      expect(result.checksToRun).toEqual(['style-check']); // Only no-trigger checks run
    });
  });

  describe('shouldProcessEvent', () => {
    it('should return true for supported events', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      expect(eventMapper.shouldProcessEvent(eventContext)).toBe(true);
    });

    it('should return false for unsupported events', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'repository',
        action: 'created',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
      };

      expect(eventMapper.shouldProcessEvent(eventContext)).toBe(false);
    });
  });

  describe('getAvailableChecks', () => {
    it('should return available checks with metadata', () => {
      const checks = eventMapper.getAvailableChecks();

      expect(checks).toHaveLength(3);
      expect(checks[0]).toEqual({
        name: 'security-check',
        description: 'Review for security vulnerabilities',
        triggers: ['pr_opened', 'pr_updated'],
      });
    });
  });

  describe('validateEventContext', () => {
    it('should validate complete event context', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      const result = eventMapper.validateEventContext(eventContext);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate missing repository information', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
      };

      const result = eventMapper.validateEventContext(eventContext);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing repository information in event context');
    });

    it('should validate missing PR information for pull_request events', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
      };

      const result = eventMapper.validateEventContext(eventContext);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing pull_request information for pull_request event');
    });

    it('should validate missing comment information for issue_comment events', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'issue_comment',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        issue: {
          number: 123,
        },
      };

      const result = eventMapper.validateEventContext(eventContext);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing comment information for issue_comment event');
    });
  });

  describe('glob pattern conversion', () => {
    it('should convert basic glob patterns correctly', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      // Test simple patterns first
      const simpleTestCases = [
        { files: ['src/app.js'], pattern: '**/*.js', shouldMatch: true },
        { files: ['src/app.ts'], pattern: '**/*.js', shouldMatch: false },
      ];

      for (const testCase of simpleTestCases) {
        const tempConfig = {
          ...testConfig,
          checks: {
            'test-check': {
              type: 'ai' as const,
              prompt: 'Test check',
              on: ['pr_opened' as const],
              triggers: [testCase.pattern],
            },
          },
        };

        const tempMapper = new EventMapper(tempConfig);
        const fileContext: FileChangeContext = {
          changedFiles: testCase.files,
          modifiedFiles: testCase.files,
        };

        const result = tempMapper.mapEventToExecution(eventContext, fileContext);

        if (testCase.shouldMatch) {
          expect(result.checksToRun).toContain('test-check');
        } else {
          expect(result.checksToRun).not.toContain('test-check');
        }
      }
    });

    it('should convert complex glob patterns correctly', () => {
      const eventContext: GitHubEventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
        pull_request: {
          number: 123,
          state: 'open',
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
          draft: false,
        },
      };

      // Test more complex patterns
      const complexTestCases = [
        { files: ['src/auth/login.js'], pattern: 'src/auth/**/*', shouldMatch: true },
        { files: ['test/auth/login.js'], pattern: 'src/auth/**/*', shouldMatch: false },
        { files: ['config.json'], pattern: '*.{json,yaml}', shouldMatch: true },
        { files: ['config.yaml'], pattern: '*.{json,yaml}', shouldMatch: true },
        { files: ['config.yml'], pattern: '*.{json,yaml}', shouldMatch: false },
      ];

      for (const testCase of complexTestCases) {
        const tempConfig = {
          ...testConfig,
          checks: {
            'test-check': {
              type: 'ai' as const,
              prompt: 'Test check',
              on: ['pr_opened' as const],
              triggers: [testCase.pattern],
            },
          },
        };

        const tempMapper = new EventMapper(tempConfig);
        const fileContext: FileChangeContext = {
          changedFiles: testCase.files,
          modifiedFiles: testCase.files,
        };

        const result = tempMapper.mapEventToExecution(eventContext, fileContext);

        if (testCase.shouldMatch) {
          expect(result.checksToRun).toContain('test-check');
        } else {
          expect(result.checksToRun).not.toContain('test-check');
        }
      }
    });
  });
});
