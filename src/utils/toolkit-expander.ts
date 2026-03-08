/**
 * Toolkit expansion utility.
 *
 * Expands a toolkit config's tools section into individual tool entries.
 */

/**
 * Check if an object is a toolkit reference (has a `toolkit:` key).
 */
export function isToolkitReference(obj: unknown): obj is { toolkit: string } {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    'toolkit' in obj &&
    typeof (obj as any).toolkit === 'string'
  );
}

/**
 * Expand a toolkit configuration's tools section.
 * Takes the parsed toolkit file contents and returns a flat Record of tool definitions.
 * Optional overrides are merged into each expanded tool.
 */
export function expandToolkit(
  toolkitConfig: Record<string, unknown>,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const tools = (toolkitConfig as any)?.tools ?? toolkitConfig;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new Error('Toolkit config does not contain a valid tools section');
  }

  const expanded: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools as Record<string, unknown>)) {
    if (
      def &&
      typeof def === 'object' &&
      !Array.isArray(def) &&
      overrides &&
      Object.keys(overrides).length > 0
    ) {
      expanded[name] = { ...(def as Record<string, unknown>), ...overrides };
    } else {
      expanded[name] = def;
    }
  }
  return expanded;
}
