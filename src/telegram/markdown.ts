// Lightweight Markdown → Telegram HTML formatter.
// Converts common Markdown output from AI steps to Telegram-compatible HTML.
//
// Supported conversions:
// - # Header / ## Header  → <b>Header</b>
// - **bold** / __bold__   → <b>bold</b>
// - *italic*              → <i>italic</i>
// - ~~strike~~            → <s>strike</s>
// - `code`                → <code>code</code>
// - ```block```           → <pre>block</pre>
// - [label](url)          → <a href="url">label</a>
// - > blockquote          → <blockquote>text</blockquote>
// - HTML entities escaped: & < >
//
// Code blocks are passed through with entity escaping only (no other transforms).

/** Escape HTML entities in text */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert Markdown text to Telegram-compatible HTML.
 * Processes line-by-line, respecting fenced code blocks.
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text || typeof text !== 'string') return '';

  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeLines: string[] = [];
  let inBlockquote = false;
  let blockquoteLines: string[] = [];

  const flushBlockquote = () => {
    if (blockquoteLines.length > 0) {
      result.push(`<blockquote>${blockquoteLines.join('\n')}</blockquote>`);
      blockquoteLines = [];
      inBlockquote = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // Track fenced code blocks
    if (/^```/.test(trimmed)) {
      if (!inCodeBlock) {
        flushBlockquote();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        // Close code block
        const escaped = codeLines.map(l => escapeHtml(l)).join('\n');
        if (codeBlockLang && codeBlockLang !== 'mermaid') {
          result.push(`<pre><code class="language-${escapeHtml(codeBlockLang)}">${escaped}</code></pre>`);
        } else {
          result.push(`<pre>${escaped}</pre>`);
        }
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
      inBlockquote = true;
      blockquoteLines.push(convertInline(bqMatch[1]));
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    let line = lines[i];

    // Headers: # Header → <b>Header</b>
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line.trimStart());
    if (headerMatch) {
      result.push(`<b>${convertInline(headerMatch[2].trim())}</b>`);
      continue;
    }

    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      result.push('———');
      continue;
    }

    // Bullet lists: "- item" or "* item" → "• item"
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      result.push(`${indent}• ${convertInline(bulletMatch[3])}`);
      continue;
    }

    // Numbered lists: preserve as-is but convert inline
    const numMatch = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
    if (numMatch) {
      result.push(`${numMatch[1]}${numMatch[2]} ${convertInline(numMatch[3])}`);
      continue;
    }

    // Regular line: apply inline conversions
    result.push(convertInline(line));
  }

  // Close any unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    const escaped = codeLines.map(l => escapeHtml(l)).join('\n');
    result.push(`<pre>${escaped}</pre>`);
  }
  flushBlockquote();

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
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // Escape HTML in non-code portions
  processed = escapeHtml(processed);

  // Images: ![alt](url) → (just show as link)
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt: string, url: string) => `<a href="${url}">${alt || 'image'}</a>`,
  );

  // Links: [label](url) → <a href="url">label</a>
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  // Bold: **text** or __text__ → <b>text</b>
  processed = processed.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__([^_]+)__/g, '<b>$1</b>');

  // Italic: *text* → <i>text</i> (but not inside bold)
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~ → <s>text</s>
  processed = processed.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // Restore code spans
  processed = processed.replace(/\x00CODE(\d+)\x00/g, (_m, idx: string) => codeSpans[parseInt(idx)]);

  return processed;
}

/**
 * Chunk text into segments no larger than limit, splitting at newlines.
 * Respects code block boundaries where possible.
 */
export function chunkText(text: string, limit: number = 4096): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > limit) {
      if (current) {
        chunks.push(current);
        current = line;
      } else {
        // Single line exceeds limit — force split
        let remaining = line;
        while (remaining.length > limit) {
          chunks.push(remaining.slice(0, limit));
          remaining = remaining.slice(limit);
        }
        current = remaining;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

/**
 * Main entry point: convert Markdown to Telegram HTML.
 */
export function formatTelegramText(text: string): string {
  return markdownToTelegramHtml(text);
}
