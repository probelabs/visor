import { Liquid, TagToken, Context, TopLevelToken, Tag, Value, Emitter } from 'liquidjs';
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs/promises';
import path from 'path';
import {
  hasMinPermission,
  isOwner,
  isMember,
  isCollaborator,
  isContributor,
  isFirstTimer,
  detectLocalMode,
} from './utils/author-permissions';
import { MemoryStore } from './memory-store';

/**
 * Sanitize label strings to only allow [A-Za-z0-9:/\- ] characters (including spaces and hyphens)
 * @param value - Label value to sanitize
 * @returns Sanitized label string
 */
export function sanitizeLabel(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  // Keep only alphanumerics, colon, slash, hyphen, and space; collapse repeated slashes and trim
  return s
    .replace(/[^A-Za-z0-9:\/\- ]/g, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

/**
 * Sanitize an array of labels
 * @param labels - Array of label values
 * @returns Array of sanitized, non-empty label strings
 */
export function sanitizeLabelList(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return (labels as unknown[]).map(v => sanitizeLabel(v)).filter(s => s.length > 0);
}

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

// Async-local permissions context for filters (per-render)
const permissionsALS = new AsyncLocalStorage<{ authorAssociation?: string }>();

export async function withPermissionsContext<T>(
  ctx: { authorAssociation?: string },
  fn: () => Promise<T>
): Promise<T> {
  return await permissionsALS.run(ctx, fn as any);
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
  liquid.registerFilter('safe_label', (value: unknown) => sanitizeLabel(value));

  // Sanitize an array of labels
  liquid.registerFilter('safe_label_list', (value: unknown) => sanitizeLabelList(value));

  // Convert literal escape sequences (e.g., "\n") into actual newlines
  liquid.registerFilter('unescape_newlines', (value: unknown) => {
    if (value == null) return '';
    const s = String(value);
    return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  });

  // Register author permission filters (from main)
  // These filters check the author's permission level; detect local mode for tests
  const isLocal = detectLocalMode();

  const resolveAssoc = (val: unknown): string | undefined => {
    if (typeof val === 'string' && val.length > 0) return val;
    const store = permissionsALS.getStore();
    return store?.authorAssociation;
  };

  liquid.registerFilter('has_min_permission', (authorAssociation: unknown, level: string) => {
    return hasMinPermission(resolveAssoc(authorAssociation), level as any, isLocal);
  });

  liquid.registerFilter('is_owner', (authorAssociation: unknown) => {
    return isOwner(resolveAssoc(authorAssociation), isLocal);
  });

  liquid.registerFilter('is_member', (authorAssociation: unknown) => {
    return isMember(resolveAssoc(authorAssociation), isLocal);
  });

  liquid.registerFilter('is_collaborator', (authorAssociation: unknown) => {
    return isCollaborator(resolveAssoc(authorAssociation), isLocal);
  });

  liquid.registerFilter('is_contributor', (authorAssociation: unknown) => {
    return isContributor(resolveAssoc(authorAssociation), isLocal);
  });

  liquid.registerFilter('is_first_timer', (authorAssociation: unknown) => {
    return isFirstTimer(resolveAssoc(authorAssociation), isLocal);
  });

  // Register memory filters for accessing memory store
  const memoryStore = MemoryStore.getInstance();

  liquid.registerFilter('memory_get', (key: string, namespace?: string) => {
    if (typeof key !== 'string') {
      return undefined;
    }
    return memoryStore.get(key, namespace);
  });

  liquid.registerFilter('memory_has', (key: string, namespace?: string) => {
    if (typeof key !== 'string') {
      return false;
    }
    const has = memoryStore.has(key, namespace);
    try {
      if (process.env.VISOR_DEBUG === 'true' && key === 'fact_validation_issues') {
        console.error(
          `[liquid] memory_has('${key}', ns='${namespace || memoryStore.getDefaultNamespace()}') => ${String(
            has
          )}`
        );
      }
    } catch {}
    return has;
  });

  liquid.registerFilter('memory_list', (namespace?: string) => {
    return memoryStore.list(namespace);
  });

  // Generic helpers to radically simplify templates

  // get: safe nested access using dot-path (e.g., obj | get: 'a.b.c')
  liquid.registerFilter('get', (obj: any, pathExpr: unknown) => {
    if (obj == null) return undefined;
    const path = typeof pathExpr === 'string' ? pathExpr : String(pathExpr || '');
    if (!path) return obj;
    const parts = path.split('.');
    let cur: any = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p as keyof typeof cur];
    }
    return cur;
  });

  // not_empty: true when value is a non-empty array/string/object with keys
  liquid.registerFilter('not_empty', (v: unknown) => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.length > 0;
    if (v && typeof v === 'object') return Object.keys(v as object).length > 0;
    return false;
  });

  // coalesce: pick first argument (value or candidates) that is a non-empty array/object/string
  // Usage: a | coalesce: b, c, d
  liquid.registerFilter('coalesce', (first: unknown, ...rest: unknown[]) => {
    const all = [first, ...rest];
    for (const v of all) {
      if (Array.isArray(v) && v.length > 0) return v;
      if (typeof v === 'string' && v.length > 0) return v;
      if (v && typeof v === 'object' && Object.keys(v as object).length > 0) return v;
    }
    return Array.isArray(first) ? [] : first ?? undefined;
  });

  // issues_filter: convenience to keep only invalid or low-confidence validations
  // issues | issues_filter: 'invalid_or_low'
  liquid.registerFilter('issues_filter', (items: unknown, mode: string) => {
    const arr = Array.isArray(items) ? (items as any[]) : [];
    if (mode === 'invalid_or_low') {
      return arr.filter(
        i => !(i?.is_valid === true && (i?.confidence === 'high' || i?.confidence === 'HIGH'))
      );
    }
    if (mode === 'invalid') return arr.filter(i => i?.is_valid === false);
    return arr;
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
