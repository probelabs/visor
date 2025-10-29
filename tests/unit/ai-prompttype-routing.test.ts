let lastOptions: any = undefined;

jest.mock('@probelabs/probe', () => {
  return {
    ProbeAgent: jest.fn().mockImplementation((opts: any) => {
      lastOptions = opts;
      return {
        answer: jest.fn().mockResolvedValue('{"issues": []}'),
      };
    }),
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

describe('ProbeAgent promptType routing', () => {
  beforeEach(() => {
    lastOptions = undefined;
  });

  it('does not set promptType for overview schema', async () => {
    const svc = new AIReviewService({ provider: 'google', apiKey: 'x', debug: false });
    await svc.executeReview(pr, 'prompt', 'overview', 'overview');
    expect(lastOptions).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(lastOptions, 'promptType')).toBe(true);
    expect(lastOptions.promptType).toBeUndefined();
  });

  it('sets promptType=code-review for code-review schema', async () => {
    const svc = new AIReviewService({ provider: 'google', apiKey: 'x', debug: false });
    await svc.executeReview(pr, 'prompt', 'code-review', 'security');
    expect(lastOptions).toBeDefined();
    expect(lastOptions.promptType).toBe('code-review');
  });
});

