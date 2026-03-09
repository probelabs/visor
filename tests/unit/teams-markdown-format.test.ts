import { markdownToTeams, chunkText, formatTeamsText } from '../../src/teams/markdown';

describe('markdownToTeams', () => {
  it('returns empty string for falsy input', () => {
    expect(markdownToTeams('')).toBe('');
    expect(markdownToTeams(null as any)).toBe('');
    expect(markdownToTeams(undefined as any)).toBe('');
  });

  it('passes through bold (**) as-is', () => {
    expect(markdownToTeams('Hello **world**!')).toBe('Hello **world**!');
  });

  it('passes through bold (__) as-is', () => {
    expect(markdownToTeams('Hello __world__!')).toBe('Hello __world__!');
  });

  it('passes through italic (*) as-is', () => {
    expect(markdownToTeams('Hello *world*!')).toBe('Hello *world*!');
  });

  it('passes through strikethrough (~~) as-is', () => {
    expect(markdownToTeams('Hello ~~world~~!')).toBe('Hello ~~world~~!');
  });

  it('passes through inline code as-is', () => {
    expect(markdownToTeams('Use `npm install`')).toBe('Use `npm install`');
  });

  it('passes through headers as-is', () => {
    expect(markdownToTeams('# Title')).toBe('# Title');
    expect(markdownToTeams('## Subtitle')).toBe('## Subtitle');
    expect(markdownToTeams('### Section')).toBe('### Section');
  });

  it('passes through links as-is', () => {
    expect(markdownToTeams('[docs](https://example.com)')).toBe('[docs](https://example.com)');
  });

  it('passes through images as-is', () => {
    expect(markdownToTeams('![logo](https://example.com/img.png)')).toBe(
      '![logo](https://example.com/img.png)'
    );
  });

  it('passes through bullet lists as-is', () => {
    const input = '- one\n- two\n* three';
    const out = markdownToTeams(input);
    expect(out).toBe('- one\n- two\n* three');
  });

  it('passes through numbered lists as-is', () => {
    const input = '1. first\n2. second';
    const out = markdownToTeams(input);
    expect(out).toBe('1. first\n2. second');
  });

  it('passes through fenced code blocks as-is', () => {
    const input = '```\nconst x = 1;\n```';
    const out = markdownToTeams(input);
    expect(out).toBe('```\nconst x = 1;\n```');
  });

  it('passes through code blocks with language as-is', () => {
    const input = '```typescript\nconst x: number = 1;\n```';
    const out = markdownToTeams(input);
    expect(out).toContain('```typescript');
    expect(out).toContain('const x: number = 1;');
  });

  it('passes through blockquotes as-is', () => {
    const input = '> This is a quote\n> Second line';
    const out = markdownToTeams(input);
    expect(out).toBe('> This is a quote\n> Second line');
  });

  it('passes through horizontal rules as-is', () => {
    expect(markdownToTeams('---')).toBe('---');
    expect(markdownToTeams('***')).toBe('***');
    expect(markdownToTeams('___')).toBe('___');
  });

  it('handles mixed formatting on one line', () => {
    const input = 'Hello **bold** and *italic* with `code`';
    const out = markdownToTeams(input);
    expect(out).toBe('Hello **bold** and *italic* with `code`');
  });

  it('handles a complete AI response (passthrough)', () => {
    const input = [
      '# Summary',
      '',
      'The code looks **good**. Here are some notes:',
      '',
      '- Check `config.ts` for missing types',
      '- See [docs](https://example.com)',
      '',
      '```typescript',
      'const x = 1;',
      '```',
    ].join('\n');
    const out = markdownToTeams(input);
    expect(out).toBe(input);
  });

  it('passes through h4-h6 headers as-is', () => {
    expect(markdownToTeams('#### H4')).toBe('#### H4');
    expect(markdownToTeams('##### H5')).toBe('##### H5');
    expect(markdownToTeams('###### H6')).toBe('###### H6');
  });

  it('handles multiple code blocks in one response', () => {
    const md = '```js\nconst a = 1;\n```\nSome text\n```py\nx = 2\n```';
    const result = markdownToTeams(md);
    expect(result).toContain('const a = 1;');
    expect(result).toContain('x = 2');
    expect(result).toContain('Some text');
  });

  it('returns the exact same string for standard markdown', () => {
    const input = 'This is **bold** and *italic* text.';
    expect(markdownToTeams(input)).toBe(input);
  });
});

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    expect(chunkText('hello', 28000)).toEqual(['hello']);
  });

  it('splits at newlines when exceeding limit', () => {
    const lines = ['line1', 'line2', 'line3'];
    const text = lines.join('\n');
    const chunks = chunkText(text, 11); // "line1\nline2" = 11
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe('line1\nline2');
    expect(chunks[1]).toBe('line3');
  });

  it('force-splits lines exceeding limit', () => {
    const text = 'a'.repeat(10);
    const chunks = chunkText(text, 4);
    expect(chunks).toEqual(['aaaa', 'aaaa', 'aa']);
  });

  it('handles empty text', () => {
    expect(chunkText('', 28000)).toEqual(['']);
  });

  it('uses default limit of 28000', () => {
    const shortText = 'a'.repeat(27999);
    expect(chunkText(shortText)).toEqual([shortText]);
  });

  it('splits at 28000 default limit', () => {
    const longText = 'a'.repeat(28001);
    const chunks = chunkText(longText);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(28000);
    expect(chunks[1].length).toBe(1);
  });
});

describe('formatTeamsText', () => {
  it('delegates to markdownToTeams', () => {
    expect(formatTeamsText('**bold**')).toBe('**bold**');
  });

  it('returns the input unchanged', () => {
    const input = 'Hello **world** with `code`!';
    expect(formatTeamsText(input)).toBe(input);
  });
});
