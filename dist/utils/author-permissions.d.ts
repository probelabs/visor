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
export type AuthorAssociation = 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'FIRST_TIME_CONTRIBUTOR' | 'FIRST_TIMER' | 'NONE';
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
export declare function hasMinPermission(authorAssociation: string | undefined, minPermission: AuthorAssociation, isLocalMode?: boolean): boolean;
/**
 * Check if author is exactly the repository owner
 */
export declare function isOwner(authorAssociation: string | undefined, isLocalMode?: boolean): boolean;
/**
 * Check if author is an organization member or owner
 */
export declare function isMember(authorAssociation: string | undefined, isLocalMode?: boolean): boolean;
/**
 * Check if author is a collaborator (or higher)
 */
export declare function isCollaborator(authorAssociation: string | undefined, isLocalMode?: boolean): boolean;
/**
 * Check if author is a contributor (has contributed before)
 */
export declare function isContributor(authorAssociation: string | undefined, isLocalMode?: boolean): boolean;
/**
 * Check if author is a first-time contributor (to this repo or GitHub)
 */
export declare function isFirstTimer(authorAssociation: string | undefined, isLocalMode?: boolean): boolean;
/**
 * Create permission helper functions bound to a specific author association
 * This is used to inject functions into JavaScript execution contexts
 *
 * @param authorAssociation - The author's association from PR data
 * @param isLocalMode - Whether running in local/CLI mode
 */
export declare function createPermissionHelpers(authorAssociation: string | undefined, isLocalMode?: boolean): {
    hasMinPermission: (minPermission: AuthorAssociation) => boolean;
    isOwner: () => boolean;
    isMember: () => boolean;
    isCollaborator: () => boolean;
    isContributor: () => boolean;
    isFirstTimer: () => boolean;
};
/**
 * Determine if we're running in local mode (not GitHub Actions)
 */
export declare function detectLocalMode(): boolean;
/**
 * Resolve the most relevant GitHub author association from an event context.
 * Prefers commenter association for issue_comment events, then issue/PR author,
 * and finally falls back to the provided default association.
 */
export declare function resolveAssociationFromEvent(eventContext: any | undefined, fallback?: string): string | undefined;
//# sourceMappingURL=author-permissions.d.ts.map