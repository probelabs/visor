import { parseComment, getHelpText } from '../../src/commands';

describe('Commands', () => {
  describe('parseComment', () => {
    test('should parse /review command', () => {
      const result = parseComment('/review');
      expect(result).toEqual({
        type: 'review',
        args: undefined,
      });
    });

    test('should parse /review with focus argument', () => {
      const result = parseComment('/review --focus=security');
      expect(result).toEqual({
        type: 'review',
        args: ['--focus=security'],
      });
    });

    test('should parse /review with multiple arguments', () => {
      const result = parseComment('/review --focus=security --format=detailed');
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
      const result = parseComment('/REVIEW');
      expect(result).toEqual({
        type: 'review',
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
      const result = parseComment('  /review --focus=performance  ');
      expect(result).toEqual({
        type: 'review',
        args: ['--focus=performance'],
      });
    });

    test('should return null for empty comment', () => {
      const result = parseComment('');
      expect(result).toBeNull();
    });
  });

  describe('getHelpText', () => {
    test('should return help text with all commands', () => {
      const helpText = getHelpText();

      expect(helpText).toContain('Available Commands');
      expect(helpText).toContain('/review');
      expect(helpText).toContain('/status');
      expect(helpText).toContain('/help');
      expect(helpText).toContain('--focus=security');
      expect(helpText).toContain('--format=detailed');
    });

    test('should return properly formatted markdown', () => {
      const helpText = getHelpText();

      expect(helpText).toMatch(/^## Available Commands/);
      expect(helpText).toContain('`/review`');
      expect(helpText).toContain('`/status`');
      expect(helpText).toContain('`/help`');
    });
  });
});
