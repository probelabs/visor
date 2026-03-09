import { markdownToWhatsApp, chunkText, formatWhatsAppText } from '../../src/whatsapp/markdown';

describe('markdownToWhatsApp', () => {
  it('returns empty string for falsy input', () => {
    expect(markdownToWhatsApp('')).toBe('');
    expect(markdownToWhatsApp(null as any)).toBe('');
    expect(markdownToWhatsApp(undefined as any)).toBe('');
  });

  it('converts bold (**) to *', () => {
    expect(markdownToWhatsApp('Hello **world**!')).toBe('Hello *world*!');
  });

  it('converts bold (__) to *', () => {
    expect(markdownToWhatsApp('Hello __world__!')).toBe('Hello *world*!');
  });

  it('converts italic (*) to _', () => {
    expect(markdownToWhatsApp('Hello *world*!')).toBe('Hello _world_!');
  });

  it('converts strikethrough (~~) to ~', () => {
    expect(markdownToWhatsApp('Hello ~~world~~!')).toBe('Hello ~world~!');
  });

  it('converts inline code to triple backticks', () => {
    expect(markdownToWhatsApp('Use `npm install`')).toBe('Use ```npm install```');
  });

  it('converts headers to bold', () => {
    expect(markdownToWhatsApp('# Title')).toBe('*Title*');
    expect(markdownToWhatsApp('## Subtitle')).toBe('*Subtitle*');
    expect(markdownToWhatsApp('### Section')).toBe('*Section*');
  });

  it('converts links to label (url)', () => {
    expect(markdownToWhatsApp('[docs](https://example.com)')).toBe('docs (https://example.com)');
  });

  it('converts images to alt (url)', () => {
    expect(markdownToWhatsApp('![logo](https://example.com/img.png)')).toBe(
      'logo (https://example.com/img.png)'
    );
  });

  it('converts bullet lists', () => {
    const input = '- one\n- two\n* three';
    const out = markdownToWhatsApp(input);
    expect(out).toBe('- one\n- two\n- three');
  });

  it('converts numbered lists preserving numbers', () => {
    const input = '1. first\n2. second';
    const out = markdownToWhatsApp(input);
    expect(out).toBe('1. first\n2. second');
  });

  it('converts fenced code blocks', () => {
    const input = '```\nconst x = 1;\n```';
    const out = markdownToWhatsApp(input);
    expect(out).toBe('```const x = 1;```');
  });

  it('strips language from code blocks', () => {
    const input = '```typescript\nconst x: number = 1;\n```';
    const out = markdownToWhatsApp(input);
    expect(out).toContain('const x: number = 1;');
    expect(out).toContain('```');
  });

  it('does not apply formatting inside code blocks', () => {
    const input = '```\n**not bold** *not italic* [not a link](url)\n```';
    const out = markdownToWhatsApp(input);
    expect(out).toBe('```**not bold** *not italic* [not a link](url)```');
  });

  it('preserves blockquotes', () => {
    const input = '> This is a quote\n> Second line';
    const out = markdownToWhatsApp(input);
    expect(out).toBe('> This is a quote\n> Second line');
  });

  it('converts horizontal rules', () => {
    expect(markdownToWhatsApp('---')).toBe('---');
    expect(markdownToWhatsApp('***')).toBe('---');
    expect(markdownToWhatsApp('___')).toBe('---');
  });

  it('handles unclosed code blocks gracefully', () => {
    const input = '```\nsome code\nmore code';
    const out = markdownToWhatsApp(input);
    expect(out).toContain('some code');
    expect(out).toContain('```');
  });

  it('handles mixed formatting on one line', () => {
    const input = 'Hello **bold** and *italic* with `code`';
    const out = markdownToWhatsApp(input);
    expect(out).toContain('*bold*');
    expect(out).toContain('_italic_');
    expect(out).toContain('```code```');
  });

  it('handles a complete AI response', () => {
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
    const out = markdownToWhatsApp(input);
    expect(out).toContain('*Summary*');
    expect(out).toContain('*good*');
    expect(out).toContain('```config.ts```');
    expect(out).toContain('docs (https://example.com)');
    expect(out).toContain('const x = 1;');
  });

  it('converts h4-h6 headers to bold', () => {
    expect(markdownToWhatsApp('#### H4')).toBe('*H4*');
    expect(markdownToWhatsApp('##### H5')).toBe('*H5*');
    expect(markdownToWhatsApp('###### H6')).toBe('*H6*');
  });

  it('handles multiple code blocks in one response', () => {
    const md = '```js\nconst a = 1;\n```\nSome text\n```py\nx = 2\n```';
    const result = markdownToWhatsApp(md);
    expect(result).toContain('const a = 1;');
    expect(result).toContain('x = 2');
    expect(result).toContain('Some text');
  });
});

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    expect(chunkText('hello', 4096)).toEqual(['hello']);
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
    expect(chunkText('', 4096)).toEqual(['']);
  });
});

describe('formatWhatsAppText', () => {
  it('delegates to markdownToWhatsApp', () => {
    expect(formatWhatsAppText('**bold**')).toBe('*bold*');
  });
});
