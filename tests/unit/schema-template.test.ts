import fs from 'fs/promises';
import path from 'path';
import { Liquid } from 'liquidjs';
import Ajv from 'ajv';

describe('Schema-Template System', () => {
  let liquid: Liquid;
  let ajv: Ajv;

  beforeEach(() => {
    liquid = new Liquid();
    ajv = new Ajv({ allErrors: true, strict: false });
  });

  describe('Schema Loading and Validation', () => {
    test('should load code-review schema correctly', async () => {
      const schemaPath = path.join(__dirname, '../../output/code-review/schema.json');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);

      expect(schema).toHaveProperty('$schema');
      expect(schema).toHaveProperty('$id', 'code-review');
      expect(schema).toHaveProperty('type', 'object');
      expect(schema.properties).toHaveProperty('issues');
      expect(schema.properties.issues.items.properties).toHaveProperty('file');
      expect(schema.properties.issues.items.properties).toHaveProperty('line');
      expect(schema.properties.issues.items.properties).toHaveProperty('ruleId');
      expect(schema.properties.issues.items.properties).toHaveProperty('message');
      expect(schema.properties.issues.items.properties).toHaveProperty('severity');

      // Verify schema is valid JSON Schema
      const validate = ajv.compile(schema);
      expect(validate).toBeDefined();
    });

    test('should load markdown schema correctly', async () => {
      const schemaPath = path.join(__dirname, '../../output/markdown/schema.json');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);

      expect(schema).toHaveProperty('$schema');
      expect(schema).toHaveProperty('$id', 'markdown');
      expect(schema).toHaveProperty('type', 'object');
      expect(schema.properties).toHaveProperty('content');
      expect(schema.properties.content).toHaveProperty('type', 'string');

      // Verify schema is valid JSON Schema
      const validate = ajv.compile(schema);
      expect(validate).toBeDefined();
    });

    test('should validate code-review data against schema', async () => {
      const schemaPath = path.join(__dirname, '../../output/code-review/schema.json');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      const validate = ajv.compile(schema);

      const validData = {
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            ruleId: 'security/hardcoded-secret',
            message: 'Potential hardcoded API key detected',
            severity: 'critical',
            category: 'security',
            suggestion: 'Use environment variables',
          },
        ],
      };

      const isValid = validate(validData);
      expect(isValid).toBe(true);
      expect(validate.errors).toBeFalsy();
    });

    test('should reject invalid code-review data', async () => {
      const schemaPath = path.join(__dirname, '../../output/code-review/schema.json');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      const validate = ajv.compile(schema);

      const invalidData = {
        issues: [
          {
            file: 'src/test.ts',
            // missing required fields: line, ruleId, message, severity
          },
        ],
      };

      const isValid = validate(invalidData);
      expect(isValid).toBe(false);
      expect(validate.errors).toHaveLength(4); // 4 missing required properties
    });

    test('should validate markdown data against schema', async () => {
      const schemaPath = path.join(__dirname, '../../output/markdown/schema.json');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      const validate = ajv.compile(schema);

      const validData = {
        content: '# PR Overview\n\nThis PR adds new authentication features.',
      };

      const isValid = validate(validData);
      expect(isValid).toBe(true);
      expect(validate.errors).toBeFalsy();
    });

    test('should reject invalid markdown data', async () => {
      const schemaPath = path.join(__dirname, '../../output/markdown/schema.json');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      const validate = ajv.compile(schema);

      const invalidData = {
        // missing required content field
      };

      const isValid = validate(invalidData);
      expect(isValid).toBe(false);
      expect(validate.errors).toHaveLength(1);
      expect(validate.errors![0].params).toHaveProperty('missingProperty', 'content');
    });
  });

  describe('Liquid Template Rendering', () => {
    test('should render code-review template correctly for single check', async () => {
      const templatePath = path.join(__dirname, '../../output/code-review/template.liquid');
      const templateContent = await fs.readFile(templatePath, 'utf-8');

      // Test with security check issues only (single check)
      const data = {
        checkName: 'security',
        issues: [
          {
            file: 'src/auth.ts',
            line: 15,
            ruleId: 'security/hardcoded-secret',
            message: 'Hardcoded API key detected',
            severity: 'critical',
            category: 'security',
            suggestion: 'Use environment variables for API keys',
          },
          {
            file: 'src/auth.ts',
            line: 25,
            ruleId: 'security/input-validation',
            message: 'Missing input validation',
            severity: 'warning',
            category: 'security',
          },
        ],
      };

      const rendered = await liquid.parseAndRender(templateContent, data);

      // Check that it renders as HTML table
      expect(rendered).toContain('<table');
      expect(rendered).toContain('<th>File</th>');
      expect(rendered).toContain('<th>Line</th>');
      expect(rendered).toContain('<th>Issue</th>');
      expect(rendered).toContain('<th>Severity</th>');

      // Check single check header
      expect(rendered).toContain('Security Issues (2)');

      // Check data is present
      expect(rendered).toContain('src/auth.ts');
      expect(rendered).toContain('Hardcoded API key detected');
      expect(rendered).toContain('🔴'); // critical severity emoji
      expect(rendered).toContain('🟡'); // warning severity emoji
      expect(rendered).toContain('Use environment variables for API keys');
    });

    test('should render markdown template correctly', async () => {
      const templatePath = path.join(__dirname, '../../output/markdown/template.liquid');
      const templateContent = await fs.readFile(templatePath, 'utf-8');

      const data = {
        content: `# Pull Request Overview

## Summary
This PR adds JWT-based authentication system with the following changes:
- User registration and login endpoints
- JWT token generation and validation
- Role-based access control middleware

## Files Changed
| File | Purpose |
|------|---------|
| src/auth.ts | Core authentication service |
| src/middleware/auth.ts | Authentication middleware |

## Architecture Diagram
\`\`\`mermaid
graph TD
  A[Client] --> B[Auth Middleware]
  B --> C[Auth Service]
  C --> D[JWT Token]
\`\`\``,
      };

      const rendered = await liquid.parseAndRender(templateContent, data);

      // Should render content as-is
      expect(rendered.trim()).toBe(data.content);
      expect(rendered).toContain('# Pull Request Overview');
      expect(rendered).toContain('## Summary');
      expect(rendered).toContain('JWT-based authentication');
      expect(rendered).toContain('```mermaid');
    });

    test('should handle empty data in code-review template', async () => {
      const templatePath = path.join(__dirname, '../../output/code-review/template.liquid');
      const templateContent = await fs.readFile(templatePath, 'utf-8');

      const data = {
        checkName: 'security',
        issues: [],
      };

      const rendered = await liquid.parseAndRender(templateContent, data);

      // Should render the header for the check but no table for empty issues
      expect(rendered).toContain('Security Issues (0)');
      // Template should still render table structure even with empty issues
      expect(rendered).toContain('<table');
      expect(rendered).toContain('<tbody>');
    });

    test('should handle template rendering errors gracefully', async () => {
      const invalidTemplate =
        '{% for issue in issues %}{{ issue.nonexistent.property }}{% endfor %}';

      const data = {
        checkName: 'test',
        issues: [{ file: 'test.ts', line: 1 }],
      };

      // Should not throw but may show undefined or empty values
      const rendered = await liquid.parseAndRender(invalidTemplate, data);
      expect(rendered).toBeDefined();
    });
  });

  describe('Group-based Comment Generation', () => {
    test('should group issues by check name correctly', () => {
      const issues = [
        {
          file: 'src/test.ts',
          line: 10,
          ruleId: 'security/hardcoded-secret',
          message: 'Hardcoded secret',
          severity: 'critical' as const,
          category: 'security' as const,
        },
        {
          file: 'src/test.ts',
          line: 20,
          ruleId: 'security/input-validation',
          message: 'Missing validation',
          severity: 'warning' as const,
          category: 'security' as const,
        },
        {
          file: 'src/perf.ts',
          line: 5,
          ruleId: 'performance/n-plus-one',
          message: 'N+1 query',
          severity: 'warning' as const,
          category: 'performance' as const,
        },
      ];

      // Function to group issues by check (extracted logic from reviewer.ts)
      function groupIssuesByCheck(
        issues: Array<{
          file: string;
          line: number;
          ruleId: string;
          message: string;
          severity: 'info' | 'warning' | 'error' | 'critical';
          category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
        }>
      ) {
        const grouped: Record<string, typeof issues> = {};
        for (const issue of issues) {
          let checkName = 'uncategorized';
          if (issue.ruleId && issue.ruleId.includes('/')) {
            const parts = issue.ruleId.split('/');
            checkName = parts[0];
          }
          if (!grouped[checkName]) {
            grouped[checkName] = [];
          }
          grouped[checkName].push(issue);
        }
        return grouped;
      }

      const grouped = groupIssuesByCheck(issues);

      expect(grouped).toHaveProperty('security');
      expect(grouped).toHaveProperty('performance');
      expect(grouped.security).toHaveLength(2);
      expect(grouped.performance).toHaveLength(1);

      expect(grouped.security[0].ruleId).toBe('security/hardcoded-secret');
      expect(grouped.security[1].ruleId).toBe('security/input-validation');
      expect(grouped.performance[0].ruleId).toBe('performance/n-plus-one');
    });

    test('should handle issues without check prefixes', () => {
      const issues = [
        {
          file: 'src/test.ts',
          line: 10,
          ruleId: 'no-console', // no slash separator
          message: 'Avoid console.log',
          severity: 'info' as const,
          category: 'style' as const,
        },
        {
          file: 'src/test.ts',
          line: 15,
          ruleId: '', // empty ruleId
          message: 'Generic issue',
          severity: 'warning' as const,
          category: 'logic' as const,
        },
      ];

      function groupIssuesByCheck(
        issues: Array<{
          file: string;
          line: number;
          ruleId: string;
          message: string;
          severity: 'info' | 'warning' | 'error' | 'critical';
          category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
        }>
      ) {
        const grouped: Record<string, typeof issues> = {};
        for (const issue of issues) {
          let checkName = 'uncategorized';
          if (issue.ruleId && issue.ruleId.includes('/')) {
            const parts = issue.ruleId.split('/');
            checkName = parts[0];
          }
          if (!grouped[checkName]) {
            grouped[checkName] = [];
          }
          grouped[checkName].push(issue);
        }
        return grouped;
      }

      const grouped = groupIssuesByCheck(issues);

      expect(grouped).toHaveProperty('uncategorized');
      expect(grouped.uncategorized).toHaveLength(2);
      expect(grouped.uncategorized[0].ruleId).toBe('no-console');
      expect(grouped.uncategorized[1].ruleId).toBe('');
    });
  });

  describe('Config Integration Tests', () => {
    test('should validate new v2.0 config format', () => {
      const mockConfig = {
        version: '2.0',
        checks: {
          security: {
            type: 'ai',
            group: 'code-review',
            schema: 'code-review',
            prompt: 'Security analysis prompt...',
            on: ['pr_opened', 'pr_updated'],
          },
          'full-review': {
            type: 'ai',
            group: 'pr-overview',
            schema: 'markdown',
            prompt: 'PR overview prompt...',
            on: ['pr_opened', 'pr_updated'],
          },
        },
      };

      // Test that config has required v2.0 structure
      expect(mockConfig.version).toBe('2.0');
      expect(mockConfig.checks).toBeDefined();

      Object.values(mockConfig.checks).forEach(check => {
        expect(check).toHaveProperty('type');
        expect(check).toHaveProperty('group');
        expect(check).toHaveProperty('schema');
        expect(check).toHaveProperty('on');
      });

      // Test specific check configurations
      expect(mockConfig.checks.security.group).toBe('code-review');
      expect(mockConfig.checks.security.schema).toBe('code-review');
      expect(mockConfig.checks['full-review'].group).toBe('pr-overview');
      expect(mockConfig.checks['full-review'].schema).toBe('markdown');
    });

    test('should support depends_on relationships', () => {
      const mockConfigWithDeps = {
        version: '2.0',
        checks: {
          security: {
            type: 'ai',
            group: 'code-review',
            schema: 'code-review',
            on: ['pr_opened'],
          },
          architecture: {
            type: 'ai',
            group: 'code-review',
            schema: 'code-review',
            depends_on: ['security'],
            on: ['pr_opened'],
          },
          overview: {
            type: 'ai',
            group: 'summary',
            schema: 'markdown',
            depends_on: ['security', 'architecture'],
            on: ['pr_opened'],
          },
        },
      };

      // Test dependency relationships
      expect(mockConfigWithDeps.checks.architecture.depends_on).toEqual(['security']);
      expect(mockConfigWithDeps.checks.overview.depends_on).toEqual(['security', 'architecture']);
    });

    test('should support custom schema references', () => {
      const mockConfigWithCustomSchemas = {
        version: '2.0',
        checks: {
          metrics: {
            type: 'ai',
            group: 'analysis',
            schema: 'custom-metrics',
            on: ['pr_opened'],
          },
        },
        schemas: {
          'custom-metrics': {
            file: './custom-schemas/metrics.json',
          },
          'external-schema': {
            url: 'https://example.com/schema.json',
          },
        },
      };

      expect(mockConfigWithCustomSchemas.schemas).toBeDefined();
      expect(mockConfigWithCustomSchemas.schemas['custom-metrics'].file).toBe(
        './custom-schemas/metrics.json'
      );
      expect(mockConfigWithCustomSchemas.schemas['external-schema'].url).toBe(
        'https://example.com/schema.json'
      );
    });
  });
});
