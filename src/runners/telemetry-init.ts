import type { VisorConfig } from '../types/config';
import { initTelemetry } from '../telemetry/opentelemetry';

/**
 * Initialize telemetry from a Visor config.
 *
 * Extracts the telemetry block (if any) and merges it with environment
 * variable overrides, then calls the shared `initTelemetry()` helper.
 * This replaces the ~20-line block that was duplicated per-frontend.
 */
export async function initTelemetryFromConfig(config: VisorConfig): Promise<void> {
  const t = (config as any)?.telemetry as
    | {
        enabled?: boolean;
        sink?: 'otlp' | 'file' | 'console';
        file?: { dir?: string; ndjson?: boolean };
        tracing?: { auto_instrumentations?: boolean; trace_report?: { enabled?: boolean } };
      }
    | undefined;

  if (t) {
    await initTelemetry({
      enabled: process.env.VISOR_TELEMETRY_ENABLED === 'true' || !!t.enabled,
      sink: (process.env.VISOR_TELEMETRY_SINK as 'otlp' | 'file' | 'console') || t.sink || 'file',
      file: { dir: process.env.VISOR_TRACE_DIR || t.file?.dir, ndjson: !!t.file?.ndjson },
      autoInstrument: !!t.tracing?.auto_instrumentations,
      traceReport: !!t.tracing?.trace_report?.enabled,
    });
  } else {
    await initTelemetry({
      enabled: process.env.VISOR_TELEMETRY_ENABLED === 'true',
      sink: (process.env.VISOR_TELEMETRY_SINK as 'otlp' | 'file' | 'console') || 'file',
      file: { dir: process.env.VISOR_TRACE_DIR },
    });
  }
}
