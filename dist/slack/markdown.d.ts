/**
 * Represents an extracted mermaid diagram
 */
export interface MermaidDiagram {
    /** The full match including ```mermaid and ``` */
    fullMatch: string;
    /** The mermaid code content */
    code: string;
    /** Start index in the original text */
    startIndex: number;
    /** End index in the original text */
    endIndex: number;
}
/**
 * Extract all mermaid code blocks from text
 */
export declare function extractMermaidDiagrams(text: string): MermaidDiagram[];
/**
 * Render a mermaid diagram to PNG using mmdc CLI (@mermaid-js/mermaid-cli).
 *
 * Requirements:
 * - Node.js and npx must be available in PATH
 * - Network access on first run (npx downloads the package)
 * - Puppeteer/Chromium dependencies (mermaid-cli uses headless browser)
 *
 * On Linux, you may need to install chromium dependencies:
 *   apt-get install -y chromium-browser libatk-bridge2.0-0 libgtk-3-0
 *
 * On Docker/CI, consider using a base image with puppeteer support or
 * pre-installing @mermaid-js/mermaid-cli globally.
 *
 * @param mermaidCode The mermaid diagram code
 * @returns Buffer containing PNG data, or null if rendering failed
 */
export declare function renderMermaidToPng(mermaidCode: string): Promise<Buffer | null>;
/**
 * Replace mermaid blocks in text with a placeholder message
 * @param text Original text
 * @param diagrams Extracted diagrams
 * @param replacement Text to replace each diagram with (or a function that returns replacement for each index)
 */
export declare function replaceMermaidBlocks(text: string, diagrams: MermaidDiagram[], replacement?: string | ((index: number) => string)): string;
export declare function markdownToSlack(text: string): string;
export declare function formatSlackText(text: string): string;
//# sourceMappingURL=markdown.d.ts.map