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

describe('Mermaid Diagram Preservation', () => {
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

  describe('Plain Schema with Mermaid Diagrams', () => {
    test('should preserve mermaid diagrams from AI response to GitHub comment', async () => {
      // Mock AI response with Mermaid diagram
      const aiResponseWithMermaid = JSON.stringify({
        content: `# Pull Request Analysis

## Overview
This PR introduces authentication improvements with JWT tokens.

## Architecture Changes
\`\`\`mermaid
graph TD
    A[Client Request] --> B[Auth Middleware]
    B --> C[JWT Validation]
    C --> D[Protected Route]
    D --> E[Database Query]
    E --> F[Response]
\`\`\`

## Summary
The implementation follows security best practices and includes proper error handling.`,
      });

      // Mock ProbeAgent to return the response with Mermaid
      mockProbeAgent.answer.mockResolvedValue(aiResponseWithMermaid);

      // Create mock PR info
      const mockPrInfo: PRInfo = {
        number: 123,
        title: 'Add JWT authentication',
        author: 'developer',
        base: 'main',
        head: 'feature/auth',
        body: 'Mock PR description',
        totalAdditions: 50,
        totalDeletions: 10,
        files: [
          {
            filename: 'src/auth.ts',
            status: 'modified',
            additions: 30,
            deletions: 5,
            changes: 35,
            patch: '// mock patch content',
          },
        ],
        fullDiff: '// mock diff content',
        isIncremental: false,
      };

      // Execute AI review with plain schema
      const result = await aiService.executeReview(
        mockPrInfo,
        'Analyze this PR and create an overview with architecture diagram',
        'plain'
      );

      // Verify the AI response was parsed correctly
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toContain('```mermaid');
      expect(result.issues[0].message).toContain('graph TD');
      expect(result.issues[0].message).toContain('A[Client Request] --> B[Auth Middleware]');

      // Test template rendering (what goes to GitHub comment)
      const templatePath = path.join(__dirname, '../../output/plain/template.liquid');
      const templateContent = await fs.readFile(templatePath, 'utf-8');

      const templateData = {
        content: result.issues[0].message,
        checkName: 'full-review',
      };

      const renderedComment = await liquid.parseAndRender(templateContent, templateData);

      // Verify Mermaid diagram is preserved in final GitHub comment
      expect(renderedComment).toContain('```mermaid');
      expect(renderedComment).toContain('graph TD');
      expect(renderedComment).toContain('A[Client Request] --> B[Auth Middleware]');
      expect(renderedComment).toContain('B --> C[JWT Validation]');
      expect(renderedComment).toContain('```');

      // Verify no code block stripping occurred
      const mermaidBlockStart = renderedComment.indexOf('```mermaid');
      const mermaidBlockEnd = renderedComment.indexOf('```', mermaidBlockStart + 3);
      expect(mermaidBlockStart).toBeGreaterThan(-1);
      expect(mermaidBlockEnd).toBeGreaterThan(mermaidBlockStart);

      // Extract the full mermaid block content
      const mermaidBlock = renderedComment.substring(mermaidBlockStart, mermaidBlockEnd + 3);
      expect(mermaidBlock).toContain('graph TD');
      expect(mermaidBlock).toContain('A[Client Request]');
      expect(mermaidBlock).toContain('--> B[Auth Middleware]');
    });

    test('should handle multiple mermaid diagrams in AI response', async () => {
      const aiResponseWithMultipleMermaid = JSON.stringify({
        content: `# System Architecture

## Component Overview
\`\`\`mermaid
graph LR
    A[Frontend] --> B[API Gateway]
    B --> C[Auth Service]
    B --> D[Business Logic]
\`\`\`

## Database Schema
\`\`\`mermaid
erDiagram
    USER ||--o{ ORDER : places
    USER {
        string name
        string email
    }
    ORDER {
        int id
        string status
    }
\`\`\`

Both diagrams show the system architecture and data relationships.`,
      });

      mockProbeAgent.answer.mockResolvedValue(aiResponseWithMultipleMermaid);

      const mockPrInfo: PRInfo = {
        number: 124,
        title: 'System refactoring',
        author: 'architect',
        base: 'main',
        head: 'refactor/system',
        body: 'System architecture changes',
        totalAdditions: 100,
        totalDeletions: 50,
        files: [
          {
            filename: 'src/system.ts',
            status: 'modified',
            additions: 80,
            deletions: 30,
            changes: 110,
            patch: '// mock patch content',
          },
        ],
        fullDiff: '// mock diff content',
        isIncremental: false,
      };

      const result = await aiService.executeReview(
        mockPrInfo,
        'Analyze system architecture changes',
        'plain'
      );

      // Verify both Mermaid diagrams are preserved
      const content = result.issues[0].message;
      const mermaidBlocks = content.match(/```mermaid[\s\S]*?```/g);
      expect(mermaidBlocks).toHaveLength(2);

      expect(content).toContain('graph LR');
      expect(content).toContain('erDiagram');
      expect(content).toContain('A[Frontend] --> B[API Gateway]');
      expect(content).toContain('USER ||--o{ ORDER : places');
    });

    test('should preserve mermaid diagrams with complex syntax', async () => {
      const complexMermaidResponse = JSON.stringify({
        content: `# Flow Analysis

## Process Flow
\`\`\`mermaid
flowchart TB
    A["🔐 Authentication<br/>Check User"] --> B{Valid Token?}
    B -->|Yes| C["✅ Authorized<br/>Process Request"]
    B -->|No| D["❌ Unauthorized<br/>Return Error"]
    C --> E["📊 Log Activity"]
    D --> E
    E --> F["📤 Send Response"]
    
    style A fill:#e1f5fe
    style C fill:#e8f5e8
    style D fill:#ffebee
\`\`\`

The flow includes error handling and logging.`,
      });

      mockProbeAgent.answer.mockResolvedValue(complexMermaidResponse);

      const mockPrInfo: PRInfo = {
        number: 125,
        title: 'Add process flow',
        author: 'developer',
        base: 'main',
        head: 'feature/flow',
        body: 'Add process flow documentation',
        totalAdditions: 25,
        totalDeletions: 5,
        files: [
          {
            filename: 'src/flow.ts',
            status: 'added',
            additions: 25,
            deletions: 0,
            changes: 25,
            patch: '// mock patch content',
          },
        ],
        fullDiff: '// mock diff content',
        isIncremental: false,
      };

      const result = await aiService.executeReview(
        mockPrInfo,
        'Document the process flow',
        'plain'
      );

      const content = result.issues[0].message;

      // Verify complex Mermaid syntax is preserved
      expect(content).toContain('```mermaid');
      expect(content).toContain('flowchart TB');
      expect(content).toContain('🔐 Authentication<br/>Check User');
      expect(content).toContain('|Yes| C["✅ Authorized<br/>Process Request"]');
      expect(content).toContain('style A fill:#e1f5fe');
      expect(content).toContain('style C fill:#e8f5e8');
      expect(content).toContain('style D fill:#ffebee');

      // Ensure all special characters and formatting are preserved
      expect(content).toContain('A["🔐 Authentication<br/>Check User"]');
      expect(content).toContain('B{Valid Token?}');
      expect(content).toContain('-->|Yes|');
      expect(content).toContain('-->|No|');
    });
  });

  describe('Edge Cases', () => {
    test('should handle mermaid diagrams in non-plain schema (should not apply boundary detection)', async () => {
      const codeReviewWithMermaid = JSON.stringify({
        issues: [
          {
            file: 'README.md',
            line: 1,
            ruleId: 'documentation/architecture',
            message:
              'Consider adding an architecture diagram like:\n\n```mermaid\ngraph TD\n  A --> B\n```',
            severity: 'info',
            category: 'documentation',
          },
        ],
        suggestions: ['Add architecture documentation'],
      });

      mockProbeAgent.answer.mockResolvedValue(codeReviewWithMermaid);

      const mockPrInfo: PRInfo = {
        number: 126,
        title: 'Update docs',
        author: 'writer',
        base: 'main',
        head: 'docs/update',
        body: 'Documentation updates',
        totalAdditions: 15,
        totalDeletions: 2,
        files: [
          {
            filename: 'README.md',
            status: 'modified',
            additions: 15,
            deletions: 2,
            changes: 17,
            patch: '// mock patch content',
          },
        ],
        fullDiff: '// mock diff content',
        isIncremental: false,
      };

      // Test with code-review schema (not plain)
      const result = await aiService.executeReview(
        mockPrInfo,
        'Review documentation changes',
        'code-review'
      );

      // Verify Mermaid diagrams in issue messages are preserved
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toContain('```mermaid');
      expect(result.issues[0].message).toContain('graph TD');
      expect(result.issues[0].message).toContain('A --> B');
    });
  });
});
