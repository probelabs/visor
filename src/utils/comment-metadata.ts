/**
 * Utility functions for parsing and handling Visor comment metadata
 */

/**
 * Parse visor:thread metadata from a comment body
 * Reuses the same regex pattern from github-frontend.ts for consistency
 */
export function parseVisorThreadMetadata(
  commentBody: string
): { group?: string; [key: string]: any } | null {
  const headerRe = /<!--\s*visor:thread=(\{[\s\S]*?\})\s*-->/m;
  const match = headerRe.exec(commentBody);

  if (!match) {
    return null;
  }

  try {
    const metadata = JSON.parse(match[1]);
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata
      : null;
  } catch {
    // If parsing fails, return null (graceful handling)
    return null;
  }
}

/**
 * Check if a comment should be filtered out when building AI context for code reviews.
 * This filters Visor's own review comments to avoid bias, while keeping user comments
 * and non-review Visor comments (like overview).
 *
 * @param commentBody - The body text of the comment
 * @returns true if the comment should be filtered out (excluded from AI context)
 */
export function shouldFilterVisorReviewComment(commentBody: string | undefined): boolean {
  if (!commentBody) {
    return false;
  }

  // Old format: check for visor-comment-id:pr-review- pattern
  if (commentBody.includes('visor-comment-id:pr-review-')) {
    return true;
  }

  // New format: check for visor:thread metadata with group="review"
  const metadata = parseVisorThreadMetadata(commentBody);
  if (metadata && metadata.group === 'review') {
    return true;
  }

  return false;
}
