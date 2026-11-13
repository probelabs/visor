/**
 * Toolkit expansion utility.
 *
 * Expands a toolkit config's tools section into individual tool entries.
 */
/**
 * Check if an object is a toolkit reference (has a `toolkit:` key).
 */
export declare function isToolkitReference(obj: unknown): obj is {
    toolkit: string;
};
/**
 * Expand a toolkit configuration's tools section.
 * Takes the parsed toolkit file contents and returns a flat Record of tool definitions.
 * Optional overrides are merged into each expanded tool.
 */
export declare function expandToolkit(toolkitConfig: Record<string, unknown>, overrides?: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=toolkit-expander.d.ts.map