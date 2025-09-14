/**
 * Unit tests for GitHubCheckService
 */

import { GitHubCheckService } from '../../src/github-check-service';
import { FailureConditionResult } from '../../src/types/config';
import { ReviewIssue } from '../../src/reviewer';
import { Octokit } from '@octokit/rest';

// Mock Octokit
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockListForRef = jest.fn();

const mockOctokit = {
  rest: {
    checks: {
      create: mockCreate,
      update: mockUpdate,
      listForRef: mockListForRef,
    },
  },
} as unknown as Octokit;

describe('GitHubCheckService', () => {
  let service: GitHubCheckService;

  beforeEach(() => {
    service = new GitHubCheckService(mockOctokit);
    mockCreate.mockClear();
    mockUpdate.mockClear();
    mockListForRef.mockClear();
  });

  describe('createCheckRun', () => {
    it('should create a new check run in queued status', async () => {
      const mockResponse = {
        data: {
          id: 123,
          html_url: 'https://github.com/owner/repo/runs/123',
        },
      };

      mockCreate.mockResolvedValue(mockResponse);

      const options = {
        owner: 'test-owner',
        repo: 'test-repo',
        head_sha: 'abc123',
        name: 'Visor: security',
        details_url: 'https://example.com/details',
        external_id: 'visor-security-abc123',
      };

      const summary = {
        title: 'Security Check',
        summary: 'Running security analysis',
      };

      const result = await service.createCheckRun(options, summary);

      expect(mockCreate).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        name: 'Visor: security',
        head_sha: 'abc123',
        status: 'queued',
        details_url: 'https://example.com/details',
        external_id: 'visor-security-abc123',
        output: {
          title: 'Security Check',
          summary: 'Running security analysis',
          text: undefined,
        },
      });

      expect(result).toEqual({
        id: 123,
        url: 'https://github.com/owner/repo/runs/123',
      });
    });

    it('should handle API errors gracefully', async () => {
      mockCreate.mockRejectedValue(new Error('API Error'));

      const options = {
        owner: 'test-owner',
        repo: 'test-repo',
        head_sha: 'abc123',
        name: 'Visor: security',
      };

      await expect(service.createCheckRun(options)).rejects.toThrow(
        'Failed to create check run: API Error'
      );
    });
  });

  describe('updateCheckRunInProgress', () => {
    it('should update check run to in_progress status', async () => {
      mockUpdate.mockResolvedValue({});

      const summary = {
        title: 'Running Analysis',
        summary: 'AI is analyzing your code...',
      };

      await service.updateCheckRunInProgress('owner', 'repo', 123, summary);

      expect(mockUpdate).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        check_run_id: 123,
        status: 'in_progress',
        output: {
          title: 'Running Analysis',
          summary: 'AI is analyzing your code...',
          text: undefined,
        },
      });
    });
  });

  describe('completeCheckRun', () => {
    it('should complete check run with success when no issues found', async () => {
      mockUpdate.mockResolvedValue({});

      const failureResults: FailureConditionResult[] = [];
      const reviewIssues: ReviewIssue[] = [];

      await service.completeCheckRun(
        'owner',
        'repo',
        123,
        'security',
        failureResults,
        reviewIssues
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        check_run_id: 123,
        status: 'completed',
        conclusion: 'success',
        completed_at: expect.any(String),
        output: expect.objectContaining({
          title: '✅ Check Passed',
          summary: 'security check completed successfully with no issues found.',
        }),
      });
    });

    it('should complete check run with failure when critical issues found', async () => {
      mockUpdate.mockResolvedValue({});

      const failureResults: FailureConditionResult[] = [];
      const reviewIssues: ReviewIssue[] = [
        {
          file: 'src/auth.ts',
          line: 10,
          ruleId: 'security/sql-injection',
          message: 'Potential SQL injection vulnerability',
          severity: 'critical',
          category: 'security',
        },
      ];

      await service.completeCheckRun(
        'owner',
        'repo',
        123,
        'security',
        failureResults,
        reviewIssues
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        check_run_id: 123,
        status: 'completed',
        conclusion: 'failure',
        completed_at: expect.any(String),
        output: expect.objectContaining({
          title: '🚨 Check Failed',
          summary: 'security check failed due to critical issues.',
          annotations: [
            {
              path: 'src/auth.ts',
              start_line: 10,
              end_line: 10,
              annotation_level: 'failure',
              message: 'Potential SQL injection vulnerability',
              title: 'security Issue',
              raw_details: undefined,
            },
          ],
        }),
      });
    });

    it('should complete check run with failure when failure conditions are met', async () => {
      mockUpdate.mockResolvedValue({});

      const failureResults: FailureConditionResult[] = [
        {
          conditionName: 'critical-security',
          expression: 'metadata.criticalIssues > 0',
          failed: true,
          severity: 'error',
          message: 'Critical security issues found',
          haltExecution: false,
        },
      ];
      const reviewIssues: ReviewIssue[] = [];

      await service.completeCheckRun(
        'owner',
        'repo',
        123,
        'security',
        failureResults,
        reviewIssues
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        check_run_id: 123,
        status: 'completed',
        conclusion: 'failure',
        completed_at: expect.any(String),
        output: expect.objectContaining({
          title: '🚨 Check Failed',
          summary: 'security check failed due to failure conditions.',
        }),
      });
    });

    it('should complete check run with neutral when warnings found', async () => {
      mockUpdate.mockResolvedValue({});

      const failureResults: FailureConditionResult[] = [
        {
          conditionName: 'warning-threshold',
          expression: 'metadata.warningIssues > 5',
          failed: true,
          severity: 'warning',
          message: 'Too many warnings found',
          haltExecution: false,
        },
      ];
      const reviewIssues: ReviewIssue[] = [];

      await service.completeCheckRun('owner', 'repo', 123, 'style', failureResults, reviewIssues);

      expect(mockUpdate).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        check_run_id: 123,
        status: 'completed',
        conclusion: 'neutral',
        completed_at: expect.any(String),
        output: expect.objectContaining({
          title: '⚠️ Check Completed with Warnings',
          summary: 'style check completed but found warning conditions.',
        }),
      });
    });

    it('should complete check run with failure when execution error occurs', async () => {
      mockUpdate.mockResolvedValue({});

      const failureResults: FailureConditionResult[] = [];
      const reviewIssues: ReviewIssue[] = [];
      const executionError = 'AI API rate limit exceeded';

      await service.completeCheckRun(
        'owner',
        'repo',
        123,
        'security',
        failureResults,
        reviewIssues,
        executionError
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        check_run_id: 123,
        status: 'completed',
        conclusion: 'failure',
        completed_at: expect.any(String),
        output: expect.objectContaining({
          title: '❌ Check Execution Failed',
          summary: 'The security check failed to execute properly.',
          text: expect.stringContaining('AI API rate limit exceeded'),
        }),
      });
    });

    it('should limit annotations to GitHub API maximum', async () => {
      mockUpdate.mockResolvedValue({});

      // Create 60 issues (more than GitHub's 50 annotation limit)
      const reviewIssues: ReviewIssue[] = Array.from({ length: 60 }, (_, i) => ({
        file: `file${i}.ts`,
        line: i + 1,
        ruleId: `rule-${i}`,
        message: `Issue ${i}`,
        severity: 'warning',
        category: 'style',
      }));

      await service.completeCheckRun('owner', 'repo', 123, 'style', [], reviewIssues);

      const call = mockUpdate.mock.calls[0][0];
      expect(call.output.annotations).toHaveLength(50); // Limited to GitHub's maximum
    });
  });

  describe('createMultipleCheckRuns', () => {
    it('should create multiple check runs for different checks', async () => {
      const mockCreateResponse = {
        data: { id: 123, html_url: 'https://example.com/check/123' },
      };
      mockCreate.mockResolvedValue(mockCreateResponse);
      mockUpdate.mockResolvedValue({});

      const options = {
        owner: 'test-owner',
        repo: 'test-repo',
        head_sha: 'abc123',
        name: 'base-name',
      };

      const checkResults = [
        {
          checkName: 'security',
          failureResults: [],
          reviewIssues: [],
        },
        {
          checkName: 'performance',
          failureResults: [],
          reviewIssues: [],
        },
      ];

      const results = await service.createMultipleCheckRuns(options, checkResults);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        checkName: 'security',
        id: 123,
        url: 'https://example.com/check/123',
      });

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledTimes(4); // 2 in_progress + 2 completed
    });

    it('should continue with other checks if one fails', async () => {
      const mockCreateResponse = {
        data: { id: 123, html_url: 'https://example.com/check/123' },
      };

      mockCreate
        .mockRejectedValueOnce(new Error('Failed to create first check'))
        .mockResolvedValue(mockCreateResponse);
      mockUpdate.mockResolvedValue({});

      const options = {
        owner: 'test-owner',
        repo: 'test-repo',
        head_sha: 'abc123',
        name: 'base-name',
      };

      const checkResults = [
        {
          checkName: 'failing-check',
          failureResults: [],
          reviewIssues: [],
        },
        {
          checkName: 'working-check',
          failureResults: [],
          reviewIssues: [],
        },
      ];

      const results = await service.createMultipleCheckRuns(options, checkResults);

      expect(results).toHaveLength(1);
      expect(results[0].checkName).toBe('working-check');
    });
  });

  describe('getCheckRuns', () => {
    it('should get check runs for a specific commit', async () => {
      const mockResponse = {
        data: {
          check_runs: [
            {
              id: 123,
              name: 'Visor: security',
              status: 'completed',
              conclusion: 'success',
            },
            {
              id: 124,
              name: 'Other Check',
              status: 'completed',
              conclusion: 'failure',
            },
            {
              id: 125,
              name: 'Visor: performance',
              status: 'in_progress',
              conclusion: null,
            },
          ],
        },
      };

      mockListForRef.mockResolvedValue(mockResponse);

      const result = await service.getCheckRuns('owner', 'repo', 'abc123');

      expect(mockListForRef).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'abc123',
        filter: 'all',
      });

      expect(result).toEqual([
        {
          id: 123,
          name: 'Visor: security',
          status: 'completed',
          conclusion: 'success',
        },
        {
          id: 125,
          name: 'Visor: performance',
          status: 'in_progress',
          conclusion: null,
        },
      ]);
    });
  });

  describe('annotation conversion', () => {
    it('should map severity levels correctly', async () => {
      mockUpdate.mockResolvedValue({});

      const reviewIssues: ReviewIssue[] = [
        {
          file: 'critical.ts',
          line: 1,
          ruleId: 'critical-rule',
          message: 'Critical issue',
          severity: 'critical',
          category: 'security',
        },
        {
          file: 'error.ts',
          line: 2,
          ruleId: 'error-rule',
          message: 'Error issue',
          severity: 'error',
          category: 'logic',
        },
        {
          file: 'warning.ts',
          line: 3,
          ruleId: 'warning-rule',
          message: 'Warning issue',
          severity: 'warning',
          category: 'style',
        },
        {
          file: 'info.ts',
          line: 4,
          ruleId: 'info-rule',
          message: 'Info issue',
          severity: 'info',
          category: 'documentation',
        },
      ];

      await service.completeCheckRun('owner', 'repo', 123, 'mixed', [], reviewIssues);

      const call = mockUpdate.mock.calls[0][0];
      const annotations = call.output.annotations;

      expect(annotations[0].annotation_level).toBe('failure'); // critical
      expect(annotations[1].annotation_level).toBe('failure'); // error
      expect(annotations[2].annotation_level).toBe('warning'); // warning
      expect(annotations[3].annotation_level).toBe('notice'); // info
    });
  });
});
