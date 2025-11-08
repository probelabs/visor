import { createExtendedLiquid } from '../../src/liquid-extensions';

describe('References example link liquid rendering', () => {
  const tpl =
    'https://github.com/{{ event.repository.fullName }}/blob/{{ event.pull_request.head.sha | default: "HEAD" }}/path/to/file.ext#LSTART-LEND';

  test('renders HEAD fallback for issue context', async () => {
    const liquid = createExtendedLiquid();
    const out = await liquid.parseAndRender(tpl, {
      event: {
        repository: { owner: { login: 'owner' }, name: 'repo', fullName: 'owner/repo' },
        // No pull_request in issue context
      },
    });
    expect(out).toBe('https://github.com/owner/repo/blob/HEAD/path/to/file.ext#LSTART-LEND');
  });

  test('renders PR head sha when provided', async () => {
    const liquid = createExtendedLiquid();
    const out = await liquid.parseAndRender(tpl, {
      event: {
        repository: { owner: { login: 'owner' }, name: 'repo', fullName: 'owner/repo' },
        pull_request: { head: { sha: 'deadbeefcafebabe' } },
      },
    });
    expect(out).toBe(
      'https://github.com/owner/repo/blob/deadbeefcafebabe/path/to/file.ext#LSTART-LEND'
    );
  });
});
