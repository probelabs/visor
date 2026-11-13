/** Escape HTML entities in text */
export declare function escapeHtml(text: string): string;
/**
 * Convert Markdown text to Telegram-compatible HTML.
 * Processes line-by-line, respecting fenced code blocks.
 */
export declare function markdownToTelegramHtml(text: string): string;
/**
 * Chunk text into segments no larger than limit, splitting at newlines.
 * Respects code block boundaries where possible.
 */
export declare function chunkText(text: string, limit?: number): string[];
/**
 * Main entry point: convert Markdown to Telegram HTML.
 */
export declare function formatTelegramText(text: string): string;
//# sourceMappingURL=markdown.d.ts.map