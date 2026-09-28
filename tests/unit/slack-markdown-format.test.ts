import { markdownToSlack, chunkText } from '../../src/slack/markdown';

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

  it('preserves bold markdown inside code blocks', () => {
    const input = '**bold outside**\n```\n**not bold inside**\n```\n**bold again**';
    const out = markdownToSlack(input);
    expect(out).toBe('*bold outside*\n```\n**not bold inside**\n```\n*bold again*');
  });

  it('preserves links inside code blocks', () => {
    const input = [
      '[real link](https://example.com)',
      '```',
      '[not a link](https://example.com/code)',
      '```',
      '[another link](https://example.com/2)',
    ].join('\n');
    const out = markdownToSlack(input);
    expect(out).toBe(
      [
        '<https://example.com|real link>',
        '```',
        '[not a link](https://example.com/code)',
        '```',
        '<https://example.com/2|another link>',
      ].join('\n')
    );
  });

  it('handles references section with links and bullets', () => {
    const input = [
      'Here is the answer.',
      '',
      '## References',
      '- [file.go:42-50](https://github.com/org/repo/blob/main/file.go#L42-L50) - JWT middleware',
      '- [auth.go:10](https://github.com/org/repo/blob/main/auth.go#L10) - Auth handler',
    ].join('\n');
    const out = markdownToSlack(input);
    expect(out).toBe(
      [
        'Here is the answer.',
        '',
        '*References*',
        '• <https://github.com/org/repo/blob/main/file.go#L42-L50|file.go:42-50> - JWT middleware',
        '• <https://github.com/org/repo/blob/main/auth.go#L10|auth.go:10> - Auth handler',
      ].join('\n')
    );
  });
});

describe('chunkText', () => {
  it('returns single chunk when text is under limit', () => {
    const text = 'Hello world, this is a short message.';
    const chunks = chunkText(text, 100);
    expect(chunks).toEqual([text]);
  });

  it('handles falsy or empty text safely', () => {
    expect(chunkText('', 100)).toEqual(['']);
    expect(chunkText(null as any, 100)).toEqual(['']);
    expect(chunkText(undefined as any, 100)).toEqual(['']);
  });

  it('splits text over limit at line boundaries without code blocks', () => {
    const lines = [
      'Line 1: first paragraph content',
      'Line 2: second paragraph content',
      'Line 3: third paragraph content',
    ];
    const text = lines.join('\n');
    const chunks = chunkText(text, 40);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
    expect(chunks.join('\n')).toBe(text);
  });

  it('splits inside a code block, closing chunk 1 with ``` and reopening chunk 2 with ```<lang>', () => {
    const text = [
      'Intro before code',
      '```typescript',
      'const a = 1;',
      'const b = 2;',
      '```',
      'Outro after code',
    ].join('\n');

    // Limit 50 splits neatly into 2 chunks:
    // Chunk 0: Intro + ```typescript + const a = 1; + ``` (48 chars)
    // Chunk 1: ```typescript + const b = 2; + ``` + Outro (47 chars)
    const chunks = chunkText(text, 50);

    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBeLessThanOrEqual(50);
    expect(chunks[1].length).toBeLessThanOrEqual(50);

    // Chunk 0 must end cleanly with closing code fence
    expect(chunks[0]).toContain('```typescript\nconst a = 1;');
    expect(chunks[0].endsWith('```')).toBe(true);

    // Chunk 1 must reopen with the same language specifier
    expect(chunks[1].startsWith('```typescript\n')).toBe(true);
    expect(chunks[1]).toContain('const b = 2;');
    expect(chunks[1]).toContain('Outro after code');
  });

  it('splits inside a code block without language specifier, reopening with plain ```', () => {
    const text = [
      '```',
      'first line of code',
      'second line of code',
      'third line of code',
      '```',
    ].join('\n');

    const chunks = chunkText(text, 35);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(35);
    }

    // First chunk closes with ```
    expect(chunks[0].endsWith('```')).toBe(true);
    // Subsequent chunk reopens with plain ```
    expect(chunks[1].startsWith('```\n')).toBe(true);
  });

  it('handles multiple code blocks and preserves respective language specifiers', () => {
    const text = [
      'Start',
      '```python',
      'def foo():',
      '    x = 1',
      '    y = 2',
      '```',
      'Middle explanation text',
      '```json',
      '{"key1": "value1",',
      ' "key2": "value2"}',
      '```',
      'End',
    ].join('\n');

    const chunks = chunkText(text, 40);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }

    // Verify python chunks
    const pythonChunks = chunks.filter(c => c.includes('def foo') || c.includes('x = 1'));
    for (const pc of pythonChunks) {
      expect(pc).toMatch(/```python/);
    }

    // Verify json chunks
    const jsonChunks = chunks.filter(c => c.includes('key1') || c.includes('key2'));
    for (const jc of jsonChunks) {
      expect(jc).toMatch(/```json/);
    }
  });

  it('force-splits a single line exceeding limit outside code blocks', () => {
    const longLine = 'a'.repeat(120);
    const chunks = chunkText(longLine, 50);

    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(50);
    expect(chunks[1].length).toBe(50);
    expect(chunks[2].length).toBe(20);
    expect(chunks.join('')).toBe(longLine);
  });

  it('safely splits and wraps a single line exceeding limit inside code block', () => {
    const longCodeLine = 'x'.repeat(100);
    const text = `\`\`\`javascript\n${longCodeLine}\n\`\`\``;
    const chunks = chunkText(text, 40);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
      expect(chunk.startsWith('```javascript')).toBe(true);
      expect(chunk.endsWith('```')).toBe(true);
    }
  });

  it('cleanly closes unclosed code blocks when splitting occurs', () => {
    const text = [
      '```python',
      'line 1 of open block',
      'line 2 of open block',
      'line 3 of open block',
    ].join('\n');

    const chunks = chunkText(text, 35);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(35);
    }
    // Final chunk should also be closed cleanly
    expect(chunks[chunks.length - 1].endsWith('```')).toBe(true);
  });
});
