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
      const result = cli.parseArgs(['--config', '/path/to/.visor.yaml']);
      expect(result.configPath).toBe('/path/to/.visor.yaml');
    });

    it('should parse timeout argument in milliseconds', () => {
      const result = cli.parseArgs(['--check', 'performance', '--timeout', '300000']);
      expect(result.timeout).toBe(300000);
    });

    it('should parse timeout with default value when not specified', () => {
      const result = cli.parseArgs(['--check', 'performance']);
      expect(result.timeout).toBeUndefined(); // CLI doesn't set a default, that's done by the execution engine
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
        '--timeout',
        '180000',
      ]);
      expect(result.checks).toEqual(['performance', 'security']);
      expect(result.output).toBe('json');
      expect(result.configPath).toBe('./custom.yaml');
      expect(result.timeout).toBe(180000);
    });
  });

  describe('Default Values', () => {
    it('should provide default values when no arguments provided', () => {
      const result = cli.parseArgs([]);
      expect(result.checks).toEqual([]);
      expect(result.output).toBe('table');
      expect(result.configPath).toBeUndefined();
      expect(result.timeout).toBeUndefined();
    });

    it('should use default output format when only checks provided', () => {
      const result = cli.parseArgs(['--check', 'performance']);
      expect(result.output).toBe('table');
    });
  });

  describe('Argument Validation', () => {
    // Check type validation is now done in main() with actual config, not in CLI parser

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

    it('should throw error for timeout flag without value', () => {
      expect(() => cli.parseArgs(['--timeout'])).toThrow();
    });

    it('should validate timeout is a number', () => {
      expect(() => cli.parseArgs(['--timeout', 'invalid'])).toThrow();
    });

    it('should accept valid timeout values', () => {
      expect(() => cli.parseArgs(['--check', 'performance', '--timeout', '60000'])).not.toThrow();
      expect(() => cli.parseArgs(['--check', 'performance', '--timeout', '300000'])).not.toThrow();
      expect(() => cli.parseArgs(['--check', 'performance', '--timeout', '600000'])).not.toThrow();
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
      expect(helpText).toContain('--timeout');
      expect(helpText).toContain('Examples:');
    });

    it('should include examples in help text', () => {
      const helpText = cli.getHelpText();
      expect(helpText).toContain('visor --check performance --output table');
      expect(helpText).toContain(
        'visor --check performance --check security --config ./.visor.yaml'
      );
      expect(helpText).toContain('visor --check all --timeout 300000 --output json');
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
      const result = cli.parseArgs(['--config', '/path/with spaces/.visor.yaml']);
      expect(result.configPath).toBe('/path/with spaces/.visor.yaml');
    });
  });

  describe('Code Context Flags', () => {
    it('should parse --enable-code-context flag', () => {
      const result = cli.parseArgs(['--enable-code-context']);
      expect(result.codeContext).toBe('enabled');
    });

    it('should parse --disable-code-context flag', () => {
      const result = cli.parseArgs(['--disable-code-context']);
      expect(result.codeContext).toBe('disabled');
    });

    it('should default to auto when no code context flag is provided', () => {
      const result = cli.parseArgs(['--check', 'performance']);
      expect(result.codeContext).toBe('auto');
    });

    it('should handle --enable-code-context with other arguments', () => {
      const result = cli.parseArgs([
        '--check',
        'security',
        '--enable-code-context',
        '--output',
        'json',
      ]);
      expect(result.codeContext).toBe('enabled');
      expect(result.checks).toEqual(['security']);
      expect(result.output).toBe('json');
    });

    it('should handle --disable-code-context with other arguments', () => {
      const result = cli.parseArgs(['--check', 'performance', '--disable-code-context', '--debug']);
      expect(result.codeContext).toBe('disabled');
      expect(result.checks).toEqual(['performance']);
      expect(result.debug).toBe(true);
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
