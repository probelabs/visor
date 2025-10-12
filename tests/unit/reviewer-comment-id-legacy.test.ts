import { PRReviewer } from '../../src/reviewer';
import { CommentManager } from '../../src/github-comments';

// Minimal Octokit mock
const mockOctokit: any = {
  rest: {
    issues: {
      listComments: jest.fn().mockResolvedValue({ data: [] }),
      createComment: jest.fn(),
      updateComment: jest.fn(),
    },
  },
};

describe('Reviewer comment IDs use legacy pr-review-<PR>-<group>', () => {
  it('passes pr-review-<PR>-overview to CommentManager', async () => {
    const reviewer = new PRReviewer(mockOctokit);

    const groupedResults = {
      overview: [
        {
          checkName: 'overview',
          content: 'content',
          group: 'overview',
        },
      ],
    } as any;

    const spy = jest
      .spyOn(CommentManager.prototype as any, 'updateOrCreateComment')
      .mockResolvedValue({
        id: 1,
        body: 'x',
        user: { login: 'a' },
        created_at: '',
        updated_at: '',
      } as any);

    await reviewer.postReviewComment('acme', 'widgets', 42, groupedResults, {
      commentId: 'pr-review-42',
    } as any);

    expect(spy).toHaveBeenCalled();
    const args = spy.mock.calls[0] as any[];
    expect(args[3]).toContain('Code Analysis Results');
    expect((args[4] as any).commentId).toBe('pr-review-42-overview');

    spy.mockRestore();
  });
});
