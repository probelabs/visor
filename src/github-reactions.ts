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
    return this.addReaction(owner, repo, context, 'eyes', '👁️  Added acknowledgement reaction');
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
      const { issueNumber, commentId, acknowledgementReactionId } = context;

      // Remove eye reaction using stored ID (efficient)
      if (acknowledgementReactionId) {
        const type = commentId ? 'comment' : 'issue';
        const itemId = commentId || issueNumber;
        if (itemId === undefined) {
          console.warn('⚠️  Could not determine item ID for reaction removal.');
          return;
        }
        await this.removeReactionById(owner, repo, itemId, acknowledgementReactionId, type);
      }

      // Add thumbs up reaction
      await this.addReaction(owner, repo, context, '+1', '👍 Added completion reaction');
    } catch (error) {
      // Don't fail the action if reaction fails
      console.warn(
        `⚠️  Could not add completion reaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Add a reaction to an issue, PR, or comment
   * Returns the reaction ID or null on error
   */
  private async addReaction(
    owner: string,
    repo: string,
    context: {
      eventName: string;
      issueNumber?: number;
      commentId?: number;
    },
    content: 'eyes' | '+1',
    logPrefix: string
  ): Promise<number | null> {
    try {
      const { eventName, issueNumber, commentId } = context;

      if (commentId) {
        // React to comment
        const response = await this.octokit.rest.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: commentId,
          content,
        });
        console.log(`${logPrefix} to comment ${commentId}`);
        return response.data.id;
      } else if (issueNumber) {
        // React to issue or PR
        const response = await this.octokit.rest.reactions.createForIssue({
          owner,
          repo,
          issue_number: issueNumber,
          content,
        });
        const itemType = eventName === 'issues' ? 'issue' : 'PR';
        console.log(`${logPrefix} to ${itemType} #${issueNumber}`);
        return response.data.id;
      }
      return null;
    } catch (error) {
      // Don't fail the action if reaction fails
      console.warn(
        `⚠️  Could not add ${content} reaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return null;
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
