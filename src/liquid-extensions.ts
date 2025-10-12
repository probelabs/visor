import { Liquid, TagToken, Context, TopLevelToken, Tag, Value, Emitter } from 'liquidjs';
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

  // Register author permission filters
  // These filters check PR author's permission level
  const isLocal = detectLocalMode();

  liquid.registerFilter('has_min_permission', (authorAssociation: string, level: string) => {
    return hasMinPermission(authorAssociation, level as any, isLocal);
  });

  liquid.registerFilter('is_owner', (authorAssociation: string) => {
    return isOwner(authorAssociation, isLocal);
  });

  liquid.registerFilter('is_member', (authorAssociation: string) => {
    return isMember(authorAssociation, isLocal);
  });

  liquid.registerFilter('is_collaborator', (authorAssociation: string) => {
    return isCollaborator(authorAssociation, isLocal);
  });

  liquid.registerFilter('is_contributor', (authorAssociation: string) => {
    return isContributor(authorAssociation, isLocal);
  });

  liquid.registerFilter('is_first_timer', (authorAssociation: string) => {
    return isFirstTimer(authorAssociation, isLocal);
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
    return memoryStore.has(key, namespace);
  });

  liquid.registerFilter('memory_list', (namespace?: string) => {
    return memoryStore.list(namespace);
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
