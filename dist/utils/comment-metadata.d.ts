/**
 * Utility functions for parsing and handling Visor comment metadata
 */
/**
 * Parse visor:thread metadata from a comment body
 * Reuses the same regex pattern from github-frontend.ts for consistency
 */
export declare function parseVisorThreadMetadata(commentBody: string): {
    group?: string;
    [key: string]: any;
} | null;
/**
 * Check if a comment should be filtered out when building AI context for code reviews.
 * This filters Visor's own review comments to avoid bias, while keeping user comments
 * and non-review Visor comments (like overview).
 *
 * @param commentBody - The body text of the comment
 * @returns true if the comment should be filtered out (excluded from AI context)
 */
export declare function shouldFilterVisorReviewComment(commentBody: string | undefined): boolean;
//# sourceMappingURL=comment-metadata.d.ts.map