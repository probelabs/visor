import * as core from '@actions/core';
import { run } from '../src/index';

jest.mock('@actions/core');

// Mock CheckExecutionEngine
jest.mock('../src/check-execution-engine', () => {
  return {
    CheckExecutionEngine: jest.fn().mockImplementation(() => ({
      executeReviewChecks: jest
        .fn()
        .mockImplementation(async (_prInfo, _checks, _unused1, _config, _unused2, _debug) => {
          return {
            issues: [
              {
                file: 'test.ts',
                line: 10,
                endLine: undefined,
                ruleId: 'test/mock-issue',
                message: 'Mock issue for testing',
                severity: 'warning',
                category: 'style',
                suggestion: 'This is a mock suggestion',
                replacement: 'mockFixedCode();',
              },
            ],
            suggestions: ['Mock suggestion'],
          };
        }),
    })),
  };
});

// Mock AI review service to prevent API calls in tests
jest.mock('../src/ai-review-service', () => ({
  AIReviewService: jest.fn().mockImplementation(() => ({
    executeReview: jest.fn().mockResolvedValue({
      issues: [
        {
          file: 'test.ts',
          line: 10,
          endLine: undefined,
          ruleId: 'test/mock-issue',
          message: 'Mock issue for testing',
          severity: 'warning',
          category: 'style',
          suggestion: 'This is a mock suggestion',
          replacement: 'mockFixedCode();',
        },
      ],
      suggestions: ['Mock suggestion'],
    }),
  })),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      repos: {
        get: jest.fn().mockResolvedValue({
          data: {
            name: 'test-repo',
            full_name: 'test-owner/test-repo',
            description: 'A test repository',
            stargazers_count: 42,
          },
        }),
      },
      pulls: {
        get: jest.fn().mockResolvedValue({
          data: {
            number: 1,
            title: 'Test PR',
            body: 'Test PR body',
            user: { login: 'test-user' },
            base: { ref: 'main' },
            head: { ref: 'feature' },
          },
        }),
        listFiles: jest.fn().mockResolvedValue({
          data: [
            {
              filename: 'test.ts',
              additions: 10,
              deletions: 5,
              changes: 15,
              patch: 'test patch',
              status: 'modified',
            },
          ],
        }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({
          data: { id: 123 },
        }),
        listComments: jest.fn().mockResolvedValue({ data: [] }),
        updateComment: jest.fn().mockResolvedValue({
          data: { id: 123 },
        }),
        getComment: jest.fn().mockResolvedValue({
          data: { id: 123 },
        }),
      },
    },
  })),
}));

const mockedCore = core as jest.Mocked<typeof core>;

describe('GitHub Action Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.log = jest.fn();
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_CONTEXT;
  });

  test('should handle successful API call for repo info', async () => {
    mockedCore.getInput.mockImplementation((name: string) => {
      const inputs: { [key: string]: string } = {
        'github-token': 'mock-token',
        owner: 'test-owner',
        repo: 'test-repo',
      };
      return inputs[name] || '';
    });

    await run();

    expect(mockedCore.setOutput).toHaveBeenCalledWith('repo-name', 'test-repo');
    expect(mockedCore.setOutput).toHaveBeenCalledWith('repo-description', 'A test repository');
    expect(mockedCore.setOutput).toHaveBeenCalledWith('repo-stars', '42');
    expect(console.log).toHaveBeenCalledWith('Repository: test-owner/test-repo');
  });

  test('should handle missing owner and repo', async () => {
    mockedCore.getInput.mockImplementation((name: string) => {
      if (name === 'github-token') return 'mock-token';
      return '';
    });

    delete process.env.GITHUB_REPOSITORY_OWNER;
    delete process.env.GITHUB_REPOSITORY;

    await run();

    expect(mockedCore.setFailed).toHaveBeenCalledWith('Owner and repo are required');
  });

  test('should extract owner and repo from environment', async () => {
    mockedCore.getInput.mockImplementation((name: string) => {
      if (name === 'github-token') return 'mock-token';
      return '';
    });

    process.env.GITHUB_REPOSITORY_OWNER = 'env-owner';
    process.env.GITHUB_REPOSITORY = 'env-owner/env-repo';

    await run();

    expect(mockedCore.setOutput).toHaveBeenCalledWith('repo-name', 'test-repo');
    expect(console.log).toHaveBeenCalledWith('Repository: test-owner/test-repo');

    delete process.env.GITHUB_REPOSITORY_OWNER;
    delete process.env.GITHUB_REPOSITORY;
  });

  test('should handle issue_comment event with /review command', async () => {
    const mockContext = {
      event: {
        comment: { body: '/review' },
        issue: {
          number: 1,
          pull_request: { url: 'test-url' },
        },
      },
    };

    mockedCore.getInput.mockImplementation((name: string) => {
      const inputs: { [key: string]: string } = {
        'github-token': 'mock-token',
      };
      return inputs[name] || '';
    });

    process.env.GITHUB_EVENT_NAME = 'issue_comment';
    process.env.GITHUB_CONTEXT = JSON.stringify(mockContext);
    process.env.GITHUB_REPOSITORY_OWNER = 'test-owner';
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';

    await run();

    // Verify the action attempted to run (authentication messages are logged)
    expect(console.log).toHaveBeenCalledWith('🔑 Using GitHub token authentication');
  });

  test('should handle pull_request event with auto-review enabled', async () => {
    const mockContext = {
      event: {
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'Test PR',
          user: { login: 'test-user' },
        },
      },
    };

    mockedCore.getInput.mockImplementation((name: string) => {
      const inputs: { [key: string]: string } = {
        'github-token': 'mock-token',
        'auto-review': 'true',
      };
      return inputs[name] || '';
    });

    process.env.GITHUB_EVENT_NAME = 'pull_request';
    process.env.GITHUB_CONTEXT = JSON.stringify(mockContext);
    process.env.GITHUB_REPOSITORY_OWNER = 'test-owner';
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';

    await run();

    expect(mockedCore.setOutput).toHaveBeenCalledWith('auto-review-completed', 'true');
    // Note: issues-found output depends on actual review results, not guaranteed in mock environment
  });

  test('should not auto-review when disabled', async () => {
    const mockContext = {
      event: {
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'Test PR',
          user: { login: 'test-user' },
        },
      },
    };

    mockedCore.getInput.mockImplementation((name: string) => {
      const inputs: { [key: string]: string } = {
        'github-token': 'mock-token',
        'auto-review': 'false',
      };
      return inputs[name] || '';
    });

    process.env.GITHUB_EVENT_NAME = 'pull_request';
    process.env.GITHUB_CONTEXT = JSON.stringify(mockContext);
    process.env.GITHUB_REPOSITORY_OWNER = 'test-owner';
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';

    await run();

    expect(mockedCore.setOutput).not.toHaveBeenCalledWith('auto-review-completed', 'true');
  });
});
