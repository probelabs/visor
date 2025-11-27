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
export function extractTextFromJson(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;

  let parsed = content;

  // If it's a string, check if it looks like JSON
  if (typeof content === 'string') {
    const trimmed = content.trim();

    // If it doesn't look like JSON, return as-is
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return trimmed.length > 0 ? trimmed : undefined;
    }

    // Try to parse as JSON
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not valid JSON, return as-is
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }

  // Extract text field from parsed object
  if (parsed && typeof parsed === 'object') {
    const txt =
      (parsed as Record<string, unknown>).text ||
      (parsed as Record<string, unknown>).response ||
      (parsed as Record<string, unknown>).message;
    if (typeof txt === 'string' && txt.trim()) {
      return txt.trim();
    }
  }

  // If we got here with a string, return it
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}
