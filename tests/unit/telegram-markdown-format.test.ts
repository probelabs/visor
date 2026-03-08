import {
  escapeHtml,
  markdownToTelegramHtml,
  chunkText,
  formatTelegramText,
} from '../../src/telegram/markdown';

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('markdownToTelegramHtml', () => {
  it('returns empty string for falsy input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
    expect(markdownToTelegramHtml(null as any)).toBe('');
    expect(markdownToTelegramHtml(undefined as any)).toBe('');
  });

  it('converts bold (**) to <b>', () => {
    expect(markdownToTelegramHtml('Hello **world**!')).toBe('Hello <b>world</b>!');
  });

  it('converts bold (__) to <b>', () => {
    expect(markdownToTelegramHtml('Hello __world__!')).toBe('Hello <b>world</b>!');
  });

  it('converts italic (*) to <i>', () => {
    expect(markdownToTelegramHtml('Hello *world*!')).toBe('Hello <i>world</i>!');
  });

  it('converts strikethrough (~~) to <s>', () => {
    expect(markdownToTelegramHtml('Hello ~~world~~!')).toBe('Hello <s>world</s>!');
  });

  it('converts inline code to <code>', () => {
    expect(markdownToTelegramHtml('Use `npm install`')).toBe('Use <code>npm install</code>');
  });

  it('escapes HTML inside inline code', () => {
    expect(markdownToTelegramHtml('Use `a<b>c`')).toBe('Use <code>a&lt;b&gt;c</code>');
  });

  it('converts headers to <b>', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>');
    expect(markdownToTelegramHtml('## Subtitle')).toBe('<b>Subtitle</b>');
    expect(markdownToTelegramHtml('### Section')).toBe('<b>Section</b>');
  });

  it('converts links to <a href>', () => {
    expect(markdownToTelegramHtml('[docs](https://example.com)')).toBe(
      '<a href="https://example.com">docs</a>',
    );
  });

  it('converts images to <a href>', () => {
    expect(markdownToTelegramHtml('![logo](https://example.com/img.png)')).toBe(
      '<a href="https://example.com/img.png">logo</a>',
    );
  });

  it('converts bullet lists', () => {
    const input = '- one\n- two\n* three';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('• one\n• two\n• three');
  });

  it('preserves indentation for nested bullets', () => {
    const input = '- parent\n  - child';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('• parent\n  • child');
  });

  it('converts numbered lists preserving numbers', () => {
    const input = '1. first\n2. second';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('1. first\n2. second');
  });

  it('converts fenced code blocks to <pre>', () => {
    const input = '```\nconst x = 1;\n```';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('<pre>const x = 1;</pre>');
  });

  it('includes language class in code blocks', () => {
    const input = '```typescript\nconst x: number = 1;\n```';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('<pre><code class="language-typescript">const x: number = 1;</code></pre>');
  });

  it('escapes HTML inside code blocks', () => {
    const input = '```\nif (a < b && c > d) {}\n```';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('<pre>if (a &lt; b &amp;&amp; c &gt; d) {}</pre>');
  });

  it('does not apply formatting inside code blocks', () => {
    const input = '```\n**not bold** *not italic* [not a link](url)\n```';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('<pre>**not bold** *not italic* [not a link](url)</pre>');
  });

  it('converts blockquotes', () => {
    const input = '> This is a quote\n> Second line';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('<blockquote>This is a quote\nSecond line</blockquote>');
  });

  it('converts horizontal rules to dashes', () => {
    expect(markdownToTelegramHtml('---')).toBe('———');
    expect(markdownToTelegramHtml('***')).toBe('———');
    expect(markdownToTelegramHtml('___')).toBe('———');
  });

  it('handles unclosed code blocks gracefully', () => {
    const input = '```\nsome code\nmore code';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('<pre>some code\nmore code</pre>');
  });

  it('escapes HTML entities in regular text', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('handles mixed formatting on one line', () => {
    const input = 'Hello **bold** and *italic* with `code`';
    const out = markdownToTelegramHtml(input);
    expect(out).toBe('Hello <b>bold</b> and <i>italic</i> with <code>code</code>');
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
    const out = markdownToTelegramHtml(input);
    expect(out).toContain('<b>Summary</b>');
    expect(out).toContain('<b>good</b>');
    expect(out).toContain('• Check <code>config.ts</code>');
    expect(out).toContain('<a href="https://example.com">docs</a>');
    expect(out).toContain('<pre><code class="language-typescript">const x = 1;</code></pre>');
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

describe('formatTelegramText', () => {
  it('delegates to markdownToTelegramHtml', () => {
    expect(formatTelegramText('**bold**')).toBe('<b>bold</b>');
  });
});
