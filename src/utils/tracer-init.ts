import * as path from 'path';
import * as fs from 'fs';
import { SimpleTelemetry, SimpleAppTracer } from '@probelabs/probe';

/**
 * Safely initialize a tracer for ProbeAgent with proper path sanitization
 * Uses SimpleTelemetry for lightweight tracing
 * This prevents path traversal vulnerabilities by sanitizing the checkName
 */
export async function initializeTracer(
  sessionId: string,
  checkName?: string
): Promise<{ tracer: unknown; telemetryConfig: unknown; filePath: string } | null> {
  try {
    // Use SimpleTelemetry (probe no longer exports full OpenTelemetry classes)
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
