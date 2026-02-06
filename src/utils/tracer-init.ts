import * as path from 'path';
import * as fs from 'fs';

/**
 * Safely initialize a tracer for ProbeAgent with proper path sanitization
 * Uses SimpleTelemetry for lightweight tracing
 * This prevents path traversal vulnerabilities by sanitizing the checkName
 */
type ProbeModule =
  | {
      SimpleTelemetry?: new (opts: {
        enableFile: boolean;
        filePath: string;
        enableConsole?: boolean;
      }) => unknown;
      SimpleAppTracer?: new (telemetry: unknown, sessionId: string) => unknown;
    }
  | undefined;

export async function initializeTracer(
  sessionId: string,
  checkName?: string
): Promise<{ tracer: unknown; telemetryConfig: unknown; filePath: string } | null> {
  try {
    // Load Probe lib in a way that works in both ESM and CJS bundles
    let ProbeLib: ProbeModule;
    try {
      ProbeLib = (await import('@probelabs/probe')) as ProbeModule;
    } catch {
      try {
        // Fallback to CJS require if available

        ProbeLib = require('@probelabs/probe') as ProbeModule;
      } catch {
        ProbeLib = {} as unknown as ProbeModule;
      }
    }

    // Use SimpleTelemetry (probe no longer exports full OpenTelemetry classes)
    const SimpleTelemetry = ProbeLib?.SimpleTelemetry;
    const SimpleAppTracer = ProbeLib?.SimpleAppTracer;
    if (SimpleTelemetry && SimpleAppTracer) {
      // SECURITY: Sanitize checkName to prevent path traversal attacks
      const sanitizedCheckName = checkName ? path.basename(checkName) : 'check';

      // Create trace file path in debug-artifacts directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const traceDir = process.env.GITHUB_WORKSPACE
        ? path.join(process.env.GITHUB_WORKSPACE, 'debug-artifacts')
        : path.join(process.cwd(), 'debug-artifacts');

      // Create traces directory if it doesn't exist
      if (!fs.existsSync(traceDir)) {
        fs.mkdirSync(traceDir, { recursive: true });
      }

      // SECURITY: Use path.join to safely construct the path
      const traceFilePath = path.join(traceDir, `trace-${sanitizedCheckName}-${timestamp}.jsonl`);

      // SECURITY: Verify the resolved path is within the intended directory
      const resolvedTracePath = path.resolve(traceFilePath);
      const resolvedTraceDir = path.resolve(traceDir);
      if (!resolvedTracePath.startsWith(resolvedTraceDir)) {
        console.error(
          `⚠️ Security: Attempted path traversal detected. Check name: ${checkName}, resolved path: ${resolvedTracePath}`
        );
        return null;
      }

      // Initialize simple telemetry
      const telemetry = new SimpleTelemetry({
        enableFile: true,
        filePath: traceFilePath,
        enableConsole: false,
      });

      const tracer = new SimpleAppTracer(telemetry, sessionId);

      // WORKAROUND: Add missing recordEvent method for completionPrompt feature (probe #321)
      // SimpleAppTracer doesn't have recordEvent but completionPrompt requires it
      if (typeof (tracer as any).recordEvent !== 'function') {
        (tracer as any).recordEvent = (name: string, attributes?: Record<string, unknown>) => {
          // Log completion events to telemetry for debugging
          try {
            if ((telemetry as any).record) {
              (telemetry as any).record({ event: name, ...attributes });
            }
          } catch {
            // Best-effort only
          }
        };
      }

      console.error(`📊 Simple tracing enabled, will save to: ${traceFilePath}`);

      // If in GitHub Actions, log the path for artifact upload
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::notice title=AI Trace::Trace will be saved to ${traceFilePath}`);
        console.log(`::set-output name=trace-path::${traceFilePath}`);
      }

      // Return with SimpleTelemetry
      return {
        tracer,
        telemetryConfig: telemetry,
        filePath: traceFilePath,
      };
    }

    console.error('⚠️ Telemetry classes not available in ProbeAgent, skipping tracing');
    return null;
  } catch (error) {
    console.error('⚠️ Warning: Failed to initialize tracing:', error);
    return null;
  }
}
