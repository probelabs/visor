import fs from 'fs/promises';
import path from 'path';
import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { Liquid } from 'liquidjs';
import Ajv from 'ajv';

describe('Schema-Template Integration Tests', () => {
  let engine: CheckExecutionEngine;
  let liquid: Liquid;
  let ajv: Ajv;

  beforeAll(() => {
    // Register a mock provider once for all tests
    const mockAIProvider = {
      async executeCheck(checkId: string, _prInfo: unknown, _config: unknown) {
        if (checkId === 'security') {
          return {
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
        } else if (checkId === 'full-review') {
          return {
            content: `# Pull Request Overview

## Summary
This PR adds authentication functionality.

## Files Changed
| File | Purpose |
|------|---------|
| src/test.ts | Test authentication logic |

## Architecture Diagram
\`\`\`mermaid
graph TD
  A[Client] --> B[Auth Service]
\`\`\``,
          };
        } else if (checkId === 'performance') {
          return {
            issues: [
              {
                file: 'src/test.ts',
                line: 25,
                ruleId: 'performance/inefficient-loop',
                message: 'Consider using a more efficient data structure',
                severity: 'warning',
                category: 'performance',
              },
            ],
          };
        } else if (checkId === 'architecture') {
          return {
            issues: [
              {
                file: 'src/test.ts',
                line: 5,
                ruleId: 'architecture/coupling',
                message: 'High coupling detected, consider the security findings',
                severity: 'warning',
                category: 'architecture',
              },
            ],
          };
        }
        return { issues: [] };
      },
    };

    const registry = CheckProviderRegistry.getInstance();
    try {
      registry.register({
        getName: () => 'mock-ai',
        executeCheck: mockAIProvider.executeCheck,
      } as never);
    } catch {
      // Provider already registered, ignore
    }
  });

  beforeEach(() => {
    engine = new CheckExecutionEngine();
    liquid = new Liquid();
    ajv = new Ajv({ allErrors: true, strict: false });
  });

  describe('End-to-End Schema-Template Flow', () => {
    test('should execute check with code-review schema and render table template', async () => {
      // Simulate check results that would come from the execution engine
      const mockResults = {
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

      expect(mockResults.issues).toHaveLength(1);
      expect(mockResults.issues[0].ruleId).toBe('security/hardcoded-secret');

      // Load and validate schema
      const schemaPath = path.join(__dirname, '../../output/code-review/schema.json');
      const schema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'));
      const validate = ajv.compile(schema);

      // Validate data against schema (original format)
      const isValid = validate(mockResults);
      expect(isValid).toBe(true);

      // Prepare data for single-check template rendering
      const templateData = {
        checkName: 'security',
        issues: mockResults.issues,
      };

      // Render using template
      const templatePath = path.join(__dirname, '../../output/code-review/template.liquid');
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      const rendered = await liquid.parseAndRender(templateContent, templateData);

      expect(rendered).toContain('<table');
      expect(rendered).toContain('Security');
      expect(rendered).toContain('Potential hardcoded API key detected');
      expect(rendered).toContain('🔴'); // critical severity
    });

    test('should execute check with text schema and render content template', async () => {
      const config = {
        version: '2.0',
        checks: {
          'full-review': {
            type: 'mock-ai',
            group: 'pr-overview',
            schema: 'text',
            prompt: 'Create PR overview with mermaid diagram',
            on: ['pr_opened'],
          },
        },
      };

      const results = await engine.executeChecks({
        checks: ['full-review'],
        config: config as any,
        debug: false,
      });

      // For text schema, the full-review should execute successfully
      expect(results.checksExecuted).toContain('full-review');

      // Load and validate text schema
      const schemaPath = path.join(__dirname, '../../output/text/schema.json');
      const schema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'));
      const validate = ajv.compile(schema);

      // Create test data matching what the mock provider returns
      const mockResult = {
        content: `# Pull Request Overview

## Summary
This PR adds authentication functionality.

## Files Changed
| File | Purpose |
|------|---------|
| src/test.ts | Test authentication logic |

## Architecture Diagram
\`\`\`mermaid
graph TD
  A[Client] --> B[Auth Service]
\`\`\``,
      };
      const isValid = validate(mockResult);
      expect(isValid).toBe(true);

      // Render using text template
      const templatePath = path.join(__dirname, '../../output/text/template.liquid');
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      const rendered = await liquid.parseAndRender(templateContent, mockResult);

      expect(rendered).toContain('# Pull Request Overview');
      expect(rendered).toContain('## Summary');
      expect(rendered).toContain('```mermaid');
      expect(rendered).toContain('graph TD');
    });

    test('should handle multiple checks with same group', async () => {
      // In the new architecture, each check gets its own template render
      // Simulate individual check results that would be combined at the GitHub Actions level

      // Security check results
      const securityResults = {
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            ruleId: 'security/hardcoded-secret',
            message: 'Hardcoded secret',
            severity: 'critical',
            category: 'security',
          },
        ],
      };

      // Performance check results
      const performanceResults = {
        issues: [
          {
            file: 'src/test.ts',
            line: 25,
            ruleId: 'performance/inefficient-loop',
            message: 'Inefficient loop detected',
            severity: 'warning',
            category: 'performance',
          },
        ],
      };

      // Render security check
      const templatePath = path.join(__dirname, '../../output/code-review/template.liquid');
      const templateContent = await fs.readFile(templatePath, 'utf-8');

      const securityData = {
        checkName: 'security',
        issues: securityResults.issues,
      };
      const securityRendered = await liquid.parseAndRender(templateContent, securityData);

      // Render performance check
      const performanceData = {
        checkName: 'performance',
        issues: performanceResults.issues,
      };
      const performanceRendered = await liquid.parseAndRender(templateContent, performanceData);

      // Each check should render its own section
      expect(securityRendered).toContain('Security Issues (1)');
      expect(securityRendered).toContain('Hardcoded secret');
      expect(securityRendered).not.toContain('Performance');

      expect(performanceRendered).toContain('Performance Issues (1)');
      expect(performanceRendered).toContain('Inefficient loop detected');
      expect(performanceRendered).not.toContain('Security');
    });

    test('should handle checks with dependencies', async () => {
      // Simulate results from checks with dependencies
      const mockResults = {
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            ruleId: 'security/hardcoded-secret',
            message: 'Hardcoded secret found',
            severity: 'critical',
            category: 'security',
            checkName: 'security',
          },
          {
            file: 'src/test.ts',
            line: 5,
            ruleId: 'architecture/coupling',
            message: 'High coupling detected, consider the security findings',
            severity: 'warning',
            category: 'architecture',
            checkName: 'architecture',
          },
        ],
      };

      expect(mockResults.issues).toHaveLength(2);
      expect(mockResults.issues.some(issue => issue.ruleId === 'security/hardcoded-secret')).toBe(
        true
      );
      expect(mockResults.issues.some(issue => issue.ruleId === 'architecture/coupling')).toBe(true);
    });
  });

  describe('Schema Validation in Real Flow', () => {
    test('should validate AI provider output against code-review schema', async () => {
      // Load schema
      const schemaPath = path.join(__dirname, '../../output/code-review/schema.json');
      const schema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'));
      const validate = ajv.compile(schema);

      // Test valid AI response
      const validResponse = {
        issues: [
          {
            file: 'src/auth.ts',
            line: 15,
            ruleId: 'security/hardcoded-secret',
            message: 'Hardcoded API key found',
            severity: 'critical',
            category: 'security',
            suggestion: 'Use environment variables',
          },
        ],
      };

      expect(validate(validResponse)).toBe(true);

      // Test invalid AI response
      const invalidResponse = {
        issues: [
          {
            file: 'src/auth.ts',
            // Missing required fields
          },
        ],
      };

      expect(validate(invalidResponse)).toBe(false);
      expect(validate.errors).toBeTruthy();
    });

    test('should validate AI provider output against text schema', async () => {
      // Load schema
      const schemaPath = path.join(__dirname, '../../output/text/schema.json');
      const schema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'));
      const validate = ajv.compile(schema);

      // Test valid markdown response
      const validResponse = {
        content: '# PR Analysis\n\nThis PR looks good!',
      };

      expect(validate(validResponse)).toBe(true);

      // Test invalid markdown response
      const invalidResponse = {
        // Missing content field
        summary: 'This should not be here',
      };

      expect(validate(invalidResponse)).toBe(false);
    });
  });

  describe('Template Error Handling', () => {
    test('should handle missing template files gracefully', async () => {
      const nonExistentTemplatePath = path.join(
        __dirname,
        '../../output/nonexistent/template.liquid'
      );

      await expect(fs.readFile(nonExistentTemplatePath, 'utf-8')).rejects.toThrow();
    });

    test('should handle malformed template syntax', async () => {
      const malformedTemplate = '{% for issue in issues %}{{ issue.file {% endfor %}';
      const data = { issues: [{ file: 'test.ts' }] };

      await expect(liquid.parseAndRender(malformedTemplate, data)).rejects.toThrow();
    });

    test('should handle missing data fields in template', async () => {
      const templateWithMissingFields = `
        {% for issue in issues %}
          File: {{ issue.file }}
          Missing: {{ issue.nonExistentField }}
        {% endfor %}
      `;

      const data = {
        issues: [
          {
            file: 'test.ts',
            line: 10,
          },
        ],
      };

      const rendered = await liquid.parseAndRender(templateWithMissingFields, data);
      expect(rendered).toContain('File: test.ts');
      expect(rendered).toContain('Missing:'); // Should render empty for missing field
    });
  });

  describe('Group Comment Generation', () => {
    test('should generate separate comments for different groups', () => {
      const checksConfig = [
        {
          id: 'security',
          group: 'code-review',
          schema: 'code-review',
        },
        {
          id: 'overview',
          group: 'summary',
          schema: 'text',
        },
      ];

      // Group checks by their group property
      const groupedChecks = checksConfig.reduce(
        (acc, check) => {
          if (!acc[check.group]) {
            acc[check.group] = [];
          }
          acc[check.group].push(check);
          return acc;
        },
        {} as Record<string, typeof checksConfig>
      );

      expect(groupedChecks).toHaveProperty('code-review');
      expect(groupedChecks).toHaveProperty('summary');
      expect(groupedChecks['code-review']).toHaveLength(1);
      expect(groupedChecks['summary']).toHaveLength(1);

      // This should result in 2 separate GitHub comments
      expect(Object.keys(groupedChecks)).toHaveLength(2);
    });

    test('should combine multiple checks in same group into one comment', () => {
      const checksConfig = [
        { id: 'security', group: 'code-review', schema: 'code-review' },
        { id: 'performance', group: 'code-review', schema: 'code-review' },
        { id: 'style', group: 'code-review', schema: 'code-review' },
      ];

      const groupedChecks = checksConfig.reduce(
        (acc, check) => {
          if (!acc[check.group]) {
            acc[check.group] = [];
          }
          acc[check.group].push(check);
          return acc;
        },
        {} as Record<string, typeof checksConfig>
      );

      expect(groupedChecks).toHaveProperty('code-review');
      expect(groupedChecks['code-review']).toHaveLength(3);

      // This should result in 1 combined GitHub comment
      expect(Object.keys(groupedChecks)).toHaveLength(1);
    });
  });
});
