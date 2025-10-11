import { Octokit } from '@octokit/rest';

/**
 * Manages GitHub reactions for issues, PRs, and comments
 */
export class ReactionManager {
  private octokit: Octokit;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  /**
   * Add eye emoji reaction to acknowledge event
   */
  async addAcknowledgementReaction(
    owner: string,
    repo: string,
    context: {
      eventName: string;
      issueNumber?: number;
      commentId?: number;
    }
  ): Promise<void> {
    try {
      const { eventName, issueNumber, commentId } = context;

      if (commentId) {
        // React to comment
        await this.octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content: 'eyes',
        });
        console.log(`👁️  Added acknowledgement reaction to comment ${commentId}`);
      } else if (issueNumber) {
        // React to issue or PR
        await this.octokit.rest.reactions.createForIssue({
          owner,
          repo,
          issue_number: issueNumber,
          content: 'eyes',
        });
        console.log(
          `👁️  Added acknowledgement reaction to ${eventName === 'issues' ? 'issue' : 'PR'} #${issueNumber}`
        );
      }
    } catch (error) {
      // Don't fail the action if reaction fails
      console.warn(
        `⚠️  Could not add acknowledgement reaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Replace eye emoji with thumbs up emoji to indicate completion
   */
  async addCompletionReaction(
    owner: string,
    repo: string,
    context: {
      eventName: string;
      issueNumber?: number;
      commentId?: number;
    }
  ): Promise<void> {
    try {
      const { eventName, issueNumber, commentId } = context;

      if (commentId) {
        // Remove eye reaction first
        await this.removeReaction(owner, repo, commentId, 'eyes', 'comment');

        // Add thumbs up reaction to comment
        await this.octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content: '+1',
        });
        console.log(`👍 Added completion reaction to comment ${commentId}`);
      } else if (issueNumber) {
        // Remove eye reaction first
        await this.removeReaction(owner, repo, issueNumber, 'eyes', 'issue');

        // Add thumbs up reaction to issue or PR
        await this.octokit.rest.reactions.createForIssue({
          owner,
          repo,
          issue_number: issueNumber,
          content: '+1',
        });
        console.log(
          `👍 Added completion reaction to ${eventName === 'issues' ? 'issue' : 'PR'} #${issueNumber}`
        );
      }
    } catch (error) {
      // Don't fail the action if reaction fails
      console.warn(
        `⚠️  Could not add completion reaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Remove a specific reaction from an issue/PR or comment
   */
  private async removeReaction(
    owner: string,
    repo: string,
    id: number,
    content: 'eyes' | '+1',
    type: 'issue' | 'comment'
  ): Promise<void> {
    try {
      // Get reactions to find the one to delete
      const reactions =
        type === 'comment'
          ? await this.octokit.rest.reactions.listForIssueComment({
              owner,
              repo,
              comment_id: id,
            })
          : await this.octokit.rest.reactions.listForIssue({
              owner,
              repo,
              issue_number: id,
            });

      // Get the authenticated user to match reactions
      let authenticatedUser: string | undefined;
      try {
        const { data: user } = await this.octokit.rest.users.getAuthenticated();
        authenticatedUser = user.login;
      } catch {
        // If we can't get authenticated user, fall back to bot detection
        authenticatedUser = undefined;
      }

      // Find our reaction with the specified content
      // First try to match by authenticated user, then fall back to bot detection
      const reactionToDelete = reactions.data.find(reaction => {
        if (reaction.content !== content) return false;

        // If we know our authenticated user, match by that
        if (authenticatedUser && reaction.user?.login === authenticatedUser) {
          return true;
        }

        // Fall back to bot detection
        return (
          reaction.user?.type === 'Bot' ||
          reaction.user?.login === 'github-actions[bot]' ||
          reaction.user?.login?.endsWith('[bot]')
        );
      });

      if (reactionToDelete) {
        if (type === 'comment') {
          await this.octokit.rest.reactions.deleteForIssueComment({
            owner,
            repo,
            comment_id: id,
            reaction_id: reactionToDelete.id,
          });
        } else {
          await this.octokit.rest.reactions.deleteForIssue({
            owner,
            repo,
            issue_number: id,
            reaction_id: reactionToDelete.id,
          });
        }
        console.log(
          `🗑️  Removed ${content} reaction from ${type} ${id} (user: ${reactionToDelete.user?.login})`
        );
      } else {
        console.log(
          `ℹ️  No ${content} reaction found to remove from ${type} ${id} (looked for user: ${authenticatedUser || 'bot'})`
        );
      }
    } catch (error) {
      // Log warning but don't fail
      console.warn(
        `⚠️  Could not remove ${content} reaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
