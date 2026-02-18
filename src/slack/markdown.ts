// Lightweight Markdown → Slack mrkdwn formatter.
// The goal is to make common Markdown output from AI steps look natural in Slack
// without pulling in a full Markdown parser.
//
// Supported conversions:
// - # Header / ## Header  → *Header* (bold with visual separation)
// - **bold** / __bold__   → *bold*
// - [label](url)          → <url|label>
// - ![alt](url)           → <url|alt>
// - *italic* (inline)     → _italic_
// - ```mermaid blocks     → rendered to PNG and uploaded to Slack
//
// Everything else is passed through unchanged; Slack will still render many
// Markdown-like constructs (lists, code fences, etc.) natively.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Represents an extracted mermaid diagram
 */
export interface MermaidDiagram {
  /** The full match including ```mermaid and ``` */
  fullMatch: string;
  /** The mermaid code content */
  code: string;
  /** Start index in the original text */
  startIndex: number;
  /** End index in the original text */
  endIndex: number;
}

/**
 * Extract all mermaid code blocks from text
 */
export function extractMermaidDiagrams(text: string): MermaidDiagram[] {
  const diagrams: MermaidDiagram[] = [];
  // Match ```mermaid followed by newline, content, and closing ```
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    diagrams.push({
      fullMatch: match[0],
      code: match[1].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return diagrams;
}

/**
 * Render a mermaid diagram to PNG using mmdc CLI (@mermaid-js/mermaid-cli).
 *
 * Requirements:
 * - Node.js and npx must be available in PATH
 * - Network access on first run (npx downloads the package)
 * - Puppeteer/Chromium dependencies (mermaid-cli uses headless browser)
 *
 * On Linux, you may need to install chromium dependencies:
 *   apt-get install -y chromium-browser libatk-bridge2.0-0 libgtk-3-0
 *
 * On Docker/CI, consider using a base image with puppeteer support or
 * pre-installing @mermaid-js/mermaid-cli globally.
 *
 * @param mermaidCode The mermaid diagram code
 * @returns Buffer containing PNG data, or null if rendering failed
 */
export async function renderMermaidToPng(mermaidCode: string): Promise<Buffer | null> {
  // Create temp files for input and output
  const tmpDir = os.tmpdir();
  const inputFile = path.join(
    tmpDir,
    `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}.mmd`
  );
  const outputFile = path.join(
    tmpDir,
    `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  );

  try {
    // Write mermaid code to temp file
    fs.writeFileSync(inputFile, mermaidCode, 'utf-8');

    // Detect system chromium for puppeteer (mermaid-cli dependency)
    // Without this, puppeteer may hang trying to download its own chromium
    const chromiumPaths = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/chrome',
    ];
    let chromiumPath: string | undefined;
    for (const p of chromiumPaths) {
      if (fs.existsSync(p)) {
        chromiumPath = p;
        break;
      }
    }

    // Build environment with chromium path if found
    const env = { ...process.env };
    if (chromiumPath) {
      env.PUPPETEER_EXECUTABLE_PATH = chromiumPath;
    }

    // Run mmdc to render PNG
    const result = await new Promise<{ success: boolean; error?: string }>(resolve => {
      const proc = spawn(
        'npx',
        [
          '--yes',
          '@mermaid-js/mermaid-cli',
          '-i',
          inputFile,
          '-o',
          outputFile,
          '-e',
          'png',
          '-b',
          'white',
          '-w',
          '1200',
        ],
        {
          timeout: 60000, // 60 second timeout (first run may download packages)
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        }
      );

      let stderr = '';
      proc.stderr?.on('data', data => {
        stderr += data.toString();
      });

      proc.on('close', code => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr || `Exit code ${code}` });
        }
      });

      proc.on('error', err => {
        resolve({ success: false, error: err.message });
      });
    });

    if (!result.success) {
      console.warn(`Mermaid rendering failed: ${result.error}`);
      return null;
    }

    // Read the output PNG
    if (!fs.existsSync(outputFile)) {
      console.warn('Mermaid output file not created');
      return null;
    }

    const pngBuffer = fs.readFileSync(outputFile);
    return pngBuffer;
  } catch (e) {
    console.warn(`Mermaid rendering error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Replace mermaid blocks in text with a placeholder message
 * @param text Original text
 * @param diagrams Extracted diagrams
 * @param replacement Text to replace each diagram with (or a function that returns replacement for each index)
 */
export function replaceMermaidBlocks(
  text: string,
  diagrams: MermaidDiagram[],
  replacement: string | ((index: number) => string) = '_(See diagram above)_'
): string {
  if (diagrams.length === 0) return text;

  // Sort by start index descending to replace from end to start (preserves indices)
  const sorted = [...diagrams].sort((a, b) => b.startIndex - a.startIndex);

  let result = text;
  sorted.forEach((diagram, sortedIndex) => {
    // Calculate original index (since we sorted in reverse)
    const originalIndex = diagrams.length - 1 - sortedIndex;
    const rep = typeof replacement === 'function' ? replacement(originalIndex) : replacement;
    result = result.slice(0, diagram.startIndex) + rep + result.slice(diagram.endIndex);
  });

  return result;
}

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

  // Process lines for headers and bullet lists.
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

    // Headers: # Header → *Header* (Slack doesn't have native headers)
    // Match 1-6 # at start of line, followed by space and text
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headerMatch) {
      const [, hashes, headerText] = headerMatch;
      // For h1/h2, add extra emphasis with newline before (if not first line
      // and previous line is not empty/header/code-fence)
      const prevLine = i > 0 ? lines[i - 1].trim() : '';
      const prevIsHeaderOrFence =
        /^#{1,6}\s+/.test(prevLine) || /^\*[^*]+\*$/.test(prevLine) || /^```/.test(prevLine);
      if (hashes.length <= 2 && i > 0 && prevLine !== '' && !prevIsHeaderOrFence) {
        lines[i] = `\n*${headerText.trim()}*`;
      } else {
        lines[i] = `*${headerText.trim()}*`;
      }
      continue;
    }

    // Bullet lists: "- item" or "* item" → "• item" (preserve indentation)
    const bulletMatch = /^(\s*)([-*])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const [, indent, , rest] = bulletMatch;
      lines[i] = `${indent}• ${rest}`;
    }
  }
  out = lines.join('\n');

  return out;
}

