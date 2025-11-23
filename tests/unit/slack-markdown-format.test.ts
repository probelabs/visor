import { markdownToSlack } from '../../src/slack/markdown';

describe('markdownToSlack', () => {
  it('converts bold and links to Slack mrkdwn', () => {
    const input = 'Hello **world**! See [docs](https://example.com/docs) and __status__ page.';
    const out = markdownToSlack(input);
    expect(out).toBe('Hello *world*! See <https://example.com/docs|docs> and *status* page.');
  });

  it('converts images to Slack link format', () => {
    const input = 'Logo: ![Visor](https://example.com/logo.png)';
    const out = markdownToSlack(input);
    expect(out).toBe('Logo: <https://example.com/logo.png|Visor>');
  });

  it('leaves inline asterisk emphasis unchanged (Slack still styles it)', () => {
    const input = 'This is *important* text but not *a list item*.';
    const out = markdownToSlack(input);
    expect(out).toBe(input);
  });

  it('converts top-level bullet lists to Slack bullets', () => {
    const input = '- one\n- two\n* three';
    const out = markdownToSlack(input);
    expect(out).toBe('• one\n• two\n• three');
  });

  it('preserves indentation for nested bullets and ignores code blocks', () => {
    const input = [
      '- parent',
      '  - child',
      '```',
      '- not-a-bullet inside code',
      '```',
      '- after',
    ].join('\n');
    const out = markdownToSlack(input);
    expect(out).toBe(
      ['• parent', '  • child', '```', '- not-a-bullet inside code', '```', '• after'].join('\n')
    );
  });
});
