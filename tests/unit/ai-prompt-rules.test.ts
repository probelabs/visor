import { AIReviewService } from '../../src/ai-review-service';

describe('AI prompt rules (code-review schema)', () => {
  it('includes strict no-praise rule and severity guidance', async () => {
    const svc = new AIReviewService();
    const prInfo: any = {
      number: 1,
      title: 'Test',
      author: 'tester',
      base: 'main',
      head: 'feature',
      files: [],
      isIncremental: false,
      isPRContext: true,
    };

    // Access private via any — runtime allows invocation in tests
    const prompt = await (svc as any).buildCustomPrompt(
      prInfo,
      'Do a careful review',
      'code-review'
    );
    expect(prompt).toContain('STRICT OUTPUT POLICY');
    expect(prompt).toContain('Do not write praise');
    expect(prompt).toContain('Assign severity ONLY to problems');
  });
});
