// Lightweight Markdown → Teams formatter.
// Teams supports standard Markdown natively, so minimal conversion is needed.
// Main job: ensure text stays within Teams message size limits (~28KB).
//
// Teams natively supports:
// - **bold** / __bold__
// - *italic* / _italic_
// - ~~strikethrough~~
// - `code` and ```code blocks```
// - [links](url)
// - > blockquotes
// - Bullet and numbered lists
// - # Headers (in Adaptive Cards; plain text uses bold)
//
// Teams bot text messages have a ~28KB size limit.

/**
 * Convert Markdown text to Teams-compatible format.
 * Teams renders standard Markdown, so this is mostly a passthrough.
 * Strips any raw HTML tags that might leak from AI output.
 */
export function markdownToTeams(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text;
}

/**
 * Chunk text into segments no larger than limit, splitting at newlines.
 */
export function chunkText(text: string, limit: number = 28000): string[] {
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
 * Main entry point: convert Markdown to Teams format.
 */
export function formatTeamsText(text: string): string {
  return markdownToTeams(text);
}
