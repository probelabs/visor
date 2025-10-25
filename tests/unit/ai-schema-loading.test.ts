describe('AIReviewService schema loading', () => {
  it('loads built-in schema (overview) from repo output', async () => {
    require('ts-node/register/transpile-only');
    const { AIReviewService } = require('../../src/ai-review-service');
    const svc = new AIReviewService({ debug: false });
    const content: string = await (svc as any)['loadSchemaContent']('overview');
    expect(typeof content).toBe('string');
    expect(content.trim().length).toBeGreaterThan(10);
    expect(() => JSON.parse(content)).not.toThrow();
  });
});
