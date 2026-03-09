import {
  escapeHtml,
  markdownToEmailHtml,
  formatEmailText,
  wrapInEmailTemplate,
  formatEmailQuote,
  addRePrefix,
} from '../../src/email/markdown';

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('markdownToEmailHtml', () => {
  it('returns empty string for falsy input', () => {
    expect(markdownToEmailHtml('')).toBe('');
    expect(markdownToEmailHtml(null as any)).toBe('');
    expect(markdownToEmailHtml(undefined as any)).toBe('');
  });

  it('converts bold (**) to <strong>', () => {
    expect(markdownToEmailHtml('Hello **world**!')).toContain('<strong>world</strong>');
  });

  it('converts bold (__) to <strong>', () => {
    expect(markdownToEmailHtml('Hello __world__!')).toContain('<strong>world</strong>');
  });

  it('converts italic (*) to <em>', () => {
    expect(markdownToEmailHtml('Hello *world*!')).toContain('<em>world</em>');
  });

  it('converts strikethrough (~~) to <del>', () => {
    expect(markdownToEmailHtml('Hello ~~world~~!')).toContain('<del>world</del>');
  });

  it('converts inline code to <code>', () => {
    const result = markdownToEmailHtml('Use `npm install`');
    expect(result).toContain('<code');
    expect(result).toContain('npm install</code>');
  });

  it('escapes HTML inside inline code', () => {
    const result = markdownToEmailHtml('Use `a<b>c`');
    expect(result).toContain('a&lt;b&gt;c</code>');
  });

  it('converts headers to <h1>-<h6>', () => {
    expect(markdownToEmailHtml('# Title')).toContain('<h1');
    expect(markdownToEmailHtml('# Title')).toContain('Title</h1>');
    expect(markdownToEmailHtml('## Subtitle')).toContain('<h2');
    expect(markdownToEmailHtml('### Section')).toContain('<h3');
  });

  it('converts links to <a href>', () => {
    const result = markdownToEmailHtml('[docs](https://example.com)');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('>docs</a>');
  });

  it('converts fenced code blocks to <pre><code>', () => {
    const md = '```js\nconst x = 1;\n```';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<pre');
    expect(result).toContain('language-js');
    expect(result).toContain('const x = 1;');
  });

  it('converts bullet lists to <ul><li>', () => {
    const md = '- one\n- two';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<ul');
    expect(result).toContain('<li>');
    expect(result).toContain('one</li>');
    expect(result).toContain('two</li>');
  });

  it('converts numbered lists to <ol><li>', () => {
    const md = '1. first\n2. second';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<ol');
    expect(result).toContain('<li>');
    expect(result).toContain('first</li>');
  });

  it('converts blockquotes to <blockquote>', () => {
    const md = '> Some quoted text';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<blockquote');
    expect(result).toContain('Some quoted text');
  });

  it('converts horizontal rules to <hr>', () => {
    expect(markdownToEmailHtml('---')).toContain('<hr');
  });

  it('handles unclosed code blocks gracefully', () => {
    const md = '```\nunclosed code';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<pre');
    expect(result).toContain('unclosed code');
  });

  it('converts image markdown to <img> tag', () => {
    const result = markdownToEmailHtml('![logo](https://example.com/img.png)');
    expect(result).toContain('<img');
    expect(result).toContain('src="https://example.com/img.png"');
    expect(result).toContain('alt="logo"');
  });

  it('handles multiple code blocks in one response', () => {
    const md = '```js\nconst a = 1;\n```\nSome text\n```py\nx = 2\n```';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('language-js');
    expect(result).toContain('language-py');
    expect(result).toContain('const a = 1;');
    expect(result).toContain('x = 2');
  });

  it('handles mixed formatting on one line', () => {
    const result = markdownToEmailHtml('**bold** and *italic* and `code`');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<code');
    expect(result).toContain('code</code>');
  });

  it('preserves content inside code blocks without converting markdown', () => {
    const md = '```\n**not bold** *not italic*\n```';
    const result = markdownToEmailHtml(md);
    // Inside code blocks, markdown should be escaped not converted
    expect(result).not.toContain('<strong>');
    expect(result).not.toContain('<em>');
    expect(result).toContain('**not bold**');
  });

  it('handles consecutive blockquote lines', () => {
    const md = '> line one\n> line two\n> line three';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<blockquote');
    expect(result).toContain('line one');
    expect(result).toContain('line two');
    expect(result).toContain('line three');
    // All should be in one blockquote, not three
    expect(result.match(/<blockquote/g)?.length).toBe(1);
  });

  it('handles list followed by paragraph', () => {
    const md = '- item 1\n- item 2\n\nParagraph after list';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<ul');
    expect(result).toContain('</ul>');
    expect(result).toContain('Paragraph after list');
  });

  it('converts * bullet lists same as - bullet lists', () => {
    const md = '* alpha\n* beta';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<ul');
    expect(result).toContain('alpha</li>');
    expect(result).toContain('beta</li>');
  });

  it('handles horizontal rule variants', () => {
    expect(markdownToEmailHtml('***')).toContain('<hr');
    expect(markdownToEmailHtml('___')).toContain('<hr');
    expect(markdownToEmailHtml('-----')).toContain('<hr');
  });

  it('converts h4-h6 headers', () => {
    expect(markdownToEmailHtml('#### H4')).toContain('<h4');
    expect(markdownToEmailHtml('##### H5')).toContain('<h5');
    expect(markdownToEmailHtml('###### H6')).toContain('<h6');
  });

  it('renders empty lines as <br>', () => {
    const result = markdownToEmailHtml('line1\n\nline2');
    expect(result).toContain('<br>');
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  it('handles code block without language specifier', () => {
    const md = '```\nplain code\n```';
    const result = markdownToEmailHtml(md);
    expect(result).toContain('<pre');
    expect(result).toContain('plain code');
    expect(result).not.toContain('class="language-"');
  });
});

describe('wrapInEmailTemplate', () => {
  it('wraps body in complete HTML document', () => {
    const result = wrapInEmailTemplate('<p>Hello</p>');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<html>');
    expect(result).toContain('<body');
    expect(result).toContain('<p>Hello</p>');
    expect(result).toContain('</body>');
    expect(result).toContain('</html>');
  });

  it('includes meta charset', () => {
    const result = wrapInEmailTemplate('');
    expect(result).toContain('charset="utf-8"');
  });
});

describe('formatEmailQuote', () => {
  it('prepends > to each line', () => {
    expect(formatEmailQuote('line1\nline2')).toBe('> line1\n> line2');
  });

  it('returns empty string for empty input', () => {
    expect(formatEmailQuote('')).toBe('');
  });
});

describe('addRePrefix', () => {
  it('adds Re: prefix to subject', () => {
    expect(addRePrefix('Hello')).toBe('Re: Hello');
  });

  it('does not double-add Re: prefix', () => {
    expect(addRePrefix('Re: Hello')).toBe('Re: Hello');
  });

  it('is case-insensitive on existing Re:', () => {
    expect(addRePrefix('re: Hello')).toBe('re: Hello');
    expect(addRePrefix('RE: Hello')).toBe('RE: Hello');
  });

  it('handles empty subject', () => {
    expect(addRePrefix('')).toBe('Re:');
  });
});

describe('formatEmailText', () => {
  it('calls markdownToEmailHtml', () => {
    const result = formatEmailText('**bold** text');
    expect(result).toContain('<strong>bold</strong>');
  });
});
