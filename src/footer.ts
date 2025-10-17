/**
 * Centralized footer generation for Visor comments and outputs
 */

export interface FooterOptions {
  /**
   * Include metadata like lastUpdated, triggeredBy, commitSha
   */
  includeMetadata?: {
    lastUpdated: string;
    triggeredBy: string;
    commitSha?: string;
  };
  /**
   * Include horizontal rule separator before footer
   */
  includeSeparator?: boolean;
}

/**
 * Generate a standard Visor footer with branding and optional tip
 */
export function generateFooter(options: FooterOptions = {}): string {
  const { includeMetadata, includeSeparator = true } = options;

  const parts: string[] = [];

  // Add separator
  if (includeSeparator) {
    parts.push('---');
    parts.push('');
  }

  // Add branding
  parts.push(
    '*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*'
  );

  // Add metadata if provided
  if (includeMetadata) {
    const { lastUpdated, triggeredBy, commitSha } = includeMetadata;
    const commitInfo = commitSha ? ` | Commit: ${commitSha.substring(0, 7)}` : '';
    parts.push('');
    parts.push(`*Last updated: ${lastUpdated} | Triggered by: ${triggeredBy}${commitInfo}*`);
  }

  // Add tip
  parts.push('');
  parts.push('💡 **TIP:** You can chat with Visor using `/visor ask <your question>`');

  return parts.join('\n');
}

/**
 * Check if a string contains a Visor footer
 */
export function hasVisorFooter(text: string): boolean {
  return (
    text.includes('*Powered by [Visor](https://probelabs.com/visor)') ||
    text.includes('*Powered by [Visor](https://github.com/probelabs/visor)')
  );
}
