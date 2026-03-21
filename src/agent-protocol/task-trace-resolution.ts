export interface TaskTraceMetadata {
  trace_id?: string;
  trace_file?: string;
}

export interface ResolvedTaskTrace {
  traceId?: string;
  traceFile?: string;
  primaryRef?: string;
}

export async function resolveTaskTraceReference(
  metadata?: TaskTraceMetadata | null
): Promise<ResolvedTaskTrace> {
  const traceFile = metadata?.trace_file;
  let traceId = metadata?.trace_id;

  if (!traceId && traceFile) {
    try {
      const { readTraceIdFromFile } = await import('./trace-serializer');
      traceId = (await readTraceIdFromFile(traceFile)) || undefined;
    } catch {
      traceId = undefined;
    }
  }

  return {
    traceId,
    traceFile,
    primaryRef: traceId || traceFile || undefined,
  };
}
