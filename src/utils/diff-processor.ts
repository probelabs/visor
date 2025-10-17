import { extract } from '@probelabs/probe';
import * as path from 'path';

/**
 * Process diff content using the outline-diff format from @probelabs/probe
 * This extracts a structured outline from the diff without requiring a temporary file
 */
export async function processDiffWithOutline(diffContent: string): Promise<string> {
  if (!diffContent || diffContent.trim().length === 0) {
    return diffContent;
  }

  // Temporarily disable outline-diff processing to avoid CI issues
  // TODO: Re-enable once probe SDK binary caching issue is fixed
  // See PROBE_BINARY_CACHE_ISSUE.md for details
  if (process.env.ENABLE_OUTLINE_DIFF !== '1') {
    return diffContent;
  }

  try {
    // Set PROBE_PATH to use the bundled binary with outline-diff support
    // The SDK by default may download an older binary that doesn't support outline-diff
    const originalProbePath = process.env.PROBE_PATH;

    // Try multiple possible locations for the probe binary
    // When bundled with ncc, __dirname may not be reliable
    const fs = require('fs');
    const possiblePaths = [
      // Relative to current working directory (most common in production)
      path.join(process.cwd(), 'node_modules/@probelabs/probe/bin/probe-binary'),
      // Relative to __dirname (for unbundled development)
      path.join(__dirname, '../..', 'node_modules/@probelabs/probe/bin/probe-binary'),
      // Relative to dist directory (for bundled CLI)
      path.join(__dirname, 'node_modules/@probelabs/probe/bin/probe-binary'),
    ];

    let probeBinaryPath: string | undefined;
    for (const candidatePath of possiblePaths) {
      if (fs.existsSync(candidatePath)) {
        probeBinaryPath = candidatePath;
        break;
      }
    }

    // Only process if binary exists, otherwise fall back to original diff
    if (!probeBinaryPath) {
      if (process.env.DEBUG === '1' || process.env.VERBOSE === '1') {
        console.error('Probe binary not found. Tried:', possiblePaths);
      }
      return diffContent;
    }

    process.env.PROBE_PATH = probeBinaryPath;

    // Use extract with content parameter (can be string or Buffer)
    // The TypeScript types haven't been updated yet, but the runtime supports it
    // Add timeout to avoid hanging
    const extractPromise = (extract as any)({
      content: diffContent,
      format: 'outline-diff',
      allowTests: true, // Allow test files and test code blocks in extraction results
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Extract timeout after 30s')), 30000);
    });

    const result = await Promise.race([extractPromise, timeoutPromise]);

    // Restore original PROBE_PATH
    if (originalProbePath !== undefined) {
      process.env.PROBE_PATH = originalProbePath;
    } else {
      delete process.env.PROBE_PATH;
    }

    // Return the processed outline diff
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (error) {
    // If outline-diff processing fails, fall back to the original diff
    // Use console.error instead of console.warn to avoid polluting JSON output
    if (process.env.DEBUG === '1' || process.env.VERBOSE === '1') {
      console.error('Failed to process diff with outline-diff format:', error);
    }
    return diffContent;
  }
}
