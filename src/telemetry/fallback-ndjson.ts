import * as fs from 'fs';
import * as path from 'path';

export function emitNdjsonFallback(name: string, attrs: Record<string, unknown>): void {
  try {
    if (process.env.VISOR_TELEMETRY_ENABLED !== 'true') return;
    if (process.env.VISOR_TELEMETRY_SINK !== 'file') return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const target =
      process.env.VISOR_FALLBACK_TRACE_FILE ||
      path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
    const line = JSON.stringify({ name, attributes: attrs }) + '\n';
    fs.appendFileSync(target, line, 'utf8');
  } catch {
    // ignore
  }
}

export function emitNdjsonSpanWithEvents(
  name: string,
  attrs: Record<string, unknown>,
  events: Array<{ name: string; attrs?: Record<string, unknown> }>
): void {
  try {
    if (process.env.VISOR_TELEMETRY_ENABLED !== 'true') return;
    if (process.env.VISOR_TELEMETRY_SINK !== 'file') return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const target =
      process.env.VISOR_FALLBACK_TRACE_FILE ||
      path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
    const line = JSON.stringify({ name, attributes: attrs, events }) + '\n';
    fs.appendFileSync(target, line, 'utf8');
  } catch {
    // ignore
  }
}
