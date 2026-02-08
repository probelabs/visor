import { PolicyInputBuilder } from '../../../src/enterprise/policy/policy-input-builder';
import type { PolicyConfig } from '../../../src/policy/types';

describe('PolicyInputBuilder', () => {
  const basePolicyConfig: PolicyConfig = {
    engine: 'local',
    rules: './policies/',
    roles: {
      admin: {
        author_association: ['OWNER'],
        users: ['cto-user'],
      },
      developer: {
        author_association: ['MEMBER', 'COLLABORATOR'],
      },
      external: {
        author_association: ['FIRST_TIME_CONTRIBUTOR', 'NONE'],
      },
    },
  };

  describe('resolveRoles', () => {
    it('resolves roles by author_association', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        authorAssociation: 'OWNER',
        isLocalMode: false,
      });
      expect(builder.resolveRoles()).toEqual(['admin']);
    });

    it('resolves roles by username', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        login: 'cto-user',
        isLocalMode: false,
      });
      expect(builder.resolveRoles()).toEqual(['admin']);
    });

    it('resolves multiple roles', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        authorAssociation: 'MEMBER',
        isLocalMode: false,
      });
      expect(builder.resolveRoles()).toEqual(['developer']);
    });

    it('returns empty array when no roles match', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        authorAssociation: 'CONTRIBUTOR',
        isLocalMode: false,
      });
      expect(builder.resolveRoles()).toEqual([]);
    });

    it('returns empty array when no roles are configured', () => {
      const builder = new PolicyInputBuilder(
        { engine: 'local', rules: './policies/' },
        { authorAssociation: 'OWNER', isLocalMode: false }
      );
      expect(builder.resolveRoles()).toEqual([]);
    });
  });

  describe('forCheckExecution', () => {
    it('builds correct input for check execution', () => {
      const builder = new PolicyInputBuilder(
        basePolicyConfig,
        { authorAssociation: 'OWNER', login: 'admin-user', isLocalMode: false },
        { owner: 'org', name: 'repo', branch: 'feature', baseBranch: 'main' }
      );

      const input = builder.forCheckExecution({
        id: 'security-scan',
        type: 'ai',
        group: 'security',
        tags: ['security', 'critical'],
        criticality: 'external',
        policy: { require: 'admin' },
      });

      expect(input.scope).toBe('check.execute');
      expect(input.check?.id).toBe('security-scan');
      expect(input.check?.type).toBe('ai');
      expect(input.check?.policy?.require).toBe('admin');
      expect(input.actor.roles).toEqual(['admin']);
      expect(input.actor.isLocalMode).toBe(false);
      expect(input.repository?.owner).toBe('org');
    });
  });

  describe('forToolInvocation', () => {
    it('builds correct input for tool invocation', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        authorAssociation: 'MEMBER',
        isLocalMode: true,
      });

      const input = builder.forToolInvocation('github-mcp', 'search_issues', 'stdio');

      expect(input.scope).toBe('tool.invoke');
      expect(input.tool?.serverName).toBe('github-mcp');
      expect(input.tool?.methodName).toBe('search_issues');
      expect(input.tool?.transport).toBe('stdio');
      expect(input.actor.roles).toEqual(['developer']);
      expect(input.actor.isLocalMode).toBe(true);
    });
  });

  describe('forCapabilityResolve', () => {
    it('builds correct input for capability resolution', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        authorAssociation: 'NONE',
        isLocalMode: false,
      });

      const input = builder.forCapabilityResolve('ai-review', {
        allowEdit: true,
        allowBash: true,
        allowedTools: ['search', 'bash'],
      });

      expect(input.scope).toBe('capability.resolve');
      expect(input.check?.id).toBe('ai-review');
      expect(input.check?.type).toBe('ai');
      expect(input.capability?.allowEdit).toBe(true);
      expect(input.capability?.allowBash).toBe(true);
      expect(input.actor.roles).toEqual(['external']);
    });
  });
});
