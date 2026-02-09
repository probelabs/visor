// eslint-disable-next-line no-restricted-imports -- this is the extensions file that wraps liquidjs
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
import { createSecureSandbox, compileAndRun } from './utils/sandbox';

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

    // Security: Resolve path relative to basePath (from context) or project root
    // basePath can be passed via context globals for loadConfig scenarios
    const basePath = (ctx.globals as Record<string, unknown>)?.basePath;
    const projectRoot = typeof basePath === 'string' ? basePath : process.cwd();
    const resolvedPath = path.resolve(projectRoot, filePath.toString());

    // Ensure the resolved path is within the allowed directory
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

  // Register base64 filter for encoding strings
  // Usage: {{ "user:password" | base64 }}
  liquid.registerFilter('base64', (value: unknown) => {
    if (value == null) return '';
    const str = String(value);
    return Buffer.from(str).toString('base64');
  });

  // Register base64_decode filter for decoding base64 strings
  // Usage: {{ encoded_value | base64_decode }}
  liquid.registerFilter('base64_decode', (value: unknown) => {
    if (value == null) return '';
    const str = String(value);
    try {
      return Buffer.from(str, 'base64').toString('utf-8');
    } catch {
      return '[Error: Invalid base64 string]';
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

  // JSON escape filter - escapes a string for use inside a JSON string value
  // This escapes special characters like quotes, backslashes, and control characters
  // Usage: "jql": "{{ myValue | json_escape }}"
  liquid.registerFilter('json_escape', (value: unknown) => {
    if (value == null) return '';
    const s = String(value);
    // Use JSON.stringify which handles all escaping, then strip the surrounding quotes
    const jsonStr = JSON.stringify(s);
    // Remove the first and last character (the quotes added by JSON.stringify)
    return jsonStr.slice(1, -1);
  });

  // Shell escape filter - wraps value in single quotes with proper escaping
  // Usage: {{ value | shell_escape }}
  // Example: "hello'world" becomes "'hello'\''world'"
  // This is POSIX-compliant and safe for arbitrary text including mermaid diagrams
  liquid.registerFilter('shell_escape', (value: unknown) => {
    if (value == null) return "''";
    const s = String(value);
    // Replace single quotes with: end quote, escaped quote, start quote
    // Then wrap the entire thing in single quotes
    return "'" + s.replace(/'/g, "'\\''") + "'";
  });

  // Alias for shell_escape
  liquid.registerFilter('escape_shell', (value: unknown) => {
    if (value == null) return "''";
    const s = String(value);
    return "'" + s.replace(/'/g, "'\\''") + "'";
  });

  // Shell escape for double quotes (less safe but sometimes needed)
  // Usage: {{ value | shell_escape_double }}
  // Escapes: $, `, \, ", and !
  liquid.registerFilter('shell_escape_double', (value: unknown) => {
    if (value == null) return '""';
    const s = String(value);
    // Escape characters that have special meaning inside double quotes
    const escaped = s
      .replace(/\\/g, '\\\\') // backslash first
      .replace(/\$/g, '\\$') // dollar sign
      .replace(/`/g, '\\`') // backticks
      .replace(/"/g, '\\"') // double quotes
      .replace(/!/g, '\\!'); // history expansion
    return '"' + escaped + '"';
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
    return Array.isArray(first) ? [] : (first ?? undefined);
  });

  // where_exp: generic expression-based filter (Shopify-style)
  // Usage: array | where_exp: 'i', 'i.is_valid != true and i.confidence != "high"'
  liquid.registerFilter('where_exp', (items: unknown, varName: string, expr: string) => {
    const arr = Array.isArray(items) ? (items as any[]) : [];
    const name = typeof varName === 'string' && varName.trim() ? varName.trim() : 'i';
    const body = String(expr || '');
    try {
      // Use sandbox for secure evaluation
      const sandbox = createSecureSandbox();
      const out: any[] = [];
      for (let idx = 0; idx < arr.length; idx++) {
        const item = arr[idx];
        let ok = false;
        try {
          const scope: Record<string, unknown> = { [name]: item, idx, arr };
          ok = !!compileAndRun<boolean>(sandbox, body, scope, {
            injectLog: false,
            wrapFunction: true,
          });
        } catch {
          ok = false;
        }
        if (ok) out.push(item);
      }
      return out;
    } catch {
      return [];
    }
  });

  // chat_history: merge outputs_history from multiple steps into a normalized,
  // timestamp-sorted chat transcript.
  //
  // Usage:
  //   {% assign history = '' | chat_history: 'ask', 'reply' %}
  //   {% for m in history %}
  //     {{ m.role }}: {{ m.text }}
  //   {% endfor %}
  //
  // Advanced usage with options:
  //   '' | chat_history: 'ask', 'reply',
  //        direction: 'desc',
  //        limit: 50,
  //        roles: { by_type: { 'human-input': 'user', 'ai': 'assistant' } },
  //        text: { default_field: 'text', by_step: { reply: 'text' } }
  liquid.registerFilter(
    'chat_history',
    function (this: unknown, value: unknown, ...args: unknown[]): unknown {
      try {
        // Access Liquid rendering context to read globals like outputs_history
        const impl = this as { context?: { get: (key: string[] | string) => unknown } } | undefined;
        const ctx = impl?.context;

        // Parse arguments: one or more step names, optional options hash as last arg
        const allArgs = Array.isArray(args) ? args : [];

        if (allArgs.length === 0) {
          return [];
        }

        // Liquid passes keyword arguments as trailing ["key", value] pairs.
        // Split positional step names from an optional options hash built from those pairs.
        const positional: unknown[] = [];
        const options: any = {};
        for (const arg of allArgs) {
          if (
            Array.isArray(arg) &&
            arg.length === 2 &&
            typeof arg[0] === 'string' &&
            arg[0].length > 0
          ) {
            options[arg[0]] = arg[1];
          } else {
            positional.push(arg);
          }
        }
        const stepArgs: unknown[] = positional;

        const steps = stepArgs.map(s => String(s ?? '').trim()).filter(s => s.length > 0);
        if (steps.length === 0) return [];

        // Resolve history source: prefer outputs_history, fall back to outputs.history
        const outputsHistoryVar = (ctx?.get(['outputs_history']) || {}) as Record<
          string,
          unknown[]
        >;
        const outputsVar = (ctx?.get(['outputs']) || {}) as { history?: Record<string, unknown[]> };
        const outputsHistory: Record<string, unknown[]> =
          outputsHistoryVar && Object.keys(outputsHistoryVar).length > 0
            ? outputsHistoryVar
            : outputsVar?.history || {};

        // Optional checks metadata: used to infer roles by check type
        const checksMeta =
          (ctx?.get(['checks_meta']) as Record<string, { type?: string; group?: string }>) ||
          ((ctx?.get(['event']) as any)?.payload?.__checksMeta as Record<
            string,
            { type?: string; group?: string }
          >) ||
          undefined;

        // Direction and limit
        const directionRaw =
          typeof options.direction === 'string' ? options.direction.toLowerCase() : '';
        const direction: 'asc' | 'desc' = directionRaw === 'desc' ? 'desc' : 'asc';
        const limit =
          typeof options.limit === 'number' && options.limit > 0
            ? Math.floor(options.limit)
            : undefined;

        // Text mapping configuration
        const textCfg = options.text && typeof options.text === 'object' ? options.text : {};
        const defaultField =
          typeof textCfg.default_field === 'string' && textCfg.default_field.trim()
            ? textCfg.default_field.trim()
            : 'text';
        const byStepText: Record<string, string> = {};
        if (textCfg.by_step && typeof textCfg.by_step === 'object') {
          for (const [k, v] of Object.entries(textCfg.by_step)) {
            if (typeof v === 'string' && v.trim()) {
              byStepText[k] = v.trim();
            }
          }
        }

        // Role mapping configuration
        const rolesCfg = options.roles && typeof options.roles === 'object' ? options.roles : {};
        const byTypeRole: Record<string, string> = {};
        if (rolesCfg.by_type && typeof rolesCfg.by_type === 'object') {
          for (const [k, v] of Object.entries(rolesCfg.by_type)) {
            if (typeof v === 'string' && v.trim()) {
              byTypeRole[k] = v.trim();
            }
          }
        }
        const byStepRole: Record<string, string> = {};
        if (rolesCfg.by_step && typeof rolesCfg.by_step === 'object') {
          for (const [k, v] of Object.entries(rolesCfg.by_step)) {
            if (typeof v === 'string' && v.trim()) {
              byStepRole[k] = v.trim();
            }
          }
        }
        // Optional: step-level role map provided as a compact string, e.g. "ask=user,reply=assistant"
        if (typeof options.role_map === 'string' && options.role_map.trim().length > 0) {
          const parts = String(options.role_map)
            .split(',')
            .map(p => p.trim())
            .filter(Boolean);
          for (const part of parts) {
            const eqIdx = part.indexOf('=');
            if (eqIdx > 0) {
              const k = part.slice(0, eqIdx).trim();
              const v = part.slice(eqIdx + 1).trim();
              if (k && v) {
                byStepRole[k] = v;
              }
            }
          }
        }
        const defaultRole =
          typeof rolesCfg.default === 'string' && rolesCfg.default.trim()
            ? rolesCfg.default.trim()
            : undefined;

        const getNested = (obj: any, path: string): unknown => {
          if (!obj || !path) return undefined;
          const parts = path.split('.');
          let cur = obj;
          for (const p of parts) {
            if (cur == null) return undefined;
            cur = cur[p];
          }
          return cur;
        };

        const normalizeText = (step: string, raw: any): string => {
          try {
            const overrideField = byStepText[step];
            if (overrideField) {
              const val = getNested(raw, overrideField);
              if (val !== undefined && val !== null) {
                const s = String(val);
                if (s.trim().length > 0) return s;
              }
            }

            if (raw && typeof raw === 'object') {
              if (typeof (raw as any).text === 'string' && (raw as any).text.trim().length > 0) {
                return (raw as any).text;
              }
              if (
                typeof (raw as any).content === 'string' &&
                (raw as any).content.trim().length > 0
              ) {
                return (raw as any).content;
              }
              const dfVal = (raw as any)[defaultField];
              if (dfVal !== undefined && dfVal !== null) {
                const s = String(dfVal);
                if (s.trim().length > 0) return s;
              }
            }

            if (typeof raw === 'string') return raw;
            if (raw == null) return '';
            try {
              return JSON.stringify(raw);
            } catch {
              return String(raw);
            }
          } catch {
            if (typeof raw === 'string') return raw;
            return '';
          }
        };

        const normalizeRole = (step: string): string => {
          try {
            if (byStepRole[step]) return byStepRole[step];
            const meta = checksMeta ? (checksMeta as any)[step] : undefined;
            const type = meta?.type as string | undefined;
            if (type && byTypeRole[type]) return byTypeRole[type];
            if (type === 'human-input') return 'user';
            if (type === 'ai') return 'assistant';
            if (defaultRole) return defaultRole;
            if (type) {
              if (type === 'human-input') return 'user';
              if (type === 'ai') return 'assistant';
            }
          } catch {
            // fall through
          }
          return 'assistant';
        };

        type ChatMessage = {
          step: string;
          role: string;
          text: string;
          ts: number;
          raw: unknown;
        };

        const messages: ChatMessage[] = [];
        const tsBase = Date.now();
        let counter = 0;

        for (const step of steps) {
          const arr = (outputsHistory as any)?.[step] as unknown[];
          if (!Array.isArray(arr)) continue;
          for (const raw of arr) {
            let ts: number | undefined;
            if (raw && typeof raw === 'object' && typeof (raw as any).ts === 'number') {
              ts = (raw as any).ts;
            }
            if (!Number.isFinite(ts as number)) {
              ts = tsBase + counter++;
            }
            const text = normalizeText(step, raw);
            const role = normalizeRole(step);
            messages.push({ step, role, text, ts: ts as number, raw });
          }
        }

        // Sort by timestamp and apply direction/limit
        messages.sort((a, b) => a.ts - b.ts);
        if (direction === 'desc') {
          messages.reverse();
        }

        if (limit && limit > 0 && messages.length > limit) {
          if (direction === 'asc') {
            return messages.slice(messages.length - limit);
          }
          return messages.slice(0, limit);
        }

        return messages;
      } catch {
        return [];
      }
    }
  );

  // Removed: merge_sort_by filter (unused)
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
