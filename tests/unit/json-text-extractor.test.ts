import { extractTextFromJson } from '../../src/utils/json-text-extractor';

describe('extractTextFromJson', () => {
  describe('valid JSON', () => {
    it('extracts text field from valid JSON string', () => {
      const json = '{"text": "Hello world", "tags": {"label": "feature"}}';
      expect(extractTextFromJson(json)).toBe('Hello world');
    });

    it('extracts response field from valid JSON string', () => {
      const json = '{"response": "Hello world"}';
      expect(extractTextFromJson(json)).toBe('Hello world');
    });

    it('extracts message field from valid JSON string', () => {
      const json = '{"message": "Hello world"}';
      expect(extractTextFromJson(json)).toBe('Hello world');
    });

    it('extracts text field from object', () => {
      const obj = { text: 'Hello world', tags: { label: 'feature' } };
      expect(extractTextFromJson(obj)).toBe('Hello world');
    });

    it('prefers text over response over message', () => {
      const json = '{"text": "txt", "response": "resp", "message": "msg"}';
      expect(extractTextFromJson(json)).toBe('txt');
    });
  });

  describe('malformed JSON', () => {
    it('extracts text from JSON missing closing brace', () => {
      const malformed = '{\n"text": "This PR introduces support for mTLS modes...';
      expect(extractTextFromJson(malformed)).toBe('This PR introduces support for mTLS modes...');
    });

    it('extracts text from JSON with markdown content and missing closing brace', () => {
      const malformed = `{
"text": "This PR introduces support for two distinct Mutual TLS (mTLS) modes.

## Files Changed Analysis

The changes are centered around the product configuration...`;
      const result = extractTextFromJson(malformed);
      expect(result).toContain('This PR introduces support for two distinct Mutual TLS');
      expect(result).toContain('## Files Changed Analysis');
      expect(result).not.toContain('{');
      expect(result).not.toContain('"text":');
    });

    it('extracts text with escaped newlines', () => {
      const malformed = '{"text": "Line 1\\nLine 2\\nLine 3';
      expect(extractTextFromJson(malformed)).toBe('Line 1\nLine 2\nLine 3');
    });

    it('extracts text with escaped quotes', () => {
      const malformed = '{"text": "She said \\"hello\\"';
      expect(extractTextFromJson(malformed)).toBe('She said "hello"');
    });

    it('extracts response field from malformed JSON', () => {
      const malformed = '{"response": "Some response content';
      expect(extractTextFromJson(malformed)).toBe('Some response content');
    });

    it('extracts message field from malformed JSON', () => {
      const malformed = '{"message": "Some message content';
      expect(extractTextFromJson(malformed)).toBe('Some message content');
    });

    it('handles whitespace variations', () => {
      const malformed = '{  "text"  :  "Content here';
      expect(extractTextFromJson(malformed)).toBe('Content here');
    });
  });

  describe('non-JSON content', () => {
    it('returns plain text as-is', () => {
      expect(extractTextFromJson('Hello world')).toBe('Hello world');
    });

    it('returns markdown as-is', () => {
      const markdown = '## Title\n\nSome content';
      expect(extractTextFromJson(markdown)).toBe('## Title\n\nSome content');
    });

    it('returns undefined for null', () => {
      expect(extractTextFromJson(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(extractTextFromJson(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(extractTextFromJson('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only string', () => {
      expect(extractTextFromJson('   ')).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles JSON array (returns original - no text field)', () => {
      // Arrays don't have text/response/message fields, return original
      const json = '[1, 2, 3]';
      expect(extractTextFromJson(json)).toBe('[1, 2, 3]');
    });

    it('handles object without text/response/message fields (returns original)', () => {
      // When there's no text field to extract, return original JSON string as fallback
      const json = '{"foo": "bar"}';
      expect(extractTextFromJson(json)).toBe('{"foo": "bar"}');
    });

    it('handles empty text field (returns original)', () => {
      // Empty text field means we can't extract meaningful content, return original
      const json = '{"text": ""}';
      expect(extractTextFromJson(json)).toBe('{"text": ""}');
    });

    it('handles whitespace-only text field (returns original)', () => {
      // Whitespace-only text field means we can't extract meaningful content, return original
      const json = '{"text": "   "}';
      expect(extractTextFromJson(json)).toBe('{"text": "   "}');
    });
  });
});
