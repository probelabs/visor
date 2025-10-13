/**
 * Author permission utilities for checking GitHub author associations
 *
 * GitHub provides author_association field with these values (in order of privilege):
 * - OWNER: Repository owner
 * - MEMBER: Organization member
 * - COLLABORATOR: Invited collaborator
 * - CONTRIBUTOR: Has contributed before
 * - FIRST_TIME_CONTRIBUTOR: First PR to this repo
 * - FIRST_TIMER: First GitHub contribution ever
 * - NONE: No association
 */

export type AuthorAssociation =
  | 'OWNER'
  | 'MEMBER'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'NONE';

/**
 * Permission hierarchy (from highest to lowest privilege)
 */
const PERMISSION_HIERARCHY: AuthorAssociation[] = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
];

/**
 * Get permission level (0 = highest, higher number = lower privilege)
 */
function getPermissionLevel(association: string | undefined): number {
  if (!association) return PERMISSION_HIERARCHY.length; // Treat unknown as lowest
  const index = PERMISSION_HIERARCHY.indexOf(association.toUpperCase() as AuthorAssociation);
  return index === -1 ? PERMISSION_HIERARCHY.length : index;
}

/**
 * Check if author has at least the specified permission level (>= logic)
 *
 * @param authorAssociation - The author's association from GitHub API
 * @param minPermission - Minimum required permission level
 * @param isLocalMode - Whether running in local/CLI mode (defaults to true for local runs)
 * @returns true if author has at least the specified permission level
 *
 * @example
 * hasMinPermission('MEMBER', 'MEMBER') // true (exact match)
 * hasMinPermission('OWNER', 'MEMBER') // true (owner >= member)
 * hasMinPermission('COLLABORATOR', 'MEMBER') // false (collaborator < member)
 * hasMinPermission(undefined, 'OWNER', true) // true (local mode)
 */
export function hasMinPermission(
  authorAssociation: string | undefined,
  minPermission: AuthorAssociation,
  isLocalMode: boolean = false
): boolean {
  // In local mode (not GitHub Actions), treat as owner
  if (isLocalMode) {
    return true;
  }

  const authorLevel = getPermissionLevel(authorAssociation);
  const minLevel = getPermissionLevel(minPermission);

  // Lower number = higher privilege, so author must have equal or lower number
  return authorLevel <= minLevel;
}

/**
 * Check if author is exactly the repository owner
 */
export function isOwner(
  authorAssociation: string | undefined,
  isLocalMode: boolean = false
): boolean {
  if (isLocalMode) return true;
  return authorAssociation?.toUpperCase() === 'OWNER';
}

/**
 * Check if author is an organization member or owner
 */
export function isMember(
  authorAssociation: string | undefined,
  isLocalMode: boolean = false
): boolean {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, 'MEMBER', isLocalMode);
}

/**
 * Check if author is a collaborator (or higher)
 */
export function isCollaborator(
  authorAssociation: string | undefined,
  isLocalMode: boolean = false
): boolean {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, 'COLLABORATOR', isLocalMode);
}

/**
 * Check if author is a contributor (has contributed before)
 */
export function isContributor(
  authorAssociation: string | undefined,
  isLocalMode: boolean = false
): boolean {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, 'CONTRIBUTOR', isLocalMode);
}

/**
 * Check if author is a first-time contributor (to this repo or GitHub)
 */
export function isFirstTimer(
  authorAssociation: string | undefined,
  isLocalMode: boolean = false
): boolean {
  if (isLocalMode) return false; // In local mode, not a first-timer
  const assoc = authorAssociation?.toUpperCase();
  return assoc === 'FIRST_TIME_CONTRIBUTOR' || assoc === 'FIRST_TIMER';
}

/**
 * Create permission helper functions bound to a specific author association
 * This is used to inject functions into JavaScript execution contexts
 *
 * @param authorAssociation - The author's association from PR data
 * @param isLocalMode - Whether running in local/CLI mode
 */
export function createPermissionHelpers(
  authorAssociation: string | undefined,
  isLocalMode: boolean = false
) {
  return {
    hasMinPermission: (minPermission: AuthorAssociation) =>
      hasMinPermission(authorAssociation, minPermission, isLocalMode),
    isOwner: () => isOwner(authorAssociation, isLocalMode),
    isMember: () => isMember(authorAssociation, isLocalMode),
    isCollaborator: () => isCollaborator(authorAssociation, isLocalMode),
    isContributor: () => isContributor(authorAssociation, isLocalMode),
    isFirstTimer: () => isFirstTimer(authorAssociation, isLocalMode),
  };
}

/**
 * Determine if we're running in local mode (not GitHub Actions)
 */
export function detectLocalMode(): boolean {
  return !process.env.GITHUB_ACTIONS;
}

/**
 * Resolve the most relevant GitHub author association from an event context.
 * Prefers commenter association for issue_comment events, then issue/PR author,
 * and finally falls back to the provided default association.
 */
export function resolveAssociationFromEvent(
  eventContext: any | undefined,
  fallback?: string
): string | undefined {
  try {
    const ec = eventContext || {};
    return (
      ec?.comment?.author_association ||
      ec?.issue?.author_association ||
      ec?.pull_request?.author_association ||
      fallback
    );
  } catch {
    return fallback;
  }
}