/**
 * Represents an extracted file section delimited by --- filename.ext ---
 */
export interface FileSection {
  /** Full match including delimiter(s) and content */
  fullMatch: string;
  /** Extracted filename (e.g., "report.csv") */
  filename: string;
  /** Content after the opening delimiter (trimmed) */
  content: string;
  /** Start index in the original text */
  startIndex: number;
  /** End index in the original text */
  endIndex: number;
}

/**
 * Extract all file sections delimited by --- filename.ext --- from text.
 *
 * A section starts at a `--- filename.ext ---` line. It ends at:
 *   1. A closing delimiter with the same filename (optional, backward-compatible)
 *   2. The next `--- other.ext ---` delimiter (starts a new section)
 *   3. End of text
 */
export function extractFileSections(text: string): FileSection[] {
  const sections: FileSection[] = [];

  // Find all --- filename.ext --- delimiter lines
  const delimRegex = /^--- ([\w][\w.\-]*\.\w+) ---$/gm;
  const delimiters: { filename: string; start: number; end: number }[] = [];
  let m;
  while ((m = delimRegex.exec(text)) !== null) {
    delimiters.push({
      filename: m[1],
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  if (delimiters.length === 0) return sections;

  for (let i = 0; i < delimiters.length; i++) {
    const open = delimiters[i];

    // Content starts after the newline following the opening delimiter
    const contentStart =
      open.end < text.length && text[open.end] === '\n' ? open.end + 1 : open.end;

    // Section extends to the next delimiter or end of text
    const sectionEnd = i + 1 < delimiters.length ? delimiters[i + 1].start : text.length;
    const content = text.substring(contentStart, sectionEnd).trim();
    if (content.length > 0) {
      sections.push({
        fullMatch: text.substring(open.start, sectionEnd),
        filename: open.filename,
        content,
        startIndex: open.start,
        endIndex: sectionEnd,
      });
    }
  }

  return sections;
}

/**
 * Replace file sections in text with placeholder messages.
 * Uses back-to-front replacement to preserve indices (same as replaceMermaidBlocks).
 */
export function replaceFileSections(
  text: string,
  sections: FileSection[],
  replacement: string | ((index: number) => string) = idx =>
    `_(See file: ${sections[idx].filename} above)_`
): string {
  if (sections.length === 0) return text;

  const sorted = [...sections].sort((a, b) => b.startIndex - a.startIndex);

  let result = text;
  sorted.forEach((section, sortedIndex) => {
    const originalIndex = sections.length - 1 - sortedIndex;
    const rep = typeof replacement === 'function' ? replacement(originalIndex) : replacement;
    result = result.slice(0, section.startIndex) + rep + result.slice(section.endIndex);
  });

  return result;
}

export function formatSlackText(text: string): string {
  return markdownToSlack(text);
}
