import { logger } from '../../logger';

/**
 * Load a built-in JSON Schema for a named renderer (e.g., "code-review",
 * "issue-assistant", "overview", "plain"). Returns undefined when not found.
 *
 * Mirrors template resolution in template-renderer.ts, but targets schema.json.
 */
export async function loadRendererSchema(name: string): Promise<any | undefined> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const sanitized = String(name).replace(/[^a-zA-Z0-9-]/g, '');
    if (!sanitized) return undefined;

    const candidates = [
      // When running from dist
      path.join(__dirname, '..', '..', 'output', sanitized, 'schema.json'),
      // When running from a checkout with output/ folder copied to CWD
      path.join(process.cwd(), 'output', sanitized, 'schema.json'),
    ];

    for (const p of candidates) {
      try {
        const raw = await fs.readFile(p, 'utf-8');
        return JSON.parse(raw);
      } catch {}
    }
  } catch (e) {
    try {
      logger.warn(`[schema-loader] Failed to load renderer schema '${name}': ${String(e)}`);
    } catch {}
  }
  return undefined;
}
