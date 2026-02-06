import { Octokit } from '@octokit/rest';
import { ReactionManager } from '../../src/github-reactions';

describe('ReactionManager', () => {
  let octokit: jest.Mocked<Octokit>;
  let reactionManager: ReactionManager;

  beforeEach(() => {
    octokit = {
      rest: {
        reactions: {
          createForIssue: jest.fn().mockResolvedValue({ data: { id: 12345 } }),
          createForIssueComment: jest.fn().mockResolvedValue({ data: { id: 67890 } }),
          deleteForIssue: jest.fn(),
          deleteForIssueComment: jest.fn(),
        },
      },
    } as any;

    reactionManager = new ReactionManager(octokit);
  });

  describe('addAcknowledgementReaction', () => {
    it('should add eye emoji reaction to an issue and return reaction ID', async () => {
      const reactionId = await reactionManager.addAcknowledgementReaction('owner', 'repo', {
        eventName: 'issues',
        issueNumber: 123,
      });

      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        content: 'eyes',
      });
      expect(reactionId).toBe(12345);
    });

    it('should add eye emoji reaction to a PR and return reaction ID', async () => {
      const reactionId = await reactionManager.addAcknowledgementReaction('owner', 'repo', {
        eventName: 'pull_request',
        issueNumber: 456,
      });

      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 456,
        content: 'eyes',
      });
      expect(reactionId).toBe(12345);
    });

    it('should add eye emoji reaction to a comment and return reaction ID', async () => {
      const reactionId = await reactionManager.addAcknowledgementReaction('owner', 'repo', {
        eventName: 'issue_comment',
        commentId: 789,
      });

      expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 789,
        content: 'eyes',
      });
      expect(reactionId).toBe(67890);
    });

    it('should handle errors gracefully and return null', async () => {
      (octokit.rest.reactions.createForIssue as unknown as jest.Mock).mockRejectedValue(
        new Error('API error')
      );

      const reactionId = await reactionManager.addAcknowledgementReaction('owner', 'repo', {
        eventName: 'issues',
        issueNumber: 123,
      });

      expect(reactionId).toBeNull();
    });
  });

  describe('addCompletionReaction', () => {
    it('should remove eye reaction by ID and add thumbs up on an issue', async () => {
      await reactionManager.addCompletionReaction('owner', 'repo', {
        eventName: 'issues',
        issueNumber: 123,
        acknowledgementReactionId: 12345,
      });

      // Should use direct removal with ID (no list call)
      expect(octokit.rest.reactions.deleteForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        reaction_id: 12345,
      });

      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        content: '+1',
      });
    });

    it('should remove eye reaction by ID and add thumbs up on a comment', async () => {
      await reactionManager.addCompletionReaction('owner', 'repo', {
        eventName: 'issue_comment',
        commentId: 789,
        acknowledgementReactionId: 67890,
      });

      // Should use direct removal with ID (no list call)
      expect(octokit.rest.reactions.deleteForIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 789,
        reaction_id: 67890,
      });

      expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 789,
        content: '+1',
      });
    });

    it('should add thumbs up even if no acknowledgement reaction ID provided', async () => {
      await reactionManager.addCompletionReaction('owner', 'repo', {
        eventName: 'issues',
        issueNumber: 123,
        acknowledgementReactionId: null,
      });

      // Should not try to delete since no ID provided
      expect(octokit.rest.reactions.deleteForIssue).not.toHaveBeenCalled();

      expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        content: '+1',
      });
    });

    it('should handle errors gracefully', async () => {
      (octokit.rest.reactions.deleteForIssue as unknown as jest.Mock).mockRejectedValue(
        new Error('API error')
      );

      // Should not throw
      await expect(
        reactionManager.addCompletionReaction('owner', 'repo', {
          eventName: 'issues',
          issueNumber: 123,
          acknowledgementReactionId: 12345,
        })
      ).resolves.not.toThrow();
    });
  });
});
