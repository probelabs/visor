/**
 * Convert Markdown text to Teams-compatible format.
 * Teams renders standard Markdown, so this is mostly a passthrough.
 * Strips any raw HTML tags that might leak from AI output.
 */
export declare function markdownToTeams(text: string): string;
/**
 * Chunk text into segments no larger than limit, splitting at newlines.
 */
export declare function chunkText(text: string, limit?: number): string[];
/**
 * Main entry point: convert Markdown to Teams format.
 */
export declare function formatTeamsText(text: string): string;
//# sourceMappingURL=markdown.d.ts.map