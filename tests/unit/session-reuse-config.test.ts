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

    it('should reject non-boolean reuse_ai_session value', () => {
      const config: Partial<VisorConfig> = {
        version: '1.0',
        checks: {
          'invalid-check': {
            type: 'ai',
            prompt: 'Invalid check with non-boolean reuse_ai_session',
            on: ['pr_opened'],
            depends_on: ['parent-check'],
            reuse_ai_session: 'true' as any, // Should be boolean, not string
          },
        },
      };

      expect(() => {
        (configManager as any).validateConfig(config);
      }).toThrow(/must be boolean/);
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
