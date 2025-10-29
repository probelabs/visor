import { AIReviewService } from '../../src/ai-review-service';

describe('loadSchemaContent smoke', () => {
  it('loads overview schema via private method', async () => {
    const svc: any = new AIReviewService({ provider: 'google', apiKey: 'x', debug: true });
    const s = await svc['loadSchemaContent']('overview');
    expect(typeof s).toBe('string');
    expect(s).toContain('Pull Request Overview');
  });
});
