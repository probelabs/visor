import { Liquid, TagToken, Context, TopLevelToken, Tag, Value, Emitter } from 'liquidjs';
import fs from 'fs/promises';
import path from 'path';

/**
 * Custom ReadFile tag for Liquid templates
 * Usage: {% readfile "path/to/file.txt" %}
 * or with variable: {% readfile filename %}
 */
export class ReadFileTag extends Tag {
  private filepath: Value;

  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid);
    this.filepath = new Value(token.args, liquid);
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const filePath = yield this.filepath.value(ctx, false);

    // Validate the path
    if (!filePath || typeof filePath !== 'string') {
      emitter.write('[Error: Invalid file path]');
      return;
    }

    // Security: Resolve path relative to project root to prevent directory traversal
    const projectRoot = process.cwd();
    const resolvedPath = path.resolve(projectRoot, filePath.toString());

    // Ensure the resolved path is within the project directory
    if (!resolvedPath.startsWith(projectRoot)) {
      emitter.write('[Error: File path escapes project directory]');
      return;
    }

    // Read the file content
    try {
      const content = yield fs.readFile(resolvedPath, 'utf-8');
      emitter.write(content);
    } catch (error) {
      // Handle file read errors gracefully
      const errorMessage =
        error instanceof Error
          ? error.message
          : (error as NodeJS.ErrnoException)?.code || 'Unknown error';
      emitter.write(`[Error reading file: ${errorMessage}]`);
    }
  }
}

/**
 * Configure a Liquid instance with custom extensions
 */
export function configureLiquidWithExtensions(liquid: Liquid): void {
  // Register the readfile tag
  liquid.registerTag('readfile', ReadFileTag);

  // Register parse_json filter to parse JSON strings into objects
  liquid.registerFilter('parse_json', (value: string) => {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      // Return original value if parsing fails
      return value;
    }
  });

  // Register to_json filter as alias for json (for consistency)
  liquid.registerFilter('to_json', (value: unknown) => {
    try {
      return JSON.stringify(value);
    } catch {
      return '[Error: Unable to serialize to JSON]';
    }
  });

  // Sanitize a label to allowed characters only: [A-Za-z0-9:/]
  liquid.registerFilter('safe_label', (value: unknown) => {
    if (value == null) return '';
    const s = String(value);
    // Keep only alphanumerics, colon, slash; collapse repeated slashes
    return s.replace(/[^A-Za-z0-9:\/]/g, '').replace(/\/{2,}/g, '/');
  });

  // Sanitize an array of labels
  liquid.registerFilter('safe_label_list', (value: unknown) => {
    if (!Array.isArray(value)) return [] as string[];
    return (value as unknown[])
      .map(v => (v == null ? '' : String(v)))
      .map(s => s.replace(/[^A-Za-z0-9:\/]/g, '').replace(/\/{2,}/g, '/'))
      .filter(s => s.length > 0);
  });

  // Convert literal escape sequences (e.g., "\n") into actual newlines
  liquid.registerFilter('unescape_newlines', (value: unknown) => {
    if (value == null) return '';
    const s = String(value);
    return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  });
}

/**
 * Create a new Liquid instance with custom extensions
 */
export function createExtendedLiquid(options: Record<string, unknown> = {}): Liquid {
  const liquid = new Liquid({
    cache: false,
    strictFilters: false,
    strictVariables: false,
    ...options,
  });

  configureLiquidWithExtensions(liquid);
  return liquid;
}
