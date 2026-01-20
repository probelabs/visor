/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigManager } from '../../src/config';
import { VisorConfig } from '../../src/types/config';

describe('Session Reuse Configuration Validation', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    configManager = new ConfigManager();
  });

  describe('reuse_ai_session validation', () => {
    it('should accept valid configuration with reuse_ai_session and depends_on', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'security-check': {
            type: 'ai',
            prompt: 'Check for security issues',
            on: ['pr_opened'],
          },
          'follow-up-check': {
            type: 'ai',
            prompt: 'Follow up on security findings',
            on: ['pr_opened'],
            depends_on: ['security-check'],
            reuse_ai_session: true,
          },
        },
      };

      expect(() => {
        // Use private method for direct validation testing
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });

    it('should reject reuse_ai_session=true without depends_on', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'invalid-check': {
            type: 'ai',
            prompt: 'Invalid check without dependency',
            on: ['pr_opened'],
            reuse_ai_session: true, // Invalid: no depends_on
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).toThrow(/reuse_ai_session=true but missing or empty depends_on/);
    });

    it('should reject reuse_ai_session=true with empty depends_on array', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'invalid-check': {
            type: 'ai',
            prompt: 'Invalid check with empty dependency',
            on: ['pr_opened'],
            depends_on: [], // Empty array is invalid
            reuse_ai_session: true,
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).toThrow(/reuse_ai_session=true but missing or empty depends_on/);
    });

    it('should accept string reuse_ai_session value referencing valid check', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'parent-check': {
            type: 'ai',
            prompt: 'Parent check',
            on: ['pr_opened'],
          },
          'child-check': {
            type: 'ai',
            prompt: 'Child check with string session reuse',
            on: ['pr_opened'],
            depends_on: ['parent-check'],
            reuse_ai_session: 'parent-check', // String referencing check name
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });

    it('should reject string reuse_ai_session referencing non-existent check', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'invalid-check': {
            type: 'ai',
            prompt: 'Invalid check with non-existent session reuse',
            on: ['pr_opened'],
            depends_on: ['parent-check'],
            reuse_ai_session: 'non-existent-check', // References check that doesn't exist
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).toThrow(/references non-existent check "non-existent-check"/);
    });

    it('should reject invalid reuse_ai_session type (number)', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'invalid-check': {
            type: 'ai',
            prompt: 'Invalid check with number reuse_ai_session',
            on: ['pr_opened'],
            depends_on: ['parent-check'],
            reuse_ai_session: 123 as any, // Should be string or boolean
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).toThrow(/must be string \(check name\) or boolean/);
    });

    it('should accept reuse_ai_session=false without depends_on', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'valid-check': {
            type: 'ai',
            prompt: 'Valid check with explicit false',
            on: ['pr_opened'],
            reuse_ai_session: false, // Explicitly false is valid without depends_on
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });

    it('should accept reuse_ai_session=\"self\" without depends_on', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'loop-check': {
            type: 'ai',
            prompt: 'Chat-like loop that reuses its own session',
            on: ['pr_opened'],
            // Special self-reuse mode does not require depends_on
            reuse_ai_session: 'self',
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });

    it('should accept reuse_ai_session=true with multiple dependencies', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'check-1': {
            type: 'ai',
            prompt: 'First check',
            on: ['pr_opened'],
          },
          'check-2': {
            type: 'ai',
            prompt: 'Second check',
            on: ['pr_opened'],
          },
          'dependent-check': {
            type: 'ai',
            prompt: 'Check that depends on multiple others',
            on: ['pr_opened'],
            depends_on: ['check-1', 'check-2'],
            reuse_ai_session: true, // Valid with multiple dependencies
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });

    it('should accept configuration without reuse_ai_session property', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'normal-check': {
            type: 'ai',
            prompt: 'Normal check without session reuse',
            on: ['pr_opened'],
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });
  });

  describe('complex dependency scenarios', () => {
    it('should validate multiple checks reusing same session via string reference', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          overview: {
            type: 'ai',
            prompt: 'PR overview',
            on: ['pr_opened'],
          },
          security: {
            type: 'ai',
            prompt: 'Security analysis',
            on: ['pr_opened'],
            depends_on: ['overview'],
            reuse_ai_session: 'overview', // Explicitly reuse overview session
          },
          performance: {
            type: 'ai',
            prompt: 'Performance analysis',
            on: ['pr_opened'],
            depends_on: ['security'],
            reuse_ai_session: 'overview', // Also reuse overview session, not security
          },
          quality: {
            type: 'ai',
            prompt: 'Code quality analysis',
            on: ['pr_opened'],
            depends_on: ['performance'],
            reuse_ai_session: 'overview', // Also reuse overview session
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });

    it('should validate chain of session reuse dependencies', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'base-check': {
            type: 'ai',
            prompt: 'Base security scan',
            on: ['pr_opened'],
          },
          'detail-check': {
            type: 'ai',
            prompt: 'Detailed analysis based on base scan',
            on: ['pr_opened'],
            depends_on: ['base-check'],
            reuse_ai_session: true,
          },
          'summary-check': {
            type: 'ai',
            prompt: 'Summary based on detailed analysis',
            on: ['pr_opened'],
            depends_on: ['detail-check'],
            reuse_ai_session: true,
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });

    it('should validate mixed session reuse and non-reuse dependencies', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'scan-1': {
            type: 'ai',
            prompt: 'First scan',
            on: ['pr_opened'],
          },
          'scan-2': {
            type: 'ai',
            prompt: 'Second scan',
            on: ['pr_opened'],
          },
          analysis: {
            type: 'ai',
            prompt: 'Analysis combining both scans',
            on: ['pr_opened'],
            depends_on: ['scan-1', 'scan-2'],
            // No reuse_ai_session - creates its own session
          },
          'follow-up': {
            type: 'ai',
            prompt: 'Follow-up based on analysis',
            on: ['pr_opened'],
            depends_on: ['analysis'],
            reuse_ai_session: true, // Reuses analysis session
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).not.toThrow();
    });
  });
});
