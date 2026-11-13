/**
 * Utility for extracting text content from JSON-like output.
 *
 * When AI models return structured JSON with text/response/message fields,
 * but template rendering fails to unwrap them, this utility provides a
 * fallback to extract the actual text content.
 */
/**
 * Extract text from a JSON-like object or JSON string.
 * If the input is a string that looks like JSON with a text/response/message field,
 * extracts and returns that field. Otherwise returns the original content.
 *
 * @param content - The content to extract text from (can be string, object, or any)
 * @returns The extracted text, or undefined if no content
 */
export declare function extractTextFromJson(content: unknown): string | undefined;
//# sourceMappingURL=json-text-extractor.d.ts.map