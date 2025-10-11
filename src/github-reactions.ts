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
   * Returns the reaction ID for efficient later removal
   */
  async addAcknowledgementReaction(
    owner: string,
    repo: string,
    context: {
      eventName: string;
      issueNumber?: number;
      commentId?: number;
    }
  ): Promise<number | null> {
    try {
      const { eventName, issueNumber, commentId } = context;

      if (commentId) {
        // React to comment
        const response = await this.octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content: 'eyes',
        });
        console.log(`👁️  Added acknowledgement reaction to comment ${commentId}`);
        return response.data.id;
      } else if (issueNumber) {
        // React to issue or PR
        const response = await this.octokit.rest.reactions.createForIssue({
          owner,
          repo,
          issue_number: issueNumber,
          content: 'eyes',
        });
        console.log(
          `👁️  Added acknowledgement reaction to ${eventName === 'issues' ? 'issue' : 'PR'} #${issueNumber}`
        );
        return response.data.id;
      }
      return null;
    } catch (error) {
      // Don't fail the action if reaction fails
      console.warn(
        `⚠️  Could not add acknowledgement reaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return null;
    }
  }

  /**
   * Replace eye emoji with thumbs up emoji to indicate completion
   * Uses the reaction ID from acknowledgement for efficient removal
   */
  async addCompletionReaction(
    owner: string,
    repo: string,
    context: {
      eventName: string;
      issueNumber?: number;
      commentId?: number;
      acknowledgementReactionId?: number | null;
    }
  ): Promise<void> {
    try {
      const { eventName, issueNumber, commentId, acknowledgementReactionId } = context;

      if (commentId) {
        // Remove eye reaction using stored ID (efficient)
        if (acknowledgementReactionId) {
          await this.removeReactionById(owner, repo, commentId, acknowledgementReactionId, 'comment');
        }

        // Add thumbs up reaction to comment
        await this.octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content: '+1',
        });
        console.log(`👍 Added completion reaction to comment ${commentId}`);
      } else if (issueNumber) {
        // Remove eye reaction using stored ID (efficient)
        if (acknowledgementReactionId) {
          await this.removeReactionById(owner, repo, issueNumber, acknowledgementReactionId, 'issue');
        }

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
   * Remove a specific reaction by ID (efficient - no list API call needed)
   */
  private async removeReactionById(
    owner: string,
    repo: string,
    itemId: number,
    reactionId: number,
    type: 'issue' | 'comment'
  ): Promise<void> {
    try {
      if (type === 'comment') {
        await this.octokit.rest.reactions.deleteForIssueComment({
          owner,
          repo,
          comment_id: itemId,
          reaction_id: reactionId,
        });
      } else {
        await this.octokit.rest.reactions.deleteForIssue({
          owner,
          repo,
          issue_number: itemId,
          reaction_id: reactionId,
        });
      }
      console.log(`🗑️  Removed reaction ${reactionId} from ${type} ${itemId}`);
    } catch (error) {
      // Log warning but don't fail
      console.warn(
        `⚠️  Could not remove reaction ${reactionId}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
