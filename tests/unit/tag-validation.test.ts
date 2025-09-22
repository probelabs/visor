import { ConfigManager } from '../../src/config';
import { VisorConfig } from '../../src/types/config';
import * as path from 'path';
import * as fs from 'fs';

describe('Tag Validation', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    configManager = new ConfigManager();
  });

  describe('Check tags validation', () => {
    it('should validate correct tag format', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
            tags: ['security', 'critical', 'test-tag', 'tag_with_underscore', 'tag123'],
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-valid-tags.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).resolves.toBeDefined();
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject tags starting with hyphen', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
            tags: ['-invalid-tag'],
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-invalid-tags.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(
          /tags must be alphanumeric with hyphens or underscores/
        );
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject tags with special characters', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
            tags: ['tag@special'],
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-special-char-tags.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(
          /tags must be alphanumeric with hyphens or underscores/
        );
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject non-array tags', async () => {
      const config = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
            tags: 'not-an-array', // Invalid: should be an array
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-non-array-tags.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(
          /must be an array of strings/
        );
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject non-string items in tags array', async () => {
      const config = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
            tags: ['valid-tag', 123, 'another-tag'], // Invalid: contains number
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-mixed-tags.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(/must be a string/);
      } finally {
        fs.unlinkSync(tempFile);
      }
    });
  });

  describe('Global tag_filter validation', () => {
    it('should validate correct tag_filter', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
        tag_filter: {
          include: ['local', 'fast'],
          exclude: ['experimental', 'slow'],
        },
      };

      const tempFile = path.join(__dirname, 'test-config-valid-filter.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).resolves.toBeDefined();
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should accept tag_filter with only include', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
        tag_filter: {
          include: ['local'],
        },
      };

      const tempFile = path.join(__dirname, 'test-config-include-only.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).resolves.toBeDefined();
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should accept tag_filter with only exclude', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
        tag_filter: {
          exclude: ['experimental'],
        },
      };

      const tempFile = path.join(__dirname, 'test-config-exclude-only.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).resolves.toBeDefined();
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject invalid tags in tag_filter.include', async () => {
      const config = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
        tag_filter: {
          include: ['valid-tag', '@invalid'],
        },
      };

      const tempFile = path.join(__dirname, 'test-config-invalid-include.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(
          /tags must be alphanumeric with hyphens or underscores/
        );
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject invalid tags in tag_filter.exclude', async () => {
      const config = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'security check',
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
        tag_filter: {
          exclude: ['valid-tag', '!invalid'],
        },
      };

      const tempFile = path.join(__dirname, 'test-config-invalid-exclude.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(
          /tags must be alphanumeric with hyphens or underscores/
        );
      } finally {
        fs.unlinkSync(tempFile);
      }
    });
  });
});
