/* eslint-disable @typescript-eslint/no-explicit-any */
import { AIReviewService } from '../../src/ai-review-service';
import { PRInfo } from '../../src/pr-analyzer';

// Mock ProbeAgent to return specific responses
jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    answer: jest.fn(),
  })),
}));

describe('Mermaid Backtick Escaping Issues', () => {
  let aiService: AIReviewService;
  let mockProbeAgent: any;

  beforeEach(() => {
    // Set up ProbeAgent mock
    const { ProbeAgent } = require('@probelabs/probe');
    mockProbeAgent = {
      initialize: jest.fn().mockResolvedValue(undefined),
      answer: jest.fn(),
    };
    (ProbeAgent as jest.Mock).mockImplementation(() => mockProbeAgent);

    // Set up AI service with Google provider and mock key to trigger ProbeAgent path
    process.env.GOOGLE_API_KEY = 'mock-key';
    aiService = new AIReviewService({
      debug: false,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.GOOGLE_API_KEY;
  });

  test.skip('should handle escaped backticks in ProbeAgent response', async () => {
    // Test if ProbeAgent is returning escaped backticks
    const responseWithEscapedBackticks = JSON.stringify({
      content: `## Overview

The diagram below shows the architecture:

\\\`\\\`\\\`mermaid
graph TD
    A[Service] --> B[Database]
\\\`\\\`\\\`

This is the system design.`,
    });

    mockProbeAgent.answer.mockResolvedValue(responseWithEscapedBackticks);

    const mockPrInfo: PRInfo = {
      number: 1,
      title: 'Test',
      author: 'test',
      base: 'main',
      head: 'test',
      body: 'test',
      totalAdditions: 1,
      totalDeletions: 0,
      files: [
        {
          filename: 'test.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '+ test',
        },
      ],
      fullDiff: '+ test',
      isIncremental: false,
    };

    const result = await aiService.executeReview(mockPrInfo, 'Test', 'plain');

    const content = result.issues![0].message;
    console.log('Content with escaped backticks:', content);

    // Check if backticks are still escaped (they shouldn't be)
    expect(content).not.toContain('\\`\\`\\`');
    // Should contain proper backticks
    expect(content).toContain('```mermaid');
  });

  test.skip('should detect if ProbeAgent double-encodes JSON', async () => {
    // Test if ProbeAgent is double-encoding the response
    // This would look like: "{\\"content\\": \\"text\\"}"
    const doubleEncodedResponse = JSON.stringify(
      JSON.stringify({
        content: `## Overview

\`\`\`mermaid
graph TD
    A[Service] --> B[Database]
\`\`\`

This is the system design.`,
      })
    );

    console.log('Double encoded response:', doubleEncodedResponse);

    mockProbeAgent.answer.mockResolvedValue(doubleEncodedResponse);

    const mockPrInfo: PRInfo = {
      number: 2,
      title: 'Test',
      author: 'test',
      base: 'main',
      head: 'test',
      body: 'test',
      totalAdditions: 1,
      totalDeletions: 0,
      files: [
        {
          filename: 'test.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '+ test',
        },
      ],
      fullDiff: '+ test',
      isIncremental: false,
    };

    const result = await aiService.executeReview(mockPrInfo, 'Test', 'plain');

    const content = result.issues![0].message;
    console.log('Content after double-decoding:', content);

    // Check if content is properly decoded
    expect(content).toContain('```mermaid');
    expect(content).toContain('graph TD');
  });

  test.skip('should handle when ProbeAgent returns content without backticks at all', async () => {
    // What if ProbeAgent strips backticks?
    const responseWithoutBackticks = JSON.stringify({
      content: `## Overview

The diagram below shows the architecture:

mermaid
graph TD
    A[Service] --> B[Database]

This is the system design.`,
    });

    mockProbeAgent.answer.mockResolvedValue(responseWithoutBackticks);

    const mockPrInfo: PRInfo = {
      number: 3,
      title: 'Test',
      author: 'test',
      base: 'main',
      head: 'test',
      body: 'test',
      totalAdditions: 1,
      totalDeletions: 0,
      files: [
        {
          filename: 'test.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '+ test',
        },
      ],
      fullDiff: '+ test',
      isIncremental: false,
    };

    const result = await aiService.executeReview(mockPrInfo, 'Test', 'plain');

    const content = result.issues![0].message;
    console.log('Content without backticks:', content);

    // This would fail as expected - no backticks
    expect(content).not.toContain('```mermaid');
    // Would just contain the raw text
    expect(content).toContain('mermaid');
    expect(content).toContain('graph TD');
  });

  test.skip('CRITICAL: Test what production actually sees', async () => {
    // Based on the GitHub comment, it seems like ProbeAgent returns proper JSON
    // but the backticks are missing in the final output

    // This is what we expect ProbeAgent returns (based on logs)
    const productionResponse = JSON.stringify({
      content: `## 📋 Pull Request Overview

### 3. Architecture Impact

The primary architectural impact is the decoupling from an external CLI tool in favor of a direct SDK integration.

\`\`\`mermaid
graph TD
    subgraph Before
        A[AIReviewService] -- spawns process --> B[probe-chat CLI];
    end
    subgraph After
        E[AIReviewService] -- directly calls --> F[ProbeAgent SDK];
    end
\`\`\`

The new approach reduces complexity.`,
    });

    mockProbeAgent.answer.mockResolvedValue(productionResponse);

    const mockPrInfo: PRInfo = {
      number: 8,
      title: 'feat: migrate from probe-chat to @probelabs/probe agent',
      author: 'test',
      base: 'main',
      head: 'feature',
      body: 'Migration',
      totalAdditions: 196,
      totalDeletions: 262,
      files: [
        {
          filename: 'src/ai-review-service.ts',
          status: 'modified',
          additions: 196,
          deletions: 262,
          changes: 458,
          patch: '// changes',
        },
      ],
      fullDiff: '// diff',
      isIncremental: false,
    };

    const result = await aiService.executeReview(mockPrInfo, 'Create overview', 'plain');

    const content = result.issues![0].message;

    console.log('=== CRITICAL TEST OUTPUT ===');
    console.log('Raw content from parsing:');
    console.log(content);
    console.log('=== END CRITICAL TEST OUTPUT ===');

    // What we EXPECT to see (proper Mermaid blocks)
    expect(content).toContain('```mermaid');
    expect(content).toContain('graph TD');
    expect(content).toContain('```');

    // What production ACTUALLY shows (no backticks)
    // If this test passes but production doesn't have backticks,
    // then the issue is AFTER the parseAIResponse step
  });
});
