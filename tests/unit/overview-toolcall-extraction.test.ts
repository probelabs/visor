// Ensures overview text is extracted from tool-call style responses

jest.mock('@probelabs/probe', () => {
  return {
    ProbeAgent: jest.fn().mockImplementation(() => ({
      answer: jest.fn().mockResolvedValue(
        '<thinking>internal chain</thinking>\n<attempt_completion>{"result":"## PR Overview\nThis is the body."}</attempt_completion>'
      ),
    })),
  };
});

import { AIReviewService } from '../../src/ai-review-service';

describe('overview tool-call extraction', () => {
  it('extracts result field from <attempt_completion> wrapper', async () => {
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
    const out = (res as any).output || {};
    const text = String(out.text || '').trim();
    expect(text).toContain('## PR Overview');
    expect(text).toContain('This is the body.');
  });
});

