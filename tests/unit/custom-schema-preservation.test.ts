import { describe, it, expect, jest } from '@jest/globals';
import { AIReviewService } from '../../src/ai-review-service';

/**
 * Unit Test: Custom Schema Field Preservation
 *
 * This test verifies that AI checks with custom schemas preserve
 * all fields from the AI response and don't force them into the
 * standard code review schema with "issues" array.
 */
describe('Custom Schema Field Preservation', () => {
  it('should preserve all fields for inline custom schemas', async () => {
    const mockConfig = {
      provider: 'mock' as const,
      model: 'mock',
      apiKey: 'test-key',
      debug: false,
    };

    const service = new AIReviewService(mockConfig);

    const customSchema = {
      type: 'object',
      properties: {
        complexity: { type: 'string' },
        priority: { type: 'number' },
        estimated_hours: { type: 'number' },
      },
    };

    const mockPRInfo = {
      number: 123,
      title: 'Test',
      body: '',
      author: 'test',
      base: 'main',
      head: 'feat',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    // Mock the AI response to return custom schema data
    jest.spyOn(service as any, 'callProbeAgent').mockResolvedValue({
      response: JSON.stringify({
        complexity: 'high',
        priority: 8,
        estimated_hours: 24,
      }),
      effectiveSchema: 'custom',
    });

    const result = await service.executeReview(
      mockPRInfo,
      'Analyze this',
      customSchema,
      'test-check'
    );

    // Should have output field with all custom fields
    expect((result as any).output).toBeDefined();
    expect((result as any).output.complexity).toBe('high');
    expect((result as any).output.priority).toBe(8);
    expect((result as any).output.estimated_hours).toBe(24);

    // Should have empty issues array (no code review)
    expect(result.issues).toEqual([]);
  });

  it('should preserve all fields for file-based custom schemas', async () => {
    const mockConfig = {
      provider: 'mock' as const,
      model: 'mock',
      apiKey: 'test-key',
      debug: false,
    };

    const service = new AIReviewService(mockConfig);

    const mockPRInfo = {
      number: 123,
      title: 'Test',
      body: '',
      author: 'test',
      base: 'main',
      head: 'feat',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    // Mock the AI response with a file-based schema path
    jest.spyOn(service as any, 'callProbeAgent').mockResolvedValue({
      response: JSON.stringify({
        temperature: 72,
        conditions: 'sunny',
        forecast: ['clear', 'rain'],
      }),
      effectiveSchema: './schemas/weather.json',
    });

    const result = await service.executeReview(
      mockPRInfo,
      'What is the weather?',
      './schemas/weather.json',
      'weather-check'
    );

    // Should preserve custom fields
    expect((result as any).output).toBeDefined();
    expect((result as any).output.temperature).toBe(72);
    expect((result as any).output.conditions).toBe('sunny');
    expect((result as any).output.forecast).toEqual(['clear', 'rain']);

    // Should have empty issues array
    expect(result.issues).toEqual([]);
  });

  it('should NOT preserve custom fields for code-review schema', async () => {
    const mockConfig = {
      provider: 'mock' as const,
      model: 'mock',
      apiKey: 'test-key',
      debug: false,
    };

    const service = new AIReviewService(mockConfig);

    const mockPRInfo = {
      number: 123,
      title: 'Test',
      body: '',
      author: 'test',
      base: 'main',
      head: 'feat',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    // Mock the AI response with code-review schema
    jest.spyOn(service as any, 'callProbeAgent').mockResolvedValue({
      response: JSON.stringify({
        issues: [
          {
            file: 'test.js',
            line: 10,
            ruleId: 'security/xss',
            message: 'Potential XSS',
            severity: 'error',
            category: 'security',
          },
        ],
      }),
      effectiveSchema: 'code-review',
    });

    const result = await service.executeReview(
      mockPRInfo,
      'Review this code',
      'code-review',
      'review-check'
    );

    // Should have processed issues
    expect(result.issues).toHaveLength(1);
    expect(result.issues![0].file).toBe('test.js');
    expect(result.issues![0].severity).toBe('error');

    // Should NOT have output field for code-review schema
    expect((result as any).output).toBeUndefined();
  });

  it('should handle custom schemas with no required fields', async () => {
    const mockConfig = {
      provider: 'mock' as const,
      model: 'mock',
      apiKey: 'test-key',
      debug: false,
    };

    const service = new AIReviewService(mockConfig);

    const customSchema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        notes: { type: 'string' },
      },
      // No required fields
    };

    const mockPRInfo = {
      number: 123,
      title: 'Test',
      body: '',
      author: 'test',
      base: 'main',
      head: 'feat',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    jest.spyOn(service as any, 'callProbeAgent').mockResolvedValue({
      response: JSON.stringify({
        score: 95,
        // notes field omitted
      }),
      effectiveSchema: 'custom',
    });

    const result = await service.executeReview(
      mockPRInfo,
      'Score this',
      customSchema,
      'score-check'
    );

    // Should preserve whatever fields are present
    expect((result as any).output).toBeDefined();
    expect((result as any).output.score).toBe(95);
    expect((result as any).output.notes).toBeUndefined();
    expect(result.issues).toEqual([]);
  });
});
