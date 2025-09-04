import { CLI } from '../../src/cli';

describe('CLI Argument Parser', () => {
  let cli: CLI;

  beforeEach(() => {
    cli = new CLI();
  });

  describe('Basic Argument Parsing', () => {
    it('should parse single check argument', () => {
      const result = cli.parseArgs(['--check', 'performance']);
      expect(result.checks).toEqual(['performance']);
      expect(result.output).toBe('table'); // default
    });

    it('should parse multiple check arguments', () => {
      const result = cli.parseArgs([
        '--check',
        'performance',
        '--check',
        'architecture',
        '--check',
        'security',
      ]);
      expect(result.checks).toEqual(['performance', 'architecture', 'security']);
    });

    it('should parse output format argument', () => {
      const result = cli.parseArgs(['--check', 'performance', '--output', 'json']);
      expect(result.output).toBe('json');
    });

    it('should parse config file path argument', () => {
      const result = cli.parseArgs(['--config', '/path/to/visor.config.yaml']);
      expect(result.configPath).toBe('/path/to/visor.config.yaml');
    });

    it('should parse all arguments together', () => {
      const result = cli.parseArgs([
        '--check',
        'performance',
        '--check',
        'security',
        '--output',
        'json',
        '--config',
        './custom.yaml',
      ]);
      expect(result.checks).toEqual(['performance', 'security']);
      expect(result.output).toBe('json');
      expect(result.configPath).toBe('./custom.yaml');
    });
  });

  describe('Default Values', () => {
    it('should provide default values when no arguments provided', () => {
      const result = cli.parseArgs([]);
      expect(result.checks).toEqual([]);
      expect(result.output).toBe('table');
      expect(result.configPath).toBeUndefined();
    });

    it('should use default output format when only checks provided', () => {
      const result = cli.parseArgs(['--check', 'performance']);
      expect(result.output).toBe('table');
    });
  });

  describe('Argument Validation', () => {
    it('should validate check types', () => {
      expect(() => cli.parseArgs(['--check', 'invalid-check'])).toThrow(
        'Invalid check type: invalid-check'
      );
    });

    it('should validate output formats', () => {
      expect(() => cli.parseArgs(['--output', 'invalid-format'])).toThrow(
        'Invalid output format: invalid-format'
      );
    });

    it('should allow valid check types', () => {
      const validChecks = ['performance', 'architecture', 'security', 'style', 'all'];
      validChecks.forEach(check => {
        expect(() => cli.parseArgs(['--check', check])).not.toThrow();
      });
    });

    it('should allow valid output formats', () => {
      const validFormats = ['table', 'json', 'markdown'];
      validFormats.forEach(format => {
        expect(() => cli.parseArgs(['--check', 'performance', '--output', format])).not.toThrow();
      });
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown arguments', () => {
      expect(() => cli.parseArgs(['--unknown-flag'])).toThrow();
    });

    it('should throw error for check flag without value', () => {
      expect(() => cli.parseArgs(['--check'])).toThrow();
    });

    it('should throw error for output flag without value', () => {
      expect(() => cli.parseArgs(['--output'])).toThrow();
    });

    it('should throw error for config flag without value', () => {
      expect(() => cli.parseArgs(['--config'])).toThrow();
    });

    it('should provide helpful error messages', () => {
      try {
        cli.parseArgs(['--check', 'invalid']);
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('Invalid check type');
        expect((error as Error).message).toContain(
          'Available options: performance, architecture, security, style, all'
        );
      }
    });
  });

  describe('Help Text', () => {
    it('should generate help text', () => {
      const helpText = cli.getHelpText();
      expect(helpText).toContain('Visor - AI-powered code review tool');
      expect(helpText).toContain('--check');
      expect(helpText).toContain('--output');
      expect(helpText).toContain('--config');
      expect(helpText).toContain('Examples:');
    });

    it('should include examples in help text', () => {
      const helpText = cli.getHelpText();
      expect(helpText).toContain('visor --check performance --output table');
      expect(helpText).toContain(
        'visor --check performance --check security --config ./visor.config.yaml'
      );
    });
  });

  describe('Version Information', () => {
    it('should provide version information', () => {
      const version = cli.getVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('Advanced Parsing Scenarios', () => {
    it('should handle duplicate check types by keeping unique values', () => {
      const result = cli.parseArgs([
        '--check',
        'performance',
        '--check',
        'performance',
        '--check',
        'security',
      ]);
      expect(result.checks).toEqual(['performance', 'security']);
    });

    it('should handle mixed short and long flags', () => {
      const result = cli.parseArgs(['-c', 'performance', '--output', 'json']);
      expect(result.checks).toEqual(['performance']);
      expect(result.output).toBe('json');
    });

    it('should handle config file path with spaces', () => {
      const result = cli.parseArgs(['--config', '/path/with spaces/visor.config.yaml']);
      expect(result.configPath).toBe('/path/with spaces/visor.config.yaml');
    });
  });

  describe('Integration with Configuration', () => {
    it('should return parsed options in expected format', () => {
      const result = cli.parseArgs(['--check', 'performance', '--output', 'json']);

      // Ensure the result matches the CliOptions interface
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('output');
      expect(Array.isArray(result.checks)).toBe(true);
      expect(typeof result.output).toBe('string');
    });

    it('should preserve order of check arguments', () => {
      const result = cli.parseArgs([
        '--check',
        'security',
        '--check',
        'performance',
        '--check',
        'architecture',
      ]);
      expect(result.checks).toEqual(['security', 'performance', 'architecture']);
    });
  });
});
