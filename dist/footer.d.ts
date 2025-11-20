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
export declare function generateFooter(options?: FooterOptions): string;
/**
 * Check if a string contains a Visor footer
 */
export declare function hasVisorFooter(text: string): boolean;
