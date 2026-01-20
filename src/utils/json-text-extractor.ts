/**
 * Utility for extracting text content from JSON-like output.
 *
 * When AI models return structured JSON with text/response/message fields,
 * but template rendering fails to unwrap them, this utility provides a
 * fallback to extract the actual text content.
 */

/**
 * Extract text/response/message field from malformed JSON-like string using regex.
 * Handles cases where AI returns incomplete JSON like:
 * {"text": "content here...\n\n## More content" (missing closing brace)
 *
 * @param content - The malformed JSON-like string
 * @returns The extracted text content, or undefined if not found
 */
function extractTextFieldFromMalformedJson(content: string): string | undefined {
  // Try to match "text", "response", or "message" field at the start of JSON
  // Pattern: {"text": "..." or { "text": "..." (with optional whitespace)
  // The value can be a quoted string that we need to extract

  // First, try to find a field like "text": "value" or "text": value
  // We look for the field name followed by : and then extract everything after
  const fieldPatterns = [
    /^\s*\{\s*"text"\s*:\s*"/i,
    /^\s*\{\s*"response"\s*:\s*"/i,
    /^\s*\{\s*"message"\s*:\s*"/i,
  ];

  for (const pattern of fieldPatterns) {
    const match = pattern.exec(content);
    if (match) {
      // Found a field, extract the value starting after the opening quote
      const valueStart = match[0].length;
      const remaining = content.substring(valueStart);

      // Try to find the end of the string value by looking for unescaped quotes
      // Handle escaped quotes (\") within the string
      let value = '';
      let i = 0;
      while (i < remaining.length) {
        const char = remaining[i];
        if (char === '\\' && i + 1 < remaining.length) {
          // Escape sequence - handle common ones
          const nextChar = remaining[i + 1];
          if (nextChar === 'n') {
            value += '\n';
          } else if (nextChar === 'r') {
            value += '\r';
          } else if (nextChar === 't') {
            value += '\t';
          } else if (nextChar === '"') {
            value += '"';
          } else if (nextChar === '\\') {
            value += '\\';
          } else {
            // Unknown escape, keep as-is
            value += char + nextChar;
          }
          i += 2;
        } else if (char === '"') {
          // End of string value (unescaped quote)
          break;
        } else {
          value += char;
          i++;
        }
      }

      // If we extracted something meaningful, return it
      if (value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return undefined;
}

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
      // JSON parsing failed - try to extract text field using regex
      // This handles malformed JSON like: {"text": "content...\n\n## More content" (missing closing brace)
      const extracted = extractTextFieldFromMalformedJson(trimmed);
      if (extracted) {
        return extracted;
      }
      // Couldn't extract, return as-is
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
