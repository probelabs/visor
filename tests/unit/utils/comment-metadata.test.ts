import {
  parseVisorThreadMetadata,
  shouldFilterVisorReviewComment,
} from '../../../src/utils/comment-metadata';

describe('comment-metadata utils', () => {
  describe('parseVisorThreadMetadata', () => {
    it('should parse valid visor:thread metadata', () => {
      const commentBody = `<!-- visor:thread={"key":"owner/repo#123","runId":"abc","group":"review","generatedAt":"2025-11-20T18:13:06.218Z"} -->
Some comment content`;

      const metadata = parseVisorThreadMetadata(commentBody);
      expect(metadata).toEqual({
        key: 'owner/repo#123',
        runId: 'abc',
        group: 'review',
        generatedAt: '2025-11-20T18:13:06.218Z',
      });
    });

    it('should return null for comment without visor:thread metadata', () => {
      const commentBody = 'Regular comment without metadata';
      const metadata = parseVisorThreadMetadata(commentBody);
      expect(metadata).toBeNull();
    });

    it('should return null for malformed JSON', () => {
      const commentBody = '<!-- visor:thread={invalid json} -->';
      const metadata = parseVisorThreadMetadata(commentBody);
      expect(metadata).toBeNull();
    });

    it('should handle metadata with various whitespace', () => {
      const commentBody = `<!--   visor:thread={"group":"overview"}   -->`;
      const metadata = parseVisorThreadMetadata(commentBody);
      expect(metadata).toEqual({ group: 'overview' });
    });

    it('should return null for non-object JSON', () => {
      const commentBody = '<!-- visor:thread=["array","not","object"] -->';
      const metadata = parseVisorThreadMetadata(commentBody);
      expect(metadata).toBeNull();
    });
  });

  describe('shouldFilterVisorReviewComment', () => {
    it('should filter old format review comments', () => {
      const commentBody =
        '<!-- visor-comment-id:pr-review-244-review -->\n## Code Review\nSome review content';
      expect(shouldFilterVisorReviewComment(commentBody)).toBe(true);
    });

    it('should filter new format review comments with group="review"', () => {
      const commentBody = `<!-- visor-comment-id:visor-thread-review-owner/repo#299 -->
<!-- visor:thread={"key":"owner/repo#299","runId":"abc123","group":"review","generatedAt":"2025-11-20T18:13:06.218Z"} -->
## Security Review
Found 3 security issues...`;

      expect(shouldFilterVisorReviewComment(commentBody)).toBe(true);
    });

    it('should NOT filter visor comments with group="overview"', () => {
      const commentBody = `<!-- visor-comment-id:visor-thread-overview-owner/repo#299 -->
<!-- visor:thread={"key":"owner/repo#299","runId":"abc123","group":"overview","generatedAt":"2025-11-20T18:10:00.000Z"} -->
## Overview
General PR summary...`;

      expect(shouldFilterVisorReviewComment(commentBody)).toBe(false);
    });

    it('should NOT filter regular user comments', () => {
      const commentBody = 'This is a regular user comment without any visor metadata';
      expect(shouldFilterVisorReviewComment(commentBody)).toBe(false);
    });

    it('should handle undefined comment body', () => {
      expect(shouldFilterVisorReviewComment(undefined)).toBe(false);
    });

    it('should handle empty string', () => {
      expect(shouldFilterVisorReviewComment('')).toBe(false);
    });

    it('should gracefully handle malformed JSON in new format', () => {
      const commentBody = `<!-- visor:thread={invalid json here} -->
## Malformed Metadata
Should NOT be filtered since JSON parse fails`;

      // When JSON parsing fails, we fall back to NOT filtering (safe default)
      expect(shouldFilterVisorReviewComment(commentBody)).toBe(false);
    });

    it('should filter if EITHER old or new format matches', () => {
      // Comment with both old format marker (should trigger filter)
      const commentBody1 = `<!-- visor-comment-id:pr-review-123-review -->
<!-- visor:thread={"group":"overview"} -->
Content`;
      expect(shouldFilterVisorReviewComment(commentBody1)).toBe(true);

      // Comment with new format group="review" (should trigger filter)
      const commentBody2 = `<!-- visor-comment-id:visor-thread-overview-123 -->
<!-- visor:thread={"group":"review"} -->
Content`;
      expect(shouldFilterVisorReviewComment(commentBody2)).toBe(true);
    });
  });
});
