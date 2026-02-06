/**
 * Read child visor NDJSON trace file and re-emit spans
 * into the parent's telemetry context as events.
 */

import { readFileSync } from 'fs';
import { addEvent } from './sandbox-telemetry';

/**
 * Ingest child trace NDJSON file and re-emit each span
 * as an event on the current parent span.
 *
 * Each line in the file is a JSON object with at minimum:
 *   { name: string, attributes?: Record<string, unknown>, events?: [...] }
 *
 * Gracefully ignores parse errors (child may have crashed mid-write).
 */
export function ingestChildTrace(filePath: string): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    // File may not exist or be unreadable — nothing to ingest
    return;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const span = JSON.parse(trimmed);
      const attrs: Record<string, unknown> = {
        'visor.sandbox.child_span': true,
        ...(span.attributes || {}),
      };

      if (span.name) {
        attrs['child_span_name'] = span.name;
      }

      // Re-emit child span events as sub-events
      if (Array.isArray(span.events)) {
        for (const evt of span.events) {
          addEvent(`visor.sandbox.child: ${evt.name || span.name}`, {
            ...attrs,
            ...(evt.attrs || {}),
          });
        }
      } else {
        addEvent(`visor.sandbox.child: ${span.name || 'unknown'}`, attrs);
      }
    } catch {
      // Gracefully ignore malformed lines (child may have crashed mid-write)
    }
  }
}
