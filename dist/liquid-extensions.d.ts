import { Liquid, TagToken, Context, TopLevelToken, Tag, Emitter } from 'liquidjs';
/**
 * Sanitize label strings to only allow [A-Za-z0-9:/\- ] characters (including spaces and hyphens)
 * @param value - Label value to sanitize
 * @returns Sanitized label string
 */
export declare function sanitizeLabel(value: unknown): string;
/**
 * Sanitize an array of labels
 * @param labels - Array of label values
 * @returns Array of sanitized, non-empty label strings
 */
export declare function sanitizeLabelList(labels: unknown): string[];
/**
 * Custom ReadFile tag for Liquid templates
 * Usage: {% readfile "path/to/file.txt" %}
 * or with variable: {% readfile filename %}
 */
export declare class ReadFileTag extends Tag {
    private filepath;
    constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid);
    render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown>;
}
export declare function withPermissionsContext<T>(ctx: {
    authorAssociation?: string;
}, fn: () => Promise<T>): Promise<T>;
/**
 * Configure a Liquid instance with custom extensions
 */
export declare function configureLiquidWithExtensions(liquid: Liquid): void;
/**
 * Create a new Liquid instance with custom extensions
 */
export declare function createExtendedLiquid(options?: Record<string, unknown>): Liquid;
