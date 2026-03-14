import { McpCheckProvider } from '../../src/providers/mcp-check-provider';

/**
 * Tests for MCP issue extraction logic.
 *
 * These tests target extractIssuesFromOutput / normalizeIssue — the code that
 * decides whether an MCP step's raw output contains "issues" (lint warnings,
 * errors, etc.) or is just a regular API response that should be passed
 * through as step output.
 *
 * Background: Slack's chat_postMessage returns
 *   { ok: true, message: { text: "...", ts: "...", ... }, ... }
 * The `message` field is an object, not a string.  A previous bug coerced it
 * to "[object Object]" and treated the whole response as an issue, which
 * caused result.success to be false even though the API call succeeded.
 */
describe('MCP issue extraction', () => {
  let provider: any; // cast to `any` to access private methods

  beforeEach(() => {
    provider = new McpCheckProvider();
  });

  // ── Slack-style responses should NOT be treated as issues ──────────────

  describe('Slack API responses pass through as output', () => {
    it('chat_postMessage response (has object `message` field)', () => {
      const slackResponse = {
        ok: true,
        channel: 'D09SZABNLG3',
        ts: '1773319800.691789',
        message: {
          user: 'U09T5KRLMPU',
          type: 'message',
          ts: '1773319800.691789',
          bot_id: 'B09T96XYZ',
          text: 'Hello from Oel',
        },
      };

      const result = provider.extractIssuesFromOutput(slackResponse);
      expect(result).toBeNull();
    });

    it('conversations_open response', () => {
      const response = {
        ok: true,
        no_op: true,
        already_open: true,
        channel: { id: 'D09SZABNLG3' },
      };

      const result = provider.extractIssuesFromOutput(response);
      expect(result).toBeNull();
    });

    it('users_lookupByEmail response', () => {
      const response = {
        ok: true,
        user: {
          id: 'U3P2L4XNE',
          real_name: 'Leo',
          name: 'leo',
        },
      };

      const result = provider.extractIssuesFromOutput(response);
      expect(result).toBeNull();
    });
  });

  // ── Generic API responses with common field names ─────────────────────

  describe('API responses with common field names pass through', () => {
    it('response with `text` field as non-string (array)', () => {
      const response = {
        ok: true,
        text: ['line1', 'line2'],
      };

      const result = provider.extractIssuesFromOutput(response);
      expect(result).toBeNull();
    });

    it('response with `message` field as number', () => {
      const response = { message: 42, status: 'ok' };

      const result = provider.extractIssuesFromOutput(response);
      expect(result).toBeNull();
    });

    it('response with `description` as nested object', () => {
      const response = {
        id: 'item-1',
        description: { en: 'English desc', fr: 'French desc' },
      };

      const result = provider.extractIssuesFromOutput(response);
      expect(result).toBeNull();
    });

    it('HTTP success response with status field', () => {
      const response = {
        status: 200,
        data: { items: [1, 2, 3] },
      };

      const result = provider.extractIssuesFromOutput(response);
      expect(result).toBeNull();
    });
  });

  // ── Actual issues SHOULD be detected ──────────────────────────────────

  describe('real issues are still detected', () => {
    it('single issue with string message', () => {
      const issue = {
        message: 'Unused variable foo',
        file: 'src/main.ts',
        line: 42,
        severity: 'warning',
      };

      const result = provider.extractIssuesFromOutput(issue);
      expect(result).not.toBeNull();
      expect(result!.issues).toHaveLength(1);
      expect(result!.issues[0].message).toBe('Unused variable foo');
      expect(result!.issues[0].file).toBe('src/main.ts');
      expect(result!.issues[0].line).toBe(42);
      expect(result!.issues[0].severity).toBe('warning');
    });

    it('single issue using `text` field as string', () => {
      const issue = {
        text: 'Missing return statement',
        severity: 'error',
      };

      const result = provider.extractIssuesFromOutput(issue);
      expect(result).not.toBeNull();
      expect(result!.issues[0].message).toBe('Missing return statement');
    });

    it('array of issues', () => {
      const issues = [
        { message: 'Issue 1', file: 'a.ts', line: 1 },
        { message: 'Issue 2', file: 'b.ts', line: 2 },
      ];

      const result = provider.extractIssuesFromOutput(issues);
      expect(result).not.toBeNull();
      expect(result!.issues).toHaveLength(2);
    });

    it('object with issues array property', () => {
      const output = {
        issues: [{ message: 'Found a bug', file: 'main.go', line: 10 }],
        summary: 'analysis complete',
      };

      const result = provider.extractIssuesFromOutput(output);
      expect(result).not.toBeNull();
      expect(result!.issues).toHaveLength(1);
      expect(result!.issues[0].message).toBe('Found a bug');
      // remaining output should preserve non-issue fields
      expect(result!.remainingOutput).toEqual({ summary: 'analysis complete' });
    });

    it('JSON string containing an issue', () => {
      const jsonString = JSON.stringify({
        message: 'Parse error at line 5',
        severity: 'error',
        file: 'config.yaml',
        line: 5,
      });

      const result = provider.extractIssuesFromOutput(jsonString);
      expect(result).not.toBeNull();
      expect(result!.issues[0].message).toBe('Parse error at line 5');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('null returns null', () => {
      expect(provider.extractIssuesFromOutput(null)).toBeNull();
    });

    it('undefined returns null', () => {
      expect(provider.extractIssuesFromOutput(undefined)).toBeNull();
    });

    it('empty object returns null', () => {
      expect(provider.extractIssuesFromOutput({})).toBeNull();
    });

    it('plain string (non-JSON) returns null', () => {
      expect(provider.extractIssuesFromOutput('just a string')).toBeNull();
    });

    it('object with empty string message returns null', () => {
      const obj = { message: '', severity: 'error' };
      expect(provider.extractIssuesFromOutput(obj)).toBeNull();
    });

    it('object with whitespace-only message returns null', () => {
      const obj = { message: '   ', severity: 'warning' };
      expect(provider.extractIssuesFromOutput(obj)).toBeNull();
    });

    it('boolean message field returns null', () => {
      const obj = { message: true };
      expect(provider.extractIssuesFromOutput(obj)).toBeNull();
    });
  });
});
