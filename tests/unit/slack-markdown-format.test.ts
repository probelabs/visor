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

  it('converts markdown headers to bold text', () => {
    const input = '# Main Title\n## Subtitle\n### Section';
    const out = markdownToSlack(input);
    expect(out).toBe('*Main Title*\n*Subtitle*\n*Section*');
  });

  it('adds newline before h1/h2 headers when preceded by content', () => {
    const input = 'Some content\n## New Section\nMore content';
    const out = markdownToSlack(input);
    expect(out).toBe('Some content\n\n*New Section*\nMore content');
  });

  it('does not add newline before h1 if it is the first line', () => {
    const input = '# First Header\nContent here';
    const out = markdownToSlack(input);
    expect(out).toBe('*First Header*\nContent here');
  });

  it('ignores headers inside code blocks', () => {
    const input = '```\n# This is a comment\n```\n# Real Header';
    const out = markdownToSlack(input);
    expect(out).toBe('```\n# This is a comment\n```\n*Real Header*');
  });
});
