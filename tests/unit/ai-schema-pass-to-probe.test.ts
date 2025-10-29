let lastAnswerArgs: any[] = [];

jest.mock('@probelabs/probe', () => {
  return {
    ProbeAgent: jest.fn().mockImplementation(() => ({
      answer: jest.fn().mockImplementation((msg: string, _images?: unknown, opts?: any) => {
        lastAnswerArgs = [msg, opts];
        // Return minimal valid JSON for code-review and text for overview
        return Promise.resolve(opts ? '{"issues":[]}' : '## Text');
      }),
    })),
  };
});

import { AIReviewService } from '../../src/ai-review-service';

const pr = {
  number: 1,
  title: 't',
  body: 'b',
  author: 'a',
  base: 'main',
  head: 'feat',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  fullDiff: '',
  eventType: 'pr_opened',
  isIssue: false,
} as any;

describe('AI schema passing to ProbeAgent', () => {
  beforeEach(() => {
    lastAnswerArgs = [];
  });

  it('does not pass schema options for overview', async () => {
    const svc = new AIReviewService({ provider: 'google', apiKey: 'x', debug: false });
    await svc.executeReview(pr, 'prompt', 'overview', 'overview');
    expect(lastAnswerArgs.length).toBeGreaterThanOrEqual(2);
    const [, opts] = lastAnswerArgs;
    expect(opts).toBeUndefined();
  });

  it('passes schema options for code-review', async () => {
    const svc = new AIReviewService({ provider: 'google', apiKey: 'x', debug: false });
    await svc.executeReview(pr, 'prompt', 'code-review', 'security');
    expect(lastAnswerArgs.length).toBeGreaterThanOrEqual(2);
    const [, opts] = lastAnswerArgs;
    expect(opts).toBeDefined();
    expect(typeof opts.schema).toBe('string');
  });
});

