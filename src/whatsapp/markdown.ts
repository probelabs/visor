// Lightweight Markdown → WhatsApp formatter.
// Converts common Markdown output from AI steps to WhatsApp-compatible text.
//
// Supported conversions:
// - # Header / ## Header  → *Header*  (bold, no header support)
// - **bold** / __bold__   → *bold*
// - *italic*              → _italic_
// - ~~strike~~            → ~strike~
// - `code`                → ```code```
// - ```block```           → ```block``` (preserved)
// - [label](url)          → label (url)
// - > blockquote          → > blockquote (preserved, WhatsApp renders this)
//
// WhatsApp text messages have a 4096 character limit.

/**
 * Convert Markdown text to WhatsApp-compatible format.
 * Processes line-by-line, respecting fenced code blocks.
 */
export function markdownToWhatsApp(text: string): string {
  if (!text || typeof text !== 'string') return '';

  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // Track fenced code blocks
    if (/^```/.test(trimmed)) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        // Close code block
        result.push('```' + codeLines.join('\n') + '```');
        inCodeBlock = false;
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(lines[i]);
      continue;
    }

    const line = lines[i];

    // Headers: # Header → *Header* (bold)
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line.trimStart());
    if (headerMatch) {
      result.push(`*${convertInline(headerMatch[2].trim())}*`);
      continue;
    }

    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      result.push('---');
      continue;
    }

    // Bullet lists: "- item" or "* item" preserved
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      result.push(`${bulletMatch[1]}- ${convertInline(bulletMatch[3])}`);
      continue;
    }

    // Numbered lists: preserve as-is but convert inline
    const numMatch = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
    if (numMatch) {
      result.push(`${numMatch[1]}${numMatch[2]} ${convertInline(numMatch[3])}`);
      continue;
    }

    // Blockquotes: > text — preserved (WhatsApp renders these)
    const bqMatch = /^>\s?(.*)$/.exec(trimmed);
    if (bqMatch) {
      result.push(`> ${convertInline(bqMatch[1])}`);
      continue;
    }

    // Regular line: apply inline conversions
    result.push(convertInline(line));
  }

  // Close any unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    result.push('```' + codeLines.join('\n') + '```');
  }

  return result.join('\n');
}

/**
 * Apply inline Markdown conversions to a single line.
 */
function convertInline(line: string): string {
  // First, identify and protect inline code spans
  const codeSpans: string[] = [];
  let processed = line.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push('```' + code + '```');
    return `\x00CODE${idx}\x00`;
  });

  // Images: ![alt](url) → alt (url)
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt: string, url: string) => `${alt || 'image'} (${url})`
  );

  // Links: [label](url) → label (url)
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label: string, url: string) => `${label} (${url})`
  );

  // Bold: **text** or __text__ → *text* (protect with placeholders first)
  const boldSpans: string[] = [];
  processed = processed.replace(/\*\*([^*]+)\*\*/g, (_m, content: string) => {
    const idx = boldSpans.length;
    boldSpans.push(`*${content}*`);
    return `\x00BOLD${idx}\x00`;
  });
  processed = processed.replace(/__([^_]+)__/g, (_m, content: string) => {
    const idx = boldSpans.length;
    boldSpans.push(`*${content}*`);
    return `\x00BOLD${idx}\x00`;
  });

  // Italic: *text* → _text_ (bold already protected)
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '_$1_');

  // Strikethrough: ~~text~~ → ~text~
  processed = processed.replace(/~~([^~]+)~~/g, '~$1~');

  // Restore bold spans
  processed = processed.replace(
    /\x00BOLD(\d+)\x00/g,
    (_m, idx: string) => boldSpans[parseInt(idx)]
  );

  // Restore code spans
  processed = processed.replace(
    /\x00CODE(\d+)\x00/g,
    (_m, idx: string) => codeSpans[parseInt(idx)]
  );

  return processed;
}

/**
 * Chunk text into segments no larger than limit, splitting at newlines.
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
 * Main entry point: convert Markdown to WhatsApp format.
 */
export function formatWhatsAppText(text: string): string {
  return markdownToWhatsApp(text);
}
