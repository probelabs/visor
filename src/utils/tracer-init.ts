import * as path from 'path';
import * as fs from 'fs';

/**
 * Safely initialize a tracer for ProbeAgent with proper path sanitization
 * Uses full OpenTelemetry integration for hierarchical span relationships
 * This prevents path traversal vulnerabilities by sanitizing the checkName
 */
export async function initializeTracer(
  sessionId: string,
  checkName?: string
): Promise<{ tracer: any; telemetryConfig: any; filePath: string } | null> {
  try {
    // Import telemetry modules dynamically
    const probeModule = (await import('@probelabs/probe')) as any;

    // Try to use full OpenTelemetry integration first (provides proper span hierarchy)
    if (probeModule.TelemetryConfig && probeModule.AppTracer) {
      const TelemetryConfig = probeModule.TelemetryConfig;
      const AppTracer = probeModule.AppTracer;

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

      // Initialize OpenTelemetry with file exporter
      // This provides proper span hierarchy and parent-child relationships
      const telemetryConfig = new TelemetryConfig({
        serviceName: 'visor-ai',
        serviceVersion: '1.0.0',
        enableFile: true,
        filePath: traceFilePath,
        enableConsole: false, // Disable console to reduce noise
        enableRemote: false, // Can be enabled via OTEL_EXPORTER_OTLP_ENDPOINT env var
      });

      // Initialize the OpenTelemetry SDK
      telemetryConfig.initialize();

      // Create the AppTracer with session ID for consistent tracing
      const tracer = new AppTracer(telemetryConfig, sessionId);

      console.error(`📊 OpenTelemetry tracing enabled for visor-ai, saving to: ${traceFilePath}`);
      console.error(
        `🌲 Trace spans will show hierarchical relationships between visor checks and probe agent operations`
      );

      // If in GitHub Actions, log the path for artifact upload
      if (process.env.GITHUB_ACTIONS) {
        console.log(
          `::notice title=AI Trace::OpenTelemetry trace will be saved to ${traceFilePath}`
        );
        console.log(`::set-output name=trace-path::${traceFilePath}`);
      }

      return { tracer, telemetryConfig, filePath: traceFilePath };
    }

    // Fallback to SimpleTelemetry if full OpenTelemetry is not available
    if (probeModule.SimpleTelemetry && probeModule.SimpleAppTracer) {
      console.warn(
        '⚠️ Using SimpleTelemetry fallback - hierarchical span relationships may not be available'
      );

      const SimpleTelemetry = probeModule.SimpleTelemetry;
      const SimpleAppTracer = probeModule.SimpleAppTracer;

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
        serviceName: 'visor-ai',
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

      return { tracer, telemetryConfig: telemetry, filePath: traceFilePath };
    }

    console.error('⚠️ Telemetry classes not available in ProbeAgent, skipping tracing');
    return null;
  } catch (error) {
    console.error('⚠️ Warning: Failed to initialize tracing:', error);
    return null;
  }
}
