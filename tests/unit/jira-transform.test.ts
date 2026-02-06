/**
 * Unit tests for Jira transform_js code
 * Tests the sandbox script that transforms raw Jira API responses
 */
import { createSecureSandbox, compileAndRun } from '../../src/utils/sandbox';

// Extract the transform_js code from jira-context.yaml (simplified version for testing)
const transformJsCode = `
  // Helper to safely get nested property (avoids sandbox && bug with array access)
  function safeGet(obj, path) {
    var parts = path.split('.');
    var current = obj;
    for (var i = 0; i < parts.length; i++) {
      if (current == null) return undefined;
      var part = parts[i];
      var bracketIdx = part.indexOf('[');
      if (bracketIdx !== -1) {
        var prop = part.substring(0, bracketIdx);
        var idx = parseInt(part.substring(bracketIdx + 1, part.length - 1), 10);
        if (prop) {
          current = current[prop];
          if (current == null) return undefined;
        }
        if (!Array.isArray(current)) return undefined;
        current = current[idx];
      } else {
        current = current[part];
      }
    }
    return current;
  }

  if (!output || typeof output !== 'object') {
    return { data: [] };
  }

  var response = output;
  var rawIssues = response.issues;

  if (!rawIssues || !Array.isArray(rawIssues)) {
    return { data: [] };
  }

  var issues = [];

  for (var idx = 0; idx < rawIssues.length; idx++) {
    var issue = rawIssues[idx];
    if (issue) {
      var fields = issue.fields || {};

      // Extract comments using safeGet
      var comments = [];
      var commentObj = fields.comment || {};
      var commentList = commentObj.comments;
      if (commentList && Array.isArray(commentList)) {
        var lastFive = commentList.slice(-5);
        for (var j = 0; j < lastFive.length; j++) {
          var c = lastFive[j];
          if (c) {
            var author = c.author || {};
            var authorName = author.displayName || author.name || "";
            var bodyContent = safeGet(c, 'body.content[0].content[0]');
            var bodyText = (bodyContent ? bodyContent.text : null) || (typeof c.body === "string" ? c.body : "");
            comments.push({
              author: authorName,
              created: c.created || "",
              body: bodyText
            });
          }
        }
      }

      // Extract description text using safeGet
      var descObj = fields.description || {};
      var descContent = safeGet(descObj, 'content[0].content[0]');
      var descText = (descContent ? descContent.text : null) || (typeof fields.description === "string" ? fields.description : "");

      var statusObj = fields.status || {};
      issues.push({
        key: issue.key,
        summary: fields.summary || "",
        description: descText,
        status: statusObj.name || "",
        comments: comments
      });
    }
  }

  return { data: issues };
`;

describe('Jira transform_js', () => {
  it('should handle issues with Atlassian Document Format (ADF) description', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [
        {
          key: 'TT-123',
          fields: {
            summary: 'Test Issue',
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'This is the description text',
                    },
                  ],
                },
              ],
            },
            status: { name: 'Open' },
            comment: { comments: [] },
          },
        },
      ],
    };

    const result = compileAndRun<{ data: Array<{ key: string; description: string }> }>(
      sandbox,
      transformJsCode,
      { output: rawJiraResponse }
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].key).toBe('TT-123');
    expect(result.data[0].description).toBe('This is the description text');
  });

  it('should handle issues with undefined description content', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [
        {
          key: 'TT-456',
          fields: {
            summary: 'Issue with no description',
            description: {
              type: 'doc',
              content: undefined, // This would cause the && bug
            },
            status: { name: 'Closed' },
            comment: { comments: [] },
          },
        },
      ],
    };

    const result = compileAndRun<{ data: Array<{ key: string; description: string }> }>(
      sandbox,
      transformJsCode,
      { output: rawJiraResponse }
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].key).toBe('TT-456');
    expect(result.data[0].description).toBe('');
  });

  it('should handle issues with null description', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [
        {
          key: 'TT-789',
          fields: {
            summary: 'Issue with null description',
            description: null,
            status: { name: 'In Progress' },
            comment: { comments: [] },
          },
        },
      ],
    };

    const result = compileAndRun<{ data: Array<{ key: string; description: string }> }>(
      sandbox,
      transformJsCode,
      { output: rawJiraResponse }
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].key).toBe('TT-789');
    expect(result.data[0].description).toBe('');
  });

  it('should handle comments with ADF body format', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [
        {
          key: 'TT-111',
          fields: {
            summary: 'Issue with comments',
            description: null,
            status: { name: 'Open' },
            comment: {
              comments: [
                {
                  author: { displayName: 'John Doe' },
                  created: '2025-01-01T10:00:00.000Z',
                  body: {
                    type: 'doc',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'This is a comment' }],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    };

    const result = compileAndRun<{ data: Array<{ comments: Array<{ body: string }> }> }>(
      sandbox,
      transformJsCode,
      { output: rawJiraResponse }
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].comments).toHaveLength(1);
    expect(result.data[0].comments[0].body).toBe('This is a comment');
  });

  it('should handle comments with undefined body content', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [
        {
          key: 'TT-222',
          fields: {
            summary: 'Issue with malformed comment',
            description: null,
            status: { name: 'Open' },
            comment: {
              comments: [
                {
                  author: { displayName: 'Jane Doe' },
                  created: '2025-01-02T10:00:00.000Z',
                  body: {
                    type: 'doc',
                    content: undefined, // This would cause the && bug
                  },
                },
              ],
            },
          },
        },
      ],
    };

    // This should NOT throw "Cannot get property '0' of undefined"
    const result = compileAndRun<{ data: Array<{ comments: Array<{ body: string }> }> }>(
      sandbox,
      transformJsCode,
      { output: rawJiraResponse }
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].comments).toHaveLength(1);
    expect(result.data[0].comments[0].body).toBe('');
  });

  it('should handle string description (legacy format)', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [
        {
          key: 'TT-333',
          fields: {
            summary: 'Issue with string description',
            description: 'Plain text description',
            status: { name: 'Done' },
            comment: { comments: [] },
          },
        },
      ],
    };

    const result = compileAndRun<{ data: Array<{ description: string }> }>(
      sandbox,
      transformJsCode,
      { output: rawJiraResponse }
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].description).toBe('Plain text description');
  });

  it('should handle string comment body (legacy format)', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [
        {
          key: 'TT-444',
          fields: {
            summary: 'Issue with string comment',
            description: null,
            status: { name: 'Open' },
            comment: {
              comments: [
                {
                  author: { name: 'user123' },
                  created: '2025-01-03T10:00:00.000Z',
                  body: 'Plain text comment',
                },
              ],
            },
          },
        },
      ],
    };

    const result = compileAndRun<{
      data: Array<{ comments: Array<{ body: string; author: string }> }>;
    }>(sandbox, transformJsCode, { output: rawJiraResponse });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].comments[0].body).toBe('Plain text comment');
    expect(result.data[0].comments[0].author).toBe('user123');
  });

  it('should handle empty issues array', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {
      issues: [],
    };

    const result = compileAndRun<{ data: unknown[] }>(sandbox, transformJsCode, {
      output: rawJiraResponse,
    });

    expect(result.data).toHaveLength(0);
  });

  it('should handle missing issues array', () => {
    const sandbox = createSecureSandbox();
    const rawJiraResponse = {};

    const result = compileAndRun<{ data: unknown[] }>(sandbox, transformJsCode, {
      output: rawJiraResponse,
    });

    expect(result.data).toHaveLength(0);
  });
});
