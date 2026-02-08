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

    describe('Slack identity', () => {
      const slackPolicyConfig: PolicyConfig = {
        engine: 'local',
        rules: './policies/',
        roles: {
          admin: {
            author_association: ['OWNER'],
            users: ['cto-user'],
            slack_users: ['U0123ADMIN'],
            emails: ['admin@company.com'],
          },
          developer: {
            author_association: ['MEMBER', 'COLLABORATOR'],
            emails: ['alice@co.com', 'bob@co.com'],
          },
          'eng-channel': {
            slack_channels: ['C0123ENG'],
            slack_users: ['U0123ALICE', 'U0123BOB'],
          },
        },
      };

      it('resolves role by slack_users', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          isLocalMode: false,
          slack: { userId: 'U0123ADMIN', channelId: 'C999', channelType: 'channel' },
        });
        expect(builder.resolveRoles()).toEqual(['admin']);
      });

      it('resolves role by email (case-insensitive)', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          isLocalMode: false,
          slack: { email: 'ADMIN@Company.COM', channelId: 'C999', channelType: 'channel' },
        });
        expect(builder.resolveRoles()).toEqual(['admin']);
      });

      it('resolves developer role by email', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          isLocalMode: false,
          slack: { email: 'alice@co.com', channelId: 'C999', channelType: 'channel' },
        });
        expect(builder.resolveRoles()).toEqual(['developer']);
      });

      it('applies slack_channels gate — role matches when channel is in list', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          isLocalMode: false,
          slack: { userId: 'U0123ALICE', channelId: 'C0123ENG', channelType: 'channel' },
        });
        expect(builder.resolveRoles()).toEqual(['eng-channel']);
      });

      it('applies slack_channels gate — role does NOT match when channel is not in list', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          isLocalMode: false,
          slack: { userId: 'U0123ALICE', channelId: 'C9999OTHER', channelType: 'channel' },
        });
        expect(builder.resolveRoles()).toEqual([]);
      });

      it('applies slack_channels gate — role does NOT match without Slack context', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          isLocalMode: false,
        });
        // eng-channel requires slack_channels AND slack_users, no slack context → no match
        expect(builder.resolveRoles()).toEqual([]);
      });

      it('combines GitHub and Slack criteria (OR for identity)', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          authorAssociation: 'OWNER',
          isLocalMode: false,
          slack: { userId: 'U0123ALICE', channelId: 'C0123ENG', channelType: 'channel' },
        });
        // Should match admin (via author_association) AND eng-channel (via slack_users + channel gate)
        expect(builder.resolveRoles()).toEqual(['admin', 'eng-channel']);
      });

      it('does not match slack-only roles when no Slack context is present', () => {
        const builder = new PolicyInputBuilder(slackPolicyConfig, {
          authorAssociation: 'CONTRIBUTOR',
          isLocalMode: false,
        });
        // No GitHub or Slack match
        expect(builder.resolveRoles()).toEqual([]);
      });
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

    it('includes slack context in OPA input when present', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        authorAssociation: 'OWNER',
        isLocalMode: false,
        slack: {
          userId: 'U0123',
          email: 'admin@co.com',
          channelId: 'C0123',
          channelType: 'channel',
        },
      });

      const input = builder.forCheckExecution({ id: 'test', type: 'ai' });

      expect(input.actor.slack).toEqual({
        userId: 'U0123',
        email: 'admin@co.com',
        channelId: 'C0123',
        channelType: 'channel',
      });
    });

    it('omits slack from OPA input when not present', () => {
      const builder = new PolicyInputBuilder(basePolicyConfig, {
        authorAssociation: 'OWNER',
        isLocalMode: false,
      });

      const input = builder.forCheckExecution({ id: 'test', type: 'ai' });

      expect(input.actor.slack).toBeUndefined();
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
