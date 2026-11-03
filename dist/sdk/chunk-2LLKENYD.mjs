import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/task-trace-resolution.ts
async function resolveTaskTraceReference(metadata) {
  const traceFile = metadata?.trace_file;
  let traceId = metadata?.trace_id;
  if (!traceId && traceFile) {
    try {
      const { readTraceIdFromFile } = await import("./trace-serializer-4TOIAVQL.mjs");
      traceId = await readTraceIdFromFile(traceFile) || void 0;
    } catch {
      traceId = void 0;
    }
  }
  return {
    traceId,
    traceFile,
    primaryRef: traceFile || traceId || void 0
  };
}
var init_task_trace_resolution = __esm({
  "src/agent-protocol/task-trace-resolution.ts"() {
    "use strict";
  }
});

export {
  resolveTaskTraceReference,
  init_task_trace_resolution
};
//# sourceMappingURL=chunk-2LLKENYD.mjs.map