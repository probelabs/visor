import { Octokit } from '@octokit/rest';
/**
 * Manages GitHub reactions for issues, PRs, and comments
 */
export declare class ReactionManager {
    private octokit;
    constructor(octokit: Octokit);
    /**
     * Add eye emoji reaction to acknowledge event
     * Returns the reaction ID for efficient later removal
     */
    addAcknowledgementReaction(owner: string, repo: string, context: {
        eventName: string;
        issueNumber?: number;
        commentId?: number;
    }): Promise<number | null>;
    /**
     * Replace eye emoji with thumbs up emoji to indicate completion
     * Uses the reaction ID from acknowledgement for efficient removal
     */
    addCompletionReaction(owner: string, repo: string, context: {
        eventName: string;
        issueNumber?: number;
        commentId?: number;
        acknowledgementReactionId?: number | null;
    }): Promise<void>;
    /**
     * Add a reaction to an issue, PR, or comment
     * Returns the reaction ID or null on error
     */
    private addReaction;
    /**
     * Remove a specific reaction by ID (efficient - no list API call needed)
     */
    private removeReactionById;
}
