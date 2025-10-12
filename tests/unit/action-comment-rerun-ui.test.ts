import { deriveExecutedCheckNames } from '../../src/utils/ui-helpers';

describe('deriveExecutedCheckNames', () => {
  it('collects all executed checks across groups, including routed children', () => {
    const grouped = {
      dynamic: [{ checkName: 'comment-assistant', content: 'ok', group: 'dynamic' }],
      overview: [{ checkName: 'overview', content: 'overview ran', group: 'overview' }],
      review: [
        { checkName: 'quality', content: 'quality ran', group: 'review' },
        { checkName: 'security', content: 'security ran', group: 'review' },
      ],
    } as any;

    const names = deriveExecutedCheckNames(grouped).sort();
    expect(names).toEqual(['comment-assistant', 'overview', 'quality', 'security'].sort());
  });
});
