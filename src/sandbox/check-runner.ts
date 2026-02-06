/**
 * CheckRunner — serializes check execution into a sandbox container.
 * Builds the CheckRunPayload, invokes child visor via sandbox exec,
 * and parses the JSON result from stdout.
 */

import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { CheckConfig } from '../types/config';
import { CheckRunPayload, CheckRunResult, SerializedPRInfo } from './types';
import { SandboxManager } from './sandbox-manager';
import { filterEnvForSandbox } from './env-filter';
import { SandboxConfig } from './types';
import { logger } from '../logger';

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
    timeoutMs?: number
  ): Promise<ReviewSummary> {
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
      dependencyOutputs: Object.keys(dependencyOutputs).length > 0 ? dependencyOutputs : undefined,
    };

    // Filter environment variables
    const env = filterEnvForSandbox(
      checkConfig.env as Record<string, string | number | boolean> | undefined,
      process.env,
      sandboxConfig.env_passthrough
    );

    // Build the command
    const visorPath = sandboxConfig.visor_path || '/opt/visor';
    const payloadJson = JSON.stringify(payload);

    // Use stdin to pass payload to avoid shell argument length limits
    // The visor binary is bundled as index.js (ncc output)
    const command = `echo '${payloadJson.replace(/'/g, "'\\''")}' | node ${visorPath}/index.js --run-check -`;

    logger.info(`Executing check in sandbox '${sandboxName}'`);

    const result = await sandboxManager.exec(sandboxName, {
      command,
      env,
      timeoutMs: timeoutMs || 600000,
      maxBuffer: 50 * 1024 * 1024,
    });

    // Parse the result from stdout
    const stdout = result.stdout.trim();

    if (result.exitCode !== 0 && !stdout) {
      // Complete failure - no JSON output
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
    } catch {
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
}
