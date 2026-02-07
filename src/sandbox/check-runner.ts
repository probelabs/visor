/**
 * CheckRunner — serializes check execution into a sandbox container.
 * Builds the CheckRunPayload, invokes child visor via sandbox exec,
 * and parses the JSON result from stdout.
 */

import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { CheckConfig } from '../types/config';
import { CheckRunPayload, CheckRunResult, SerializedPRInfo } from './types';
import { SandboxManager } from './sandbox-manager';
import { filterEnvForSandbox } from './env-filter';
import { SandboxConfig } from './types';
import { logger } from '../logger';
import { withActiveSpan, setSpanError } from './sandbox-telemetry';
import { ingestChildTrace } from './trace-ingester';

/**
 * Serialize PRInfo to a plain JSON-safe object
 */
function serializePRInfo(prInfo: PRInfo): SerializedPRInfo {
  return {
    number: prInfo.number,
    title: prInfo.title,
    body: prInfo.body,
    author: prInfo.author,
    base: prInfo.base,
    head: prInfo.head,
    files: (prInfo.files || []).map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
    })),
    totalAdditions: prInfo.totalAdditions,
    totalDeletions: prInfo.totalDeletions,
    eventType: prInfo.eventType,
    fullDiff: prInfo.fullDiff,
    commitDiff: prInfo.commitDiff,
    isIncremental: prInfo.isIncremental,
    isIssue: prInfo.isIssue,
    eventContext: prInfo.eventContext,
  };
}

