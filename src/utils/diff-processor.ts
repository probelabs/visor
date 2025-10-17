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

  try {
    // Set PROBE_PATH to use the bundled binary with outline-diff support
    // The SDK by default may download an older binary that doesn't support outline-diff
    const originalProbePath = process.env.PROBE_PATH;
    const probeBinaryPath = path.join(
      __dirname,
      '../..',
      'node_modules/@probelabs/probe/bin/probe-binary'
    );

    // Only process if binary exists, otherwise fall back to original diff
    const fs = require('fs');
    if (!fs.existsSync(probeBinaryPath)) {
      if (process.env.DEBUG === '1' || process.env.VERBOSE === '1') {
        console.error('Probe binary not found at:', probeBinaryPath);
      }
      return diffContent;
    }

    process.env.PROBE_PATH = probeBinaryPath;

    // Use extract with content parameter (can be string or Buffer)
    // The TypeScript types haven't been updated yet, but the runtime supports it
    const result = await (extract as any)({
      content: diffContent,
      format: 'outline-diff',
      allowTests: true, // Allow test files and test code blocks in extraction results
    });

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
