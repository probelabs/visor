/**
 * Convert Markdown text to WhatsApp-compatible format.
 * Processes line-by-line, respecting fenced code blocks.
 */
export declare function markdownToWhatsApp(text: string): string;
/**
 * Chunk text into segments no larger than limit, splitting at newlines.
 */
export declare function chunkText(text: string, limit?: number): string[];
/**
 * Main entry point: convert Markdown to WhatsApp format.
 */
export declare function formatWhatsAppText(text: string): string;
//# sourceMappingURL=markdown.d.ts.map