export class CheckRunner {
  /**
   * Execute a check inside a sandbox container.
   *
   * 1. Build CheckRunPayload JSON
   * 2. Filter env vars through EnvFilter
   * 3. Exec `node <visor_path>/cli-main.js --run-check` inside the sandbox
   * 4. Parse CheckRunResult from stdout JSON
   * 5. Return as ReviewSummary
   */
  static async runCheck(
    sandboxManager: SandboxManager,
    sandboxName: string,
    sandboxConfig: SandboxConfig,
    checkConfig: CheckConfig,
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    timeoutMs?: number,
    workspaceDefaults?: { env_passthrough?: string[] }
  ): Promise<ReviewSummary> {
    return withActiveSpan(
      'visor.sandbox.runCheck',
      {
        'visor.sandbox.name': sandboxName,
        'visor.check.name': (checkConfig as any).name || 'unknown',
      },
      async () => {
        // Build the payload
        const dependencyOutputs: Record<string, unknown> = {};
        if (dependencyResults) {
          for (const [key, value] of dependencyResults) {
            dependencyOutputs[key] = value;
          }
        }

        const payload: CheckRunPayload = {
          check: checkConfig,
          prInfo: serializePRInfo(prInfo),
          dependencyOutputs:
            Object.keys(dependencyOutputs).length > 0 ? dependencyOutputs : undefined,
        };

        // Filter environment variables
        const env = filterEnvForSandbox(
          checkConfig.env as Record<string, string | number | boolean> | undefined,
          process.env,
          sandboxConfig.env_passthrough,
          workspaceDefaults?.env_passthrough
        );

        // Set up child trace file relay (skip for read-only sandboxes)
        const workdir = sandboxConfig.workdir || '/workspace';
        let hostTracePath: string | undefined;
        if (!sandboxConfig.read_only) {
          const traceFileName = `.visor-trace-${randomUUID().slice(0, 8)}.ndjson`;
          hostTracePath = join(sandboxManager.getRepoPath(), traceFileName);
          const containerTracePath = `${workdir}/${traceFileName}`;
          try {
            writeFileSync(hostTracePath, '', 'utf8'); // Create empty file (inside mounted workspace)
          } catch {
            hostTracePath = undefined; // Can't write — skip trace relay
          }
          if (hostTracePath) {
            env['VISOR_FALLBACK_TRACE_FILE'] = containerTracePath;
            env['VISOR_TELEMETRY_ENABLED'] = 'true';
            env['VISOR_TELEMETRY_SINK'] = 'file';
          }
        }

        // Build the command (validate visorPath to prevent shell injection inside container)
        const visorPath = sandboxConfig.visor_path || '/opt/visor';
        if (!/^[a-zA-Z0-9/_.-]+$/.test(visorPath) || /\.\./.test(visorPath)) {
          throw new Error(
            `Invalid visor_path '${visorPath}': must be a safe absolute path without '..' traversal`
          );
        }
        const payloadJson = JSON.stringify(payload);

        // Allow child visor to resolve externalized npm packages (e.g. @opentelemetry/*)
        // from the workspace's node_modules (ncc doesn't bundle dynamic requires)
        env['NODE_PATH'] = `${workdir}/node_modules`;

        // Base64-encode payload to avoid shell quoting issues (the command goes
        // through two layers of sh -c quoting: check-runner → docker exec).
        // Base64 output is guaranteed to only contain [A-Za-z0-9+/=] which are shell-safe.
        const b64Payload = Buffer.from(payloadJson).toString('base64');
        if (!/^[A-Za-z0-9+/=]+$/.test(b64Payload)) {
          throw new Error('Unexpected characters in base64-encoded payload');
        }
        const command = `echo ${b64Payload} | base64 -d | node ${visorPath}/index.js --run-check -`;

        logger.info(`Executing check in sandbox '${sandboxName}'`);

        const result = await sandboxManager.exec(sandboxName, {
          command,
          env,
          timeoutMs: timeoutMs || 600000,
          maxBuffer: 50 * 1024 * 1024,
        });

        // Ingest child trace file if it exists
        if (hostTracePath) {
          try {
            if (existsSync(hostTracePath)) {
              ingestChildTrace(hostTracePath);
              unlinkSync(hostTracePath);
            }
          } catch {
            // Non-fatal: child trace ingestion failure shouldn't affect check result
            try {
              if (existsSync(hostTracePath)) unlinkSync(hostTracePath);
            } catch {}
          }
        }

        // Parse the result from stdout
        const stdout = result.stdout.trim();

        if (result.exitCode !== 0 && !stdout) {
          // Complete failure - no JSON output
          setSpanError(new Error(`Sandbox execution failed (exit ${result.exitCode})`));
          return {
            issues: [
              {
                severity: 'error',
                message: `Sandbox execution failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
                file: '',
                line: 0,
                ruleId: 'sandbox-execution-error',
                category: 'logic',
              },
            ],
          };
        }

        // Find the last line that looks like JSON (the result)
        const lines = stdout.split('\n');
        let jsonLine: string | undefined;
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith('{')) {
            jsonLine = line;
            break;
          }
        }

        if (!jsonLine) {
          setSpanError(new Error('No JSON output from sandboxed check'));
          return {
            issues: [
              {
                severity: 'error',
                message: `No JSON output from sandboxed check. Stdout: ${stdout.slice(0, 500)}`,
                file: '',
                line: 0,
                ruleId: 'sandbox-parse-error',
                category: 'logic',
              },
            ],
          };
        }

        let checkRunResult: CheckRunResult;
        try {
          checkRunResult = JSON.parse(jsonLine);
        } catch (parseErr) {
          setSpanError(parseErr);
          return {
            issues: [
              {
                severity: 'error',
                message: `Invalid JSON from sandboxed check: ${jsonLine.slice(0, 200)}`,
                file: '',
                line: 0,
                ruleId: 'sandbox-parse-error',
                category: 'logic',
              },
            ],
          };
        }

        // Convert CheckRunResult back to ReviewSummary
        const summary: ReviewSummary & { output?: unknown; content?: string } = {
          issues: checkRunResult.issues || [],
          debug: checkRunResult.debug as ReviewSummary['debug'],
        };

        if (checkRunResult.output !== undefined) {
          summary.output = checkRunResult.output;
        }
        if (checkRunResult.content !== undefined) {
          summary.content = checkRunResult.content;
        }

        return summary;
      }
    );
  }
}
