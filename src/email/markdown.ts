// Markdown → email HTML converter.
// Converts AI Markdown output to email-compatible HTML with inline styles.
//
// Supported conversions:
// - # Header        → <h1 style="...">Header</h1>
// - **bold**        → <strong>bold</strong>
// - *italic*        → <em>italic</em>
// - ~~strike~~      → <del>strike</del>
// - `code`          → <code style="...">code</code>
// - ```block```     → <pre style="..."><code>block</code></pre>
// - [label](url)    → <a href="url">label</a>
// - > blockquote    → <blockquote style="...">text</blockquote>
// - - item          → <ul><li>item</li></ul>
// - 1. item         → <ol><li>item</li></ol>
// - ---             → <hr>
// HTML entities escaped: & < >

/** Escape HTML entities in text */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert Markdown text to email-compatible HTML.
 * Processes line-by-line, respecting fenced code blocks.
 */
export function markdownToEmailHtml(text: string): string {
  if (!text || typeof text !== 'string') return '';

  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeLines: string[] = [];
  let inBlockquote = false;
  let blockquoteLines: string[] = [];
  const listStack: ('ul' | 'ol')[] = [];

  const flushBlockquote = () => {
    if (blockquoteLines.length > 0) {
      result.push(
        `<blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#555;">${blockquoteLines.join('<br>')}</blockquote>`
      );
      blockquoteLines = [];
      inBlockquote = false;
    }
  };

  const flushList = () => {
    while (listStack.length > 0) {
      const tag = listStack.pop()!;
      result.push(`</${tag}>`);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // Track fenced code blocks
    if (/^```/.test(trimmed)) {
      if (!inCodeBlock) {
        flushBlockquote();
        flushList();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        const escaped = codeLines.map(l => escapeHtml(l)).join('\n');
        const langAttr = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : '';
        result.push(
          `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;"><code${langAttr}>${escaped}</code></pre>`
        );
        inCodeBlock = false;
        codeBlockLang = '';
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(lines[i]);
      continue;
    }

    // Blockquotes: > text
    const bqMatch = /^>\s?(.*)$/.exec(trimmed);
    if (bqMatch) {
      flushList();
      inBlockquote = true;
      blockquoteLines.push(convertInline(bqMatch[1]));
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // Bullet lists: "- item" or "* item"
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(lines[i]);
    if (bulletMatch) {
      if (listStack.length === 0 || listStack[listStack.length - 1] !== 'ul') {
        flushList();
        listStack.push('ul');
        result.push('<ul style="margin:4px 0;padding-left:24px;">');
      }
      result.push(`<li>${convertInline(bulletMatch[3])}</li>`);
      continue;
    }

    // Numbered lists: "1. item"
    const numMatch = /^(\s*)(\d+)\.\s+(.+)$/.exec(lines[i]);
    if (numMatch) {
      if (listStack.length === 0 || listStack[listStack.length - 1] !== 'ol') {
        flushList();
        listStack.push('ol');
        result.push('<ol style="margin:4px 0;padding-left:24px;">');
      }
      result.push(`<li>${convertInline(numMatch[3])}</li>`);
      continue;
    }

    // Close any open list if we hit a non-list line
    if (listStack.length > 0) flushList();

    const line = lines[i];

    // Headers: # Header → <h1>...</h1> etc.
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line.trimStart());
    if (headerMatch) {
      const level = headerMatch[1].length;
      const sizes: Record<number, string> = {
        1: '24px',
        2: '20px',
        3: '18px',
        4: '16px',
        5: '14px',
        6: '13px',
      };
      result.push(
        `<h${level} style="font-size:${sizes[level]};margin:16px 0 8px 0;">${convertInline(headerMatch[2].trim())}</h${level}>`
      );
      continue;
    }

    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      result.push('<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">');
      continue;
    }

    // Empty lines → <br>
    if (trimmed === '') {
      result.push('<br>');
      continue;
    }

    // Regular line: apply inline conversions
    result.push(`<p style="margin:4px 0;">${convertInline(line)}</p>`);
  }

  // Close any unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    const escaped = codeLines.map(l => escapeHtml(l)).join('\n');
    result.push(
      `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;"><code>${escaped}</code></pre>`
    );
  }
  flushBlockquote();
  flushList();

  return result.join('\n');
}

/**
 * Apply inline Markdown conversions to a single line.
 * Order matters: escape HTML first, then apply formatting.
 */
function convertInline(line: string): string {
  // First, identify and protect inline code spans
  const codeSpans: string[] = [];
  let processed = line.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(
      `<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:13px;">${escapeHtml(code)}</code>`
    );
    return `\x00CODE${idx}\x00`;
  });

  // Escape HTML in non-code portions
  processed = escapeHtml(processed);

  // Images: ![alt](url)
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt: string, url: string) =>
      `<img src="${url}" alt="${alt || 'image'}" style="max-width:100%;">`
  );

  // Links: [label](url) → <a href="url">label</a>
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, label: string, url: string) => `<a href="${url}" style="color:#0066cc;">${label}</a>`
  );

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  processed = processed.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic: *text* (but not inside bold)
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Restore code spans
  processed = processed.replace(
    /\x00CODE(\d+)\x00/g,
    (_m, idx: string) => codeSpans[parseInt(idx)]
  );

  return processed;
}

/**
 * Wrap body HTML in a complete email HTML template with inline CSS.
 */
export function wrapInEmailTemplate(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#333;max-width:600px;margin:0 auto;padding:16px;">
${bodyHtml}
</body>
</html>`;
}

/**
 * Format text as a plain-text email quote (prepend "> " to each line).
 */
export function formatEmailQuote(text: string): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .map(l => `> ${l}`)
    .join('\n');
}

/**
 * Add "Re: " prefix to subject if not already present.
 */
export function addRePrefix(subject: string): string {
  if (!subject) return 'Re:';
  if (/^Re:/i.test(subject.trim())) return subject.trim();
  return `Re: ${subject.trim()}`;
}

/**
 * Main entry point: convert Markdown to email HTML body (not wrapped in template).
 */
export function formatEmailText(text: string): string {
  return markdownToEmailHtml(text);
}
