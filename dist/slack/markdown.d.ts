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
/**
 * Represents an extracted file section delimited by --- filename.ext ---
 */
export interface FileSection {
    /** Full match including delimiter(s) and content */
    fullMatch: string;
    /** Extracted filename (e.g., "report.csv") */
    filename: string;
    /** Content after the opening delimiter (trimmed) */
    content: string;
    /** Start index in the original text */
    startIndex: number;
    /** End index in the original text */
    endIndex: number;
}
/**
 * Extract all file sections delimited by --- filename.ext --- from text.
 *
 * A section starts at a `--- filename.ext ---` line. It ends at:
 *   1. A closing delimiter with the same filename (optional, backward-compatible)
 *   2. The next `--- other.ext ---` delimiter (starts a new section)
 *   3. End of text
 */
export declare function extractFileSections(text: string): FileSection[];
/**
 * Replace file sections in text with placeholder messages.
 * Uses back-to-front replacement to preserve indices (same as replaceMermaidBlocks).
 */
export declare function replaceFileSections(text: string, sections: FileSection[], replacement?: string | ((index: number) => string)): string;
export declare function formatSlackText(text: string): string;
/**
 * Chunk text into segments no larger than limit, splitting at line boundaries
 * with code-fence awareness.
 *
 * When splitting inside an active fenced code block (```lang), the current chunk
 * is cleanly closed with ``` and the next chunk reopens with ```lang so that
 * Slack does not naively split mid-code-block or leave unbalanced fences.
 */
export declare function chunkText(text: string, limit?: number): string[];
//# sourceMappingURL=markdown.d.ts.map