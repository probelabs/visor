/* eslint-disable @typescript-eslint/no-explicit-any */
import { AIReviewService } from '../../src/ai-review-service';
import { PRInfo } from '../../src/pr-analyzer';
import { Liquid } from 'liquidjs';
import * as path from 'path';
import * as fs from 'fs/promises';

// Mock ProbeAgent to return specific responses
jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn().mockImplementation(() => ({
    answer: jest.fn(),
  })),
}));

describe('Mermaid Production Scenario - Exact Replication', () => {
  let aiService: AIReviewService;
  let mockProbeAgent: any;
  let liquid: Liquid;

  beforeEach(() => {
    // Set up ProbeAgent mock
    const { ProbeAgent } = require('@probelabs/probe');
    mockProbeAgent = {
      answer: jest.fn(),
    };
    (ProbeAgent as jest.Mock).mockImplementation(() => mockProbeAgent);

    // Set up AI service with Google provider and mock key to trigger ProbeAgent path
    process.env.GOOGLE_API_KEY = 'mock-key';
    aiService = new AIReviewService({
      debug: false,
    });

    // Set up Liquid template engine
    liquid = new Liquid();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.GOOGLE_API_KEY;
  });

  test('should replicate exact production scenario - ProbeAgent returns JSON with Mermaid in markdown format', async () => {
    // This is EXACTLY what ProbeAgent should return based on the production logs
    // ProbeAgent returns a JSON-encoded string containing another JSON object
    // Updated to use issues array instead of content field since plain schema was removed
    // Put the mermaid content as an issue so it gets rendered by the template
    const productionLikeResponse = JSON.stringify({
      issues: [
        {
          file: 'PR_OVERVIEW',
          line: 1,
          ruleId: 'full-review/overview',
          message: `## 📋 Pull Request Overview

### 1. Summary

This pull request represents a significant architectural migration, replacing the \`probe-chat\` CLI tool with the \`@probelabs/probe\` agent SDK for handling AI-based code reviews.

### 2. Files Changed

| File | Lines Changed | Purpose/Component |
|------|---------------|------------------|
| \`src/ai-review-service.ts\` | +196/-262 | **Core Change**: Replaced child_process logic with ProbeAgent SDK |

### 3. Architecture Impact

The primary architectural impact is the decoupling from an external CLI tool in favor of a direct SDK integration.

\`\`\`mermaid
graph TD
    subgraph Before
        A[AIReviewService] -- spawns process --> B[probe-chat CLI];
        B -- calls --> C[AI Provider API];
        C -- returns raw JSON --> B;
        B -- returns wrapped JSON --> A;
        A -- parses & validates schema --> D[Review Result];
    end

    subgraph After
        E[AIReviewService] -- directly calls --> F[ProbeAgent SDK];
        F -- handles schema & API call --> G[AI Provider API];
        G -- returns JSON --> F;
        F -- validates schema & returns clean JSON --> E;
        E -- processes --> H[Review Result];
    end

    style B fill:#f9f,stroke:#333,stroke-width:2px
    style F fill:#9cf,stroke:#333,stroke-width:2px
\`\`\`

The new approach reduces complexity and improves error handling.`,
          severity: 'info',
          category: 'documentation',
        },
      ],
      suggestions: [],
    });

    // Mock ProbeAgent to return the response
    mockProbeAgent.answer.mockResolvedValue(productionLikeResponse);

    // Create mock PR info (similar to production)
    const mockPrInfo: PRInfo = {
      number: 8,
      title: 'feat: migrate from probe-chat to @probelabs/probe agent',
      author: 'developer',
      base: 'main',
      head: 'feature/probe-agent',
      body: 'Migration to ProbeAgent SDK',
      totalAdditions: 196,
      totalDeletions: 262,
      files: [
        {
          filename: 'src/ai-review-service.ts',
          status: 'modified',
          additions: 196,
          deletions: 262,
          changes: 458,
          patch: '// mock patch content',
        },
      ],
      fullDiff: '// mock diff content',
      isIncremental: false,
    };

    // Execute AI review with schema to enable JSON parsing
    const result = await aiService.executeReview(
      mockPrInfo,
      'Create a comprehensive pull request overview with architecture diagram',
      'code-review'
    );

    // Verify the AI response was parsed correctly
    expect(result.issues).toHaveLength(1);
    expect(result.suggestions).toHaveLength(0);
    const content = result.issues![0].message;

    // THE KEY TEST: Verify Mermaid blocks are preserved with proper formatting
    console.log('=== PARSED CONTENT ===');
    console.log(content);
    console.log('=== END PARSED CONTENT ===');

    // Check that the content contains properly formatted Mermaid blocks
    expect(content).toContain('```mermaid');
    expect(content).toContain('graph TD');
    expect(content).toContain('```');

    // Count the backticks to ensure they're all there
    const backtickMatches = content.match(/```/g);
    expect(backtickMatches).toBeDefined();
    expect(backtickMatches!.length).toBeGreaterThanOrEqual(2); // At least opening and closing

    // Verify the exact Mermaid block format
    const mermaidBlockRegex = /```mermaid\n[\s\S]*?\n```/;
    expect(content).toMatch(mermaidBlockRegex);

    // Test template rendering (what goes to GitHub comment)
    // Since plain schema was removed, use code-review template
    const templatePath = path.join(__dirname, '../../output/code-review/template.liquid');
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    const templateData = {
      issues: result.issues, // Mermaid content is in issues[0].message
      suggestions: result.suggestions,
      checkName: 'full-review',
    };

    const renderedComment = await liquid.parseAndRender(templateContent, templateData);

    console.log('=== RENDERED COMMENT ===');
    console.log(renderedComment);
    console.log('=== END RENDERED COMMENT ===');

    // Verify Mermaid diagram is preserved in final rendered comment
    expect(renderedComment).toContain('```mermaid');
    expect(renderedComment).toContain('graph TD');
    expect(renderedComment).toContain('subgraph Before');
    expect(renderedComment).toContain('subgraph After');
    expect(renderedComment).toContain('```');

    // Ensure no corruption or stripping occurred
    expect(renderedComment).toMatch(mermaidBlockRegex);
  });

  test('should handle when ProbeAgent returns raw response without JSON wrapper', async () => {
    // Test the fallback case where ProbeAgent might return raw content
    const rawResponse = `## 📋 Pull Request Overview

### Architecture

\`\`\`mermaid
graph LR
    A[Frontend] --> B[API]
    B --> C[Database]
\`\`\`

This shows the architecture.`;

    mockProbeAgent.answer.mockResolvedValue(rawResponse);

    const mockPrInfo: PRInfo = {
      number: 9,
      title: 'Test PR',
      author: 'tester',
      base: 'main',
      head: 'test',
      body: 'Test',
      totalAdditions: 10,
      totalDeletions: 5,
      files: [
        {
          filename: 'test.ts',
          status: 'modified',
          additions: 10,
          deletions: 5,
          changes: 15,
          patch: '// test',
        },
      ],
      fullDiff: '// test diff',
      isIncremental: false,
    };

    const result = await aiService.executeReview(mockPrInfo, 'Test prompt');

    // When raw response is given, it should be put in suggestions since it can't be parsed as JSON
    expect(result.issues).toHaveLength(0);
    expect(result.suggestions).toHaveLength(1);
    const content = result.suggestions![0];

    // Even with fallback, Mermaid blocks should be preserved
    expect(content).toContain('```mermaid');
    expect(content).toContain('graph LR');
    expect(content).toContain('```');
  });

  test('should detect if backticks are being escaped or corrupted', async () => {
    // Test various edge cases with backticks
    const responseWithVariousBackticks = JSON.stringify({
      issues: [
        {
          file: 'TEST_BACKTICKS',
          line: 1,
          ruleId: 'test/backticks',
          message: `# Test Content

Regular code block:
\`\`\`javascript
const test = true;
\`\`\`

Inline code: \`example\`

Mermaid diagram:
\`\`\`mermaid
graph TD
    A["Node with \`backticks\`"] --> B[Normal Node]
\`\`\`

Triple backticks in text: \\\`\\\`\\\` should be escaped`,
          severity: 'info',
          category: 'documentation',
        },
      ],
      suggestions: [],
    });

    mockProbeAgent.answer.mockResolvedValue(responseWithVariousBackticks);

    const mockPrInfo: PRInfo = {
      number: 10,
      title: 'Backtick test',
      author: 'tester',
      base: 'main',
      head: 'test',
      body: 'Testing backticks',
      totalAdditions: 5,
      totalDeletions: 0,
      files: [
        {
          filename: 'test.md',
          status: 'added',
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: '+ test',
        },
      ],
      fullDiff: '+ test',
      isIncremental: false,
    };

    const result = await aiService.executeReview(mockPrInfo, 'Test backticks', 'code-review');

    expect(result.issues).toHaveLength(1);
    const content = result.issues![0].message;

    // Verify all different types of backticks are preserved
    expect(content).toContain('```javascript');
    expect(content).toContain('```mermaid');
    expect(content).toContain('`example`'); // Inline code
    expect(content).toContain('Node with `backticks`'); // Backticks within Mermaid

    // Count all code blocks
    const codeBlockMatches = content.match(/```/g);
    expect(codeBlockMatches).toBeDefined();
    expect(codeBlockMatches!.length).toBeGreaterThanOrEqual(4); // At least 2 for JS, 2 for Mermaid
  });
});
