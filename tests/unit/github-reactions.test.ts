import { Octokit } from '@octokit/rest';
import { ReactionManager } from '../../src/github-reactions';

describe('ReactionManager', () => {
  let octokit: jest.Mocked<Octokit>;
  let reactionManager: ReactionManager;

  beforeEach(() => {
    octokit = {
      rest: {
        reactions: {
          createForIssue: jest.fn(),
          createForIssueComment: jest.fn(),
          listForIssue: jest.fn(),
          listForIssueComment: jest.fn(),
          deleteForIssue: jest.fn(),
          deleteForIssueComment: jest.fn(),
        },
        users: {
          getAuthenticated: jest.fn().mockResolvedValue({
            data: {
              login: 'visor[bot]',
              type: 'Bot',
            },
          }),
        },
      },
    } as any;

    reactionManager = new ReactionManager(octokit);
  });

  describe('addAcknowledgementReaction', () => {
    it('should add eye emoji reaction to an issue', async () => {
      await reactionManager.addAcknowledgementReaction('owner', 'repo', {
        eventName: 'issues',
        issueNumber: 123,
      });

      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        content: 'eyes',
      });
    });

    it('should add eye emoji reaction to a PR', async () => {
      await reactionManager.addAcknowledgementReaction('owner', 'repo', {
        eventName: 'pull_request',
        issueNumber: 456,
      });

      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 456,
        content: 'eyes',
      });
    });

    it('should add eye emoji reaction to a comment', async () => {
      await reactionManager.addAcknowledgementReaction('owner', 'repo', {
        eventName: 'issue_comment',
        commentId: 789,
      });

      expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 789,
        content: 'eyes',
      });
    });

    it('should handle errors gracefully', async () => {
      (octokit.rest.reactions.createForIssue as unknown as jest.Mock).mockRejectedValue(
        new Error('API error')
      );

      // Should not throw
      await expect(
        reactionManager.addAcknowledgementReaction('owner', 'repo', {
          eventName: 'issues',
          issueNumber: 123,
        })
      ).resolves.not.toThrow();
    });
  });

  describe('addCompletionReaction', () => {
    it('should replace eye with thumbs up emoji on an issue', async () => {
      (octokit.rest.reactions.listForIssue as unknown as jest.Mock).mockResolvedValue({
        data: [
          {
            id: 1,
            content: 'eyes',
            user: { type: 'Bot', login: 'visor[bot]' },
          },
        ],
      } as any);

      await reactionManager.addCompletionReaction('owner', 'repo', {
        eventName: 'issues',
        issueNumber: 123,
      });

      expect(octokit.rest.reactions.listForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
      });

      expect(octokit.rest.reactions.deleteForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        reaction_id: 1,
      });

      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        content: '+1',
      });
    });

    it('should replace eye with thumbs up emoji on a comment', async () => {
      (octokit.rest.reactions.listForIssueComment as unknown as jest.Mock).mockResolvedValue({
        data: [
          {
            id: 2,
            content: 'eyes',
            user: { type: 'Bot', login: 'visor[bot]' },
          },
        ],
      } as any);

      await reactionManager.addCompletionReaction('owner', 'repo', {
        eventName: 'issue_comment',
        commentId: 789,
      });

      expect(octokit.rest.reactions.listForIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 789,
      });

      expect(octokit.rest.reactions.deleteForIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 789,
        reaction_id: 2,
      });

      expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 789,
        content: '+1',
      });
    });

    it('should add thumbs up even if no eye reaction exists', async () => {
      (octokit.rest.reactions.listForIssue as unknown as jest.Mock).mockResolvedValue({
        data: [],
      } as any);

      await reactionManager.addCompletionReaction('owner', 'repo', {
        eventName: 'issues',
        issueNumber: 123,
      });

      expect(octokit.rest.reactions.deleteForIssue).not.toHaveBeenCalled();
      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        content: '+1',
      });
    });

    it('should handle errors gracefully', async () => {
      (octokit.rest.reactions.listForIssue as unknown as jest.Mock).mockRejectedValue(
        new Error('API error')
      );

      // Should not throw
      await expect(
        reactionManager.addCompletionReaction('owner', 'repo', {
          eventName: 'issues',
          issueNumber: 123,
        })
      ).resolves.not.toThrow();
    });
  });
});
