// Lightweight Markdown → Slack mrkdwn formatter.
// The goal is to make common Markdown output from AI steps look natural in Slack
// without pulling in a full Markdown parser.
//
// Supported conversions:
// - **bold** / __bold__   → *bold*
// - [label](url)          → <url|label>
// - ![alt](url)           → <url|alt>
// - *italic* (inline)     → _italic_
//
// Everything else is passed through unchanged; Slack will still render many
// Markdown-like constructs (lists, code fences, etc.) natively.

export function markdownToSlack(text: string): string {
  if (!text || typeof text !== 'string') return '';

  let out = text;

  // Images: ![alt](url) → <url|alt>
  // We intentionally keep only the URL + alt text; Slack will usually unfurl.
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt: string, url: string) => `<${url}|${alt || 'image'}>`
  );

  // Links: [label](url) → <url|label>
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label: string, url: string) => `<${url}|${label}>`
  );

  // Bold: **text** or __text__ → *text*
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => `*${inner}*`);
  out = out.replace(/__([^_]+)__/g, (_m, inner: string) => `*${inner}*`);

  // Bullet lists: "- item" or "* item" → "• item" (preserve indentation).
  // Slack's mrkdwn handles "•" bullets more naturally than raw "-" Markdown.
  const lines = out.split(/\r?\n/);
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    // Track fenced code blocks and avoid rewriting inside them
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (match) {
      const [, indent, , rest] = match;
      lines[i] = `${indent}• ${rest}`;
    }
  }
  out = lines.join('\n');

  return out;
}

export function formatSlackText(text: string): string {
  return markdownToSlack(text);
}
