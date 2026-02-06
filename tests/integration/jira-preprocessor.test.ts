/**
 * Integration tests for JIRA link preprocessor pattern
 * Tests the ability to use custom tools as preprocessors to enrich AI prompts
 */

import { CustomToolExecutor } from '../../src/providers/custom-tool-executor';
import type { CustomToolDefinition } from '../../src/types/config';

describe('JIRA Link Preprocessor Pattern', () => {
  describe('Custom Tool as Preprocessor', () => {
    it('should fetch and transform JIRA issue to XML', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'fetch-jira-mock': {
          name: 'fetch-jira-mock',
          description: 'Mock JIRA fetcher for testing',
          inputSchema: {
            type: 'object',
            properties: {
              issue_key: { type: 'string' },
            },
            required: ['issue_key'],
          },
          exec: 'echo \'{"key":"PROJ-123","fields":{"summary":"Test Issue","description":"Test description","status":{"name":"In Progress"},"priority":{"name":"High"},"assignee":{"displayName":"John Doe"},"reporter":{"displayName":"Jane Smith"},"created":"2024-01-01T00:00:00Z","updated":"2024-01-02T00:00:00Z"}}\'',
          parseJson: true,
          timeout: 5000,
          transform_js: `
            const issue = output;
            const fields = issue.fields || {};
            const escape = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return \`<jira-issue>
  <key>\${escape(issue.key)}</key>
  <summary>\${escape(fields.summary)}</summary>
  <description>\${escape(fields.description || 'N/A')}</description>
  <status>\${escape(fields.status?.name)}</status>
  <priority>\${escape(fields.priority?.name || 'N/A')}</priority>
  <assignee>\${escape(fields.assignee?.displayName || 'Unassigned')}</assignee>
  <reporter>\${escape(fields.reporter?.displayName)}</reporter>
  <created>\${escape(fields.created)}</created>
  <updated>\${escape(fields.updated)}</updated>
</jira-issue>\`;
          `,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('fetch-jira-mock', { issue_key: 'PROJ-123' });

      expect(result).toContain('<jira-issue>');
      expect(result).toContain('<key>PROJ-123</key>');
      expect(result).toContain('<summary>Test Issue</summary>');
      expect(result).toContain('<status>In Progress</status>');
      expect(result).toContain('<priority>High</priority>');
      expect(result).toContain('<assignee>John Doe</assignee>');
      expect(result).toContain('</jira-issue>');
    });

    it('should extract JIRA issue keys from text', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'extract-jira-keys': {
          name: 'extract-jira-keys',
          exec: 'echo "{{ args.text }}" | grep -oE \'[A-Z]+-[0-9]+\' | sort -u',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
      };

      const executor = new CustomToolExecutor(tools);
      const text = `
        Fix for PROJ-123 and PROJ-456
        See also: https://company.atlassian.net/browse/PROJ-789
        Related to PROJ-123 (duplicate)
      `;

      const result = await executor.execute('extract-jira-keys', { text });

      // Should extract unique keys
      expect(result).toContain('PROJ-123');
      expect(result).toContain('PROJ-456');
      expect(result).toContain('PROJ-789');
    });

    it('should handle missing JIRA data gracefully', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'fetch-jira-error': {
          name: 'fetch-jira-error',
          exec: "echo '{}'",
          parseJson: true,
          transform_js: `
            if (!output || !output.key) {
              return '<jira-error>Failed to fetch JIRA issue</jira-error>';
            }
            return '<jira-issue>...</jira-issue>';
          `,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('fetch-jira-error', {});

      expect(result).toBe('<jira-error>Failed to fetch JIRA issue</jira-error>');
    });

    it('should escape XML special characters', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'fetch-jira-escape': {
          name: 'fetch-jira-escape',
          exec: 'echo \'{"key":"PROJ-999","fields":{"summary":"Test <script>alert(\\"XSS\\")</script> & more","description":"Contains & < > \\""}}\'',
          parseJson: true,
          transform_js: `
            const escape = (str) => String(str || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');

            return \`<summary>\${escape(output.fields.summary)}</summary>
<description>\${escape(output.fields.description)}</description>\`;
          `,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('fetch-jira-escape', {});

      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&quot;XSS&quot;');
      expect(result).toContain('&amp;');
      expect(result).not.toContain('<script>');
    });
  });

  describe('Template Context Enrichment', () => {
    it('should simulate preprocessor -> AI check flow', async () => {
      // Simulate Step 1: Preprocessor fetches JIRA data
      const preprocessorTools: Record<string, CustomToolDefinition> = {
        'fetch-jira': {
          name: 'fetch-jira',
          exec: 'echo \'{"key":"PROJ-123","fields":{"summary":"Add login feature"}}\'',
          parseJson: true,
          transform_js:
            'return `<jira-issue><key>${output.key}</key><summary>${output.fields.summary}</summary></jira-issue>`;',
        },
      };

      const executor = new CustomToolExecutor(preprocessorTools);
      const jiraContext = await executor.execute('fetch-jira', {});

      // Simulate Step 2: Template context includes preprocessor output
      const templateContext = {
        pr: {
          title: 'Implement login',
          description: 'Fixes PROJ-123',
        },
        outputs: {
          'enrich-jira-context': jiraContext,
        },
      };

      // Verify the pattern works
      expect(jiraContext).toContain('<jira-issue>');
      expect(templateContext.outputs['enrich-jira-context']).toBe(jiraContext);

      // In real implementation, prompt would be rendered by Liquid like:
      // const promptTemplate = `JIRA Context: {{ outputs["enrich-jira-context"] }}\nPR Title: {{ pr.title }}`;
      // Expected output would contain both the JIRA XML and PR title
    });
  });

  describe('Batch JIRA Fetching', () => {
    it('should fetch multiple JIRA issues and combine into XML', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'fetch-jira-batch': {
          name: 'fetch-jira-batch',
          exec: 'echo \'[{"key":"PROJ-1","fields":{"summary":"Issue 1","status":{"name":"Done"}}},{"key":"PROJ-2","fields":{"summary":"Issue 2","status":{"name":"In Progress"}}}]\'',
          parseJson: true,
          transform_js: `
            if (!Array.isArray(output)) {
              return '<jira-issues><error>Invalid response</error></jira-issues>';
            }

            const escape = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const issuesXml = output.map(issue => {
              const f = issue.fields || {};
              return \`  <issue>
    <key>\${escape(issue.key)}</key>
    <summary>\${escape(f.summary)}</summary>
    <status>\${escape(f.status?.name)}</status>
  </issue>\`;
            }).join('\\n');

            return \`<jira-issues>\\n\${issuesXml}\\n</jira-issues>\`;
          `,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('fetch-jira-batch', {});

      expect(result).toContain('<jira-issues>');
      expect(result).toContain('<issue>');
      expect(result).toContain('<key>PROJ-1</key>');
      expect(result).toContain('<summary>Issue 1</summary>');
      expect(result).toContain('<status>Done</status>');
      expect(result).toContain('<key>PROJ-2</key>');
      expect(result).toContain('<summary>Issue 2</summary>');
      expect(result).toContain('</jira-issues>');
    });
  });

  describe('Error Handling', () => {
    it('should handle tool execution timeout', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'slow-tool': {
          name: 'slow-tool',
          exec: 'sleep 10',
          timeout: 100, // 100ms timeout
        },
      };

      const executor = new CustomToolExecutor(tools);

      await expect(executor.execute('slow-tool', {})).rejects.toThrow();
    });

    it('should validate input schema', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'strict-tool': {
          name: 'strict-tool',
          exec: 'echo "{{ args.required_field }}"',
          inputSchema: {
            type: 'object',
            properties: {
              required_field: { type: 'string' },
            },
            required: ['required_field'],
          },
        },
      };

      const executor = new CustomToolExecutor(tools);

      // Should fail validation
      await expect(executor.execute('strict-tool', {})).rejects.toThrow(/required_field/);

      // Should pass validation
      const result = await executor.execute('strict-tool', { required_field: 'test' });
      expect(result).toContain('test');
    });
  });
});
