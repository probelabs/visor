/** Escape HTML entities in text */
export declare function escapeHtml(text: string): string;
/**
 * Convert Markdown text to email-compatible HTML.
 * Processes line-by-line, respecting fenced code blocks.
 */
export declare function markdownToEmailHtml(text: string): string;
/**
 * Wrap body HTML in a complete email HTML template with inline CSS.
 */
export declare function wrapInEmailTemplate(bodyHtml: string): string;
/**
 * Format text as a plain-text email quote (prepend "> " to each line).
 */
export declare function formatEmailQuote(text: string): string;
/**
 * Add "Re: " prefix to subject if not already present.
 */
export declare function addRePrefix(subject: string): string;
/**
 * Main entry point: convert Markdown to email HTML body (not wrapped in template).
 */
export declare function formatEmailText(text: string): string;
//# sourceMappingURL=markdown.d.ts.map