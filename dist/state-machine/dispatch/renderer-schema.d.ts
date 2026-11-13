/**
 * Load a built-in JSON Schema for a named renderer (e.g., "code-review",
 * "issue-assistant", "overview", "plain"). Returns undefined when not found.
 *
 * Mirrors template resolution in template-renderer.ts, but targets schema.json.
 */
export declare function loadRendererSchema(name: string): Promise<any | undefined>;
//# sourceMappingURL=renderer-schema.d.ts.map