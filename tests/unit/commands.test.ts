import { parseComment, getHelpText } from '../../src/commands';

describe('Commands', () => {
  describe('parseComment', () => {
    test('should parse /review command when available', () => {
      const result = parseComment('/review', ['review']);
      expect(result).toEqual({
        type: 'review',
        args: undefined,
      });
    });

    test('should not parse /review command when not available', () => {
      const result = parseComment('/review');
      expect(result).toBeNull();
    });

    test('should parse /review with focus argument when available', () => {
      const result = parseComment('/review --focus=security', ['review']);
      expect(result).toEqual({
        type: 'review',
        args: ['--focus=security'],
      });
    });

    test('should parse /review with multiple arguments when available', () => {
      const result = parseComment('/review --focus=security --format=detailed', ['review']);
      expect(result).toEqual({
        type: 'review',
        args: ['--focus=security', '--format=detailed'],
      });
    });

    test('should parse /status command', () => {
      const result = parseComment('/status');
      expect(result).toEqual({
        type: 'status',
        args: undefined,
      });
    });

    test('should parse /help command', () => {
      const result = parseComment('/help');
      expect(result).toEqual({
        type: 'help',
        args: undefined,
      });
    });

    test('should handle case insensitive commands', () => {
      const result = parseComment('/STATUS');
      expect(result).toEqual({
        type: 'status',
        args: undefined,
      });
    });

    test('should return null for non-command comments', () => {
      const result = parseComment('This is just a regular comment');
      expect(result).toBeNull();
    });

    test('should return null for unsupported commands', () => {
      const result = parseComment('/unsupported');
      expect(result).toBeNull();
    });

    test('should handle comments with extra whitespace', () => {
      const result = parseComment('  /status  ');
      expect(result).toEqual({
        type: 'status',
        args: undefined,
      });
    });

    test('should return null for empty comment', () => {
      const result = parseComment('');
      expect(result).toBeNull();
    });
  });

  describe('getHelpText', () => {
    test('should return help text with custom commands', () => {
      const commandRegistry = {
        review: ['security', 'performance'],
        'quick-check': ['style'],
      };
      const helpText = getHelpText(commandRegistry);

      expect(helpText).toContain('Available Commands');
      expect(helpText).toContain('/review');
      expect(helpText).toContain('/quick-check');
      expect(helpText).toContain('/status');
      expect(helpText).toContain('/help');
      expect(helpText).not.toContain('No custom review commands configured');
    });

    test('should show message when no custom commands configured', () => {
      const helpText = getHelpText();

      expect(helpText).toContain('Available Commands');
      expect(helpText).toContain('No custom review commands configured');
      expect(helpText).toContain('/status');
      expect(helpText).toContain('/help');
    });

    test('should return properly formatted markdown', () => {
      const commandRegistry = {
        review: ['all-checks'],
      };
      const helpText = getHelpText(commandRegistry);

      expect(helpText).toMatch(/^## Available Commands/);
      expect(helpText).toContain('`/review`');
      expect(helpText).toContain('`/status`');
      expect(helpText).toContain('`/help`');
    });
  });
});
