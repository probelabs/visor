import {
  hasMinPermission,
  isOwner,
  isMember,
  isCollaborator,
  isContributor,
  isFirstTimer,
  createPermissionHelpers,
  detectLocalMode,
} from '../../src/utils/author-permissions';

describe('author-permissions', () => {
  describe('hasMinPermission', () => {
    it('should return true when author has exact permission level', () => {
      expect(hasMinPermission('MEMBER', 'MEMBER', false)).toBe(true);
      expect(hasMinPermission('COLLABORATOR', 'COLLABORATOR', false)).toBe(true);
    });

    it('should return true when author has higher permission level', () => {
      expect(hasMinPermission('OWNER', 'MEMBER', false)).toBe(true);
      expect(hasMinPermission('MEMBER', 'COLLABORATOR', false)).toBe(true);
      expect(hasMinPermission('COLLABORATOR', 'CONTRIBUTOR', false)).toBe(true);
    });

    it('should return false when author has lower permission level', () => {
      expect(hasMinPermission('COLLABORATOR', 'MEMBER', false)).toBe(false);
      expect(hasMinPermission('CONTRIBUTOR', 'COLLABORATOR', false)).toBe(false);
      expect(hasMinPermission('FIRST_TIMER', 'CONTRIBUTOR', false)).toBe(false);
    });

    it('should return true in local mode regardless of permission', () => {
      expect(hasMinPermission('NONE', 'OWNER', true)).toBe(true);
      expect(hasMinPermission(undefined, 'OWNER', true)).toBe(true);
    });

    it('should handle undefined authorAssociation', () => {
      expect(hasMinPermission(undefined, 'MEMBER', false)).toBe(false);
    });
  });

  describe('isOwner', () => {
    it('should return true for OWNER', () => {
      expect(isOwner('OWNER', false)).toBe(true);
    });

    it('should return false for non-owners', () => {
      expect(isOwner('MEMBER', false)).toBe(false);
      expect(isOwner('COLLABORATOR', false)).toBe(false);
    });

    it('should return true in local mode', () => {
      expect(isOwner('NONE', true)).toBe(true);
      expect(isOwner(undefined, true)).toBe(true);
    });
  });

  describe('isMember', () => {
    it('should return true for OWNER and MEMBER', () => {
      expect(isMember('OWNER', false)).toBe(true);
      expect(isMember('MEMBER', false)).toBe(true);
    });

    it('should return false for lower permissions', () => {
      expect(isMember('COLLABORATOR', false)).toBe(false);
      expect(isMember('CONTRIBUTOR', false)).toBe(false);
    });

    it('should return true in local mode', () => {
      expect(isMember(undefined, true)).toBe(true);
    });
  });

  describe('isCollaborator', () => {
    it('should return true for collaborators and above', () => {
      expect(isCollaborator('OWNER', false)).toBe(true);
      expect(isCollaborator('MEMBER', false)).toBe(true);
      expect(isCollaborator('COLLABORATOR', false)).toBe(true);
    });

    it('should return false for contributors and below', () => {
      expect(isCollaborator('CONTRIBUTOR', false)).toBe(false);
      expect(isCollaborator('FIRST_TIMER', false)).toBe(false);
    });
  });

  describe('isContributor', () => {
    it('should return true for contributors and above', () => {
      expect(isContributor('OWNER', false)).toBe(true);
      expect(isContributor('MEMBER', false)).toBe(true);
      expect(isContributor('COLLABORATOR', false)).toBe(true);
      expect(isContributor('CONTRIBUTOR', false)).toBe(true);
    });

    it('should return false for first-timers', () => {
      expect(isContributor('FIRST_TIME_CONTRIBUTOR', false)).toBe(false);
      expect(isContributor('FIRST_TIMER', false)).toBe(false);
    });
  });

  describe('isFirstTimer', () => {
    it('should return true for first-time contributors', () => {
      expect(isFirstTimer('FIRST_TIME_CONTRIBUTOR', false)).toBe(true);
      expect(isFirstTimer('FIRST_TIMER', false)).toBe(true);
    });

    it('should return false for experienced contributors', () => {
      expect(isFirstTimer('OWNER', false)).toBe(false);
      expect(isFirstTimer('MEMBER', false)).toBe(false);
      expect(isFirstTimer('COLLABORATOR', false)).toBe(false);
      expect(isFirstTimer('CONTRIBUTOR', false)).toBe(false);
    });

    it('should return false in local mode', () => {
      expect(isFirstTimer('FIRST_TIMER', true)).toBe(false);
    });
  });

  describe('createPermissionHelpers', () => {
    it('should create bound helper functions', () => {
      const helpers = createPermissionHelpers('MEMBER', false);

      expect(helpers.isOwner()).toBe(false);
      expect(helpers.isMember()).toBe(true);
      expect(helpers.isCollaborator()).toBe(true);
      expect(helpers.hasMinPermission('COLLABORATOR')).toBe(true);
      expect(helpers.hasMinPermission('OWNER')).toBe(false);
    });

    it('should work in local mode', () => {
      const helpers = createPermissionHelpers(undefined, true);

      expect(helpers.isOwner()).toBe(true);
      expect(helpers.isMember()).toBe(true);
      expect(helpers.isCollaborator()).toBe(true);
      expect(helpers.hasMinPermission('OWNER')).toBe(true);
    });
  });

  describe('detectLocalMode', () => {
    it('should return true when GITHUB_ACTIONS is not set', () => {
      const originalEnv = process.env.GITHUB_ACTIONS;
      delete process.env.GITHUB_ACTIONS;

      expect(detectLocalMode()).toBe(true);

      if (originalEnv !== undefined) {
        process.env.GITHUB_ACTIONS = originalEnv;
      }
    });

    it('should return false when GITHUB_ACTIONS is set', () => {
      const originalEnv = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = 'true';

      expect(detectLocalMode()).toBe(false);

      if (originalEnv !== undefined) {
        process.env.GITHUB_ACTIONS = originalEnv;
      } else {
        delete process.env.GITHUB_ACTIONS;
      }
    });
  });
});
