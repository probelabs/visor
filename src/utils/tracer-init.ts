import * as path from 'path';
import * as fs from 'fs';

/**
 * Safely initialize a tracer for ProbeAgent with proper path sanitization
 * This prevents path traversal vulnerabilities by sanitizing the checkName
 */
export async function initializeTracer(
  sessionId: string,
  checkName?: string
): Promise<{ tracer: any; filePath: string } | null> {
  try {
    // Import telemetry modules dynamically
    const probeModule = (await import('@probelabs/probe')) as any;

    if (!probeModule.SimpleTelemetry || !probeModule.SimpleAppTracer) {
      console.error('⚠️ Telemetry classes not available in ProbeAgent, skipping tracing');
      return null;
    }

    const SimpleTelemetry = probeModule.SimpleTelemetry;
    const SimpleAppTracer = probeModule.SimpleAppTracer;

    // SECURITY: Sanitize checkName to prevent path traversal attacks
    // Use path.basename to strip any directory traversal characters (../, etc.)
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
    // This ensures the final path is within traceDir
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

    // Initialize telemetry and tracer
    const telemetry = new SimpleTelemetry({
      serviceName: 'visor-ai',
      enableFile: true,
      filePath: traceFilePath,
      enableConsole: false,
    });

    const tracer = new SimpleAppTracer(telemetry, sessionId);

    console.error(`📊 Tracing enabled, will save to: ${traceFilePath}`);

    // If in GitHub Actions, log the path for artifact upload
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::notice title=AI Trace::Trace will be saved to ${traceFilePath}`);
      console.log(`::set-output name=trace-path::${traceFilePath}`);
    }

    return { tracer, filePath: traceFilePath };
  } catch (error) {
    console.error('⚠️ Warning: Failed to initialize tracing:', error);
    return null;
  }
}
