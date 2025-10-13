# ProbeAgent Patch for Session Cloning Cache Efficiency

## Problem

When cloning ProbeAgent sessions for reuse across different checks, ProbeAgent was always adding a NEW system message at the start of the conversation, even when `this.history` already contained one. This caused two issues:

1. **Broke AI provider caching**: Claude's prompt caching relies on exact prefix matches. Adding a new system message changes the prompt prefix, invalidating the cache.
2. **Duplicate system messages**: The AI would receive two system messages, causing confusion and incorrect schema format responses.

## Solution

Modify ProbeAgent's `answer()` method to check if `this.history` already contains a system message (from a cloned session). If it does, reuse it instead of adding a new one.

## Patch Location

File: `~/conductor/repo/probe/babylon-v1/npm/src/agent/ProbeAgent.js`
Line: ~1154 (in the `answer()` method)

## Patch Content

```patch
--- a/src/agent/ProbeAgent.js
+++ b/src/agent/ProbeAgent.js
@@ -1151,10 +1151,22 @@ export class ProbeAgent {
       }

       // Initialize conversation with existing history + new user message
+      // If history already contains a system message (from session cloning), reuse it for cache efficiency
+      // Otherwise add a fresh system message
+      const hasSystemMessage = this.history.length > 0 && this.history[0].role === 'system';
+      let currentMessages;
+
+      if (hasSystemMessage) {
+        // Reuse existing system message from history for cache efficiency
+        currentMessages = [
+          ...this.history,
+          userMessage
+        ];
+        if (this.debug) {
+          console.log('[DEBUG] Reusing existing system message from history for cache efficiency');
+        }
+      } else {
+        // Add fresh system message (first call or empty history)
         currentMessages = [
           { role: 'system', content: systemMessage },
           ...this.history, // Include previous conversation history
           userMessage
         ];
+      }

       let currentIteration = 0;
```

## How to Apply

```bash
cd ~/conductor/repo/probe/babylon-v1/npm
patch -p1 < /tmp/probe-cache-fix.patch
```

Or manually edit `src/agent/ProbeAgent.js` at line 1154.

## Benefits

1. **Preserves AI provider cache**: The prompt prefix (system message + history) remains identical across cloned sessions, maximizing cache hits and reducing costs.
2. **Prevents duplicate system messages**: AI only sees one system message, preventing confusion.
3. **Maintains schema correctness**: With correct message structure, ProbeAgent's schema validation works as designed.

## Testing

After applying this patch, rebuild ProbeAgent and test with Visor's session cloning:

```bash
cd ~/conductor/repo/probe/babylon-v1/npm
npm run build
```

Then run Visor tests or GitHub Actions to verify all checks return correct schema formats.
