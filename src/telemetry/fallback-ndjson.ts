import * as fs from 'fs';
import * as path from 'path';

let CURRENT_FILE: string | null = null;
let dirReady = false;
let writeChain: Promise<void> = Promise.resolve();
function resolveTargetPath(outDir: string): string {
  if (process.env.VISOR_FALLBACK_TRACE_FILE) {
    CURRENT_FILE = process.env.VISOR_FALLBACK_TRACE_FILE;
    return CURRENT_FILE;
  }
  if (CURRENT_FILE) return CURRENT_FILE;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  CURRENT_FILE = path.join(outDir, `${ts}.ndjson`);
  return CURRENT_FILE;
}

function isEnabled(): boolean {
  // Enable when CLI set a fallback file (serverless mode), or when explicit file sink is enabled
  if (process.env.VISOR_FALLBACK_TRACE_FILE) return true;
  return (
    process.env.VISOR_TELEMETRY_ENABLED === 'true' &&
    (process.env.VISOR_TELEMETRY_SINK || 'file') === 'file'
  );
}

function appendAsync(outDir: string, line: string): void {
  writeChain = writeChain
    .then(async () => {
      if (!dirReady) {
        try {
          await fs.promises.mkdir(outDir, { recursive: true });
        } catch {}
        dirReady = true;
      }
      const target = resolveTargetPath(outDir);
      await fs.promises.appendFile(target, line, 'utf8');
    })
    .catch(() => {});
}

export async function flushNdjson(): Promise<void> {
  try {
    await writeChain;
  } catch {}
}

export function emitNdjsonFallback(name: string, attrs: Record<string, unknown>): void {
  try {
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
    const line = JSON.stringify({ name, attributes: attrs }) + '\n';
    appendAsync(outDir, line);
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
    if (!isEnabled()) return;
    const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
    const line = JSON.stringify({ name, attributes: attrs, events }) + '\n';
    appendAsync(outDir, line);
  } catch {
    // ignore
  }
}
