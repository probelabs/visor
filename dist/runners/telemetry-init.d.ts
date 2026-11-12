import type { VisorConfig } from '../types/config';
/**
 * Initialize telemetry from a Visor config.
 *
 * Extracts the telemetry block (if any) and merges it with environment
 * variable overrides, then calls the shared `initTelemetry()` helper.
 * This replaces the ~20-line block that was duplicated per-frontend.
 */
export declare function initTelemetryFromConfig(config: VisorConfig): Promise<void>;
//# sourceMappingURL=telemetry-init.d.ts.map