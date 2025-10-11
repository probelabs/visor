import { createExtendedLiquid } from '../../src/liquid-extensions';

describe('Liquid permission filters', () => {
  let liquid: ReturnType<typeof createExtendedLiquid>;

  beforeEach(() => {
    // Mock GITHUB_ACTIONS to ensure we're not in local mode
    process.env.GITHUB_ACTIONS = 'true';
    liquid = createExtendedLiquid();
  });

  afterEach(() => {
    delete process.env.GITHUB_ACTIONS;
  });

  describe('has_min_permission filter', () => {
    it('should return true when author has exact permission', async () => {
      const template = '{{ authorAssociation | has_min_permission: "MEMBER" }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'MEMBER' });
      expect(result.trim()).toBe('true');
    });

    it('should return true when author has higher permission', async () => {
      const template = '{{ authorAssociation | has_min_permission: "COLLABORATOR" }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'MEMBER' });
      expect(result.trim()).toBe('true');
    });

    it('should return false when author has lower permission', async () => {
      const template = '{{ authorAssociation | has_min_permission: "MEMBER" }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'COLLABORATOR' });
      expect(result.trim()).toBe('false');
    });
  });

  describe('is_owner filter', () => {
    it('should return true for OWNER', async () => {
      const template = '{{ authorAssociation | is_owner }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'OWNER' });
      expect(result.trim()).toBe('true');
    });

    it('should return false for non-owners', async () => {
      const template = '{{ authorAssociation | is_owner }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'MEMBER' });
      expect(result.trim()).toBe('false');
    });
  });

  describe('is_member filter', () => {
    it('should return true for MEMBER', async () => {
      const template = '{{ authorAssociation | is_member }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'MEMBER' });
      expect(result.trim()).toBe('true');
    });

    it('should return true for OWNER', async () => {
      const template = '{{ authorAssociation | is_member }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'OWNER' });
      expect(result.trim()).toBe('true');
    });

    it('should return false for COLLABORATOR', async () => {
      const template = '{{ authorAssociation | is_member }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'COLLABORATOR' });
      expect(result.trim()).toBe('false');
    });
  });

  describe('is_collaborator filter', () => {
    it('should return true for collaborators and above', async () => {
      const template = '{{ authorAssociation | is_collaborator }}';
      let result = await liquid.parseAndRender(template, { authorAssociation: 'OWNER' });
      expect(result.trim()).toBe('true');

      result = await liquid.parseAndRender(template, { authorAssociation: 'MEMBER' });
      expect(result.trim()).toBe('true');

      result = await liquid.parseAndRender(template, { authorAssociation: 'COLLABORATOR' });
      expect(result.trim()).toBe('true');
    });

    it('should return false for contributors', async () => {
      const template = '{{ authorAssociation | is_collaborator }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'CONTRIBUTOR' });
      expect(result.trim()).toBe('false');
    });
  });

  describe('is_first_timer filter', () => {
    it('should return true for FIRST_TIMER', async () => {
      const template = '{{ authorAssociation | is_first_timer }}';
      const result = await liquid.parseAndRender(template, {
        authorAssociation: 'FIRST_TIMER',
      });
      expect(result.trim()).toBe('true');
    });

    it('should return true for FIRST_TIME_CONTRIBUTOR', async () => {
      const template = '{{ authorAssociation | is_first_timer }}';
      const result = await liquid.parseAndRender(template, {
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      });
      expect(result.trim()).toBe('true');
    });

    it('should return false for experienced contributors', async () => {
      const template = '{{ authorAssociation | is_first_timer }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'CONTRIBUTOR' });
      expect(result.trim()).toBe('false');
    });
  });

  describe('conditional templates', () => {
    it('should work in if statements', async () => {
      const template = `
        {% if authorAssociation | is_member %}
        Welcome, team member!
        {% else %}
        Welcome, contributor!
        {% endif %}
      `;

      let result = await liquid.parseAndRender(template, { authorAssociation: 'MEMBER' });
      expect(result).toContain('Welcome, team member!');

      result = await liquid.parseAndRender(template, { authorAssociation: 'CONTRIBUTOR' });
      expect(result).toContain('Welcome, contributor!');
    });

    it('should work with elsif chains', async () => {
      const template = `
        {% if authorAssociation | is_owner %}
        Owner
        {% elsif authorAssociation | is_member %}
        Member
        {% elsif authorAssociation | is_first_timer %}
        First-timer
        {% else %}
        Other
        {% endif %}
      `;

      let result = await liquid.parseAndRender(template, { authorAssociation: 'OWNER' });
      expect(result).toContain('Owner');

      result = await liquid.parseAndRender(template, { authorAssociation: 'MEMBER' });
      expect(result).toContain('Member');

      result = await liquid.parseAndRender(template, { authorAssociation: 'FIRST_TIMER' });
      expect(result).toContain('First-timer');

      result = await liquid.parseAndRender(template, { authorAssociation: 'CONTRIBUTOR' });
      expect(result).toContain('Other');
    });

    it('should work with pr.authorAssociation in context', async () => {
      const template = `
        {% if pr.authorAssociation | has_min_permission: "MEMBER" %}
        Quick scan
        {% else %}
        Full scan
        {% endif %}
      `;

      let result = await liquid.parseAndRender(template, {
        pr: { authorAssociation: 'MEMBER' },
      });
      expect(result).toContain('Quick scan');

      result = await liquid.parseAndRender(template, {
        pr: { authorAssociation: 'CONTRIBUTOR' },
      });
      expect(result).toContain('Full scan');
    });
  });

  describe('local mode', () => {
    it('should return true for all checks in local mode', async () => {
      delete process.env.GITHUB_ACTIONS;
      liquid = createExtendedLiquid();

      const template = '{{ authorAssociation | is_owner }}';
      const result = await liquid.parseAndRender(template, { authorAssociation: 'NONE' });
      expect(result.trim()).toBe('true');
    });
  });
});
