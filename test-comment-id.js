// Test comment ID collision detection
const body1 = `<!-- visor-comment-id:visor-config-review-7-pr-overview -->
Content here
---
*Last updated: 2025-09-11T17:30:00.000Z | Triggered by: visor-config-synchronize*
<!-- /visor-comment-id:visor-config-review-7-pr-overview -->`;

const body2 = `<!-- visor-comment-id:visor-config-review-7-code-review -->
Content here  
---
*Last updated: 2025-09-11T17:30:00.000Z | Triggered by: visor-config-synchronize*
<!-- /visor-comment-id:visor-config-review-7-code-review -->`;

function isVisorComment(body, commentId) {
  if (commentId) {
    // Check for the new format with exact matching - look for the exact ID followed by space or -->
    if (
      body.includes(`visor-comment-id:${commentId} `) ||
      body.includes(`visor-comment-id:${commentId}-->`)
    ) {
      return true;
    }
  }
  return false;
}

console.log('Testing comment ID detection:');
console.log('');

console.log('Test 1: pr-overview comment with pr-overview ID');
console.log('Expected: true, Actual:', isVisorComment(body1, 'visor-config-review-7-pr-overview'));

console.log('Test 2: pr-overview comment with code-review ID');
console.log('Expected: false, Actual:', isVisorComment(body1, 'visor-config-review-7-code-review'));

console.log('Test 3: code-review comment with code-review ID');
console.log('Expected: true, Actual:', isVisorComment(body2, 'visor-config-review-7-code-review'));

console.log('Test 4: code-review comment with pr-overview ID');
console.log('Expected: false, Actual:', isVisorComment(body2, 'visor-config-review-7-pr-overview'));