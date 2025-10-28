// Verifies that when the AI returns raw JSON "[]" for an overview check,
// the renderer does not surface "[]" as content.

jest.mock('@probelabs/probe', () => {
  return {
    ProbeAgent: jest.fn().mockImplementation(() => ({
      answer: jest.fn().mockResolvedValue('[]'),
    })),
  };
});

import { AIReviewService } from '../../src/ai-review-service';

describe('overview empty-array fallback', () => {
  it('does not surface [] for overview schema', async () => {
    const svc = new AIReviewService({ provider: 'google', apiKey: 'x', debug: false });
    const prInfo = {
      number: 1,
      title: 't',
      body: 'b',
      author: 'a',
      base: 'main',
      head: 'feature',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      fullDiff: '',
      eventType: 'pr_opened',
      isIssue: false,
    } as any;

    const res = await svc.executeReview(prInfo, 'prompt', 'overview', 'overview');
    // No issues for custom schemas; output exists but text should not be "[]".
    expect(res.issues).toEqual([]);
    const out = (res as any).output || {};
    const text = String(out.text || '').trim();
    expect(text).not.toBe('[]');
  });
});
