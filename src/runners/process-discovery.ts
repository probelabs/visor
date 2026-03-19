/**
 * Cross-platform (Linux + macOS) discovery of running Visor processes.
 *
 * Zero dependencies — uses `ps` for process listing and OS-specific
 * methods for reading each process's working directory:
 *   - Linux:  readlink /proc/<pid>/cwd
 *   - macOS:  lsof -d cwd -a -p <pid>
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export interface VisorProcess {
  pid: number;
  cwd: string;
  cmd: string;
  /** Seconds since process started */
  uptimeSecs?: number;
}

/**
 * Find all running Visor processes whose cwd matches `targetDir`.
 * Excludes the current process.
 */
export function findVisorProcesses(targetDir?: string): VisorProcess[] {
  const dir = targetDir || process.cwd();
  const platform = os.platform();

  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`Process discovery not supported on ${platform}`);
  }

  // 1. Find candidate PIDs — node processes with 'visor' in the command line
  const candidates = listVisorPids();

  // 2. For each candidate, resolve cwd and filter
  const results: VisorProcess[] = [];
  for (const { pid, cmd, uptimeSecs } of candidates) {
    if (pid === process.pid) continue; // skip self

    const cwd = getProcessCwd(pid, platform);
    if (!cwd) continue;

    // Normalize trailing slashes for comparison
    if (normalizePath(cwd) !== normalizePath(dir)) continue;

    results.push({ pid, cwd, cmd, uptimeSecs });
  }

  return results;
}

/**
 * Send a signal to a Visor process.
 */
export function signalProcess(pid: number, signal: 'SIGUSR1' | 'SIGUSR2' | 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a process is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PsEntry {
  pid: number;
  cmd: string;
  uptimeSecs?: number;
}

function listVisorPids(): PsEntry[] {
  try {
    // etimes = elapsed time in seconds (portable across Linux and macOS)
    const raw = execSync('ps -eo pid,etimes,args', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entries: PsEntry[] = [];
    const lines = raw.trim().split('\n').slice(1); // skip header

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Format: "  PID  ELAPSED  COMMAND..."
      const match = trimmed.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const etimes = parseInt(match[2], 10);
      const cmd = match[3];

      // Filter: must be a node/visor process
      if (!isVisorCommand(cmd)) continue;

      entries.push({ pid, cmd, uptimeSecs: etimes });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Heuristic: is this command line a Visor process?
 *
 * Matches the main visor entry point (dist/index.js or cli-main) but
 * excludes child processes (probe agent, MCP servers) and our own
 * `visor process` invocation.
 */
function isVisorCommand(cmd: string): boolean {
  // Must start with node (or npx or visor binary) — excludes shell wrappers
  const firstToken = cmd.trim().split(/\s+/)[0];
  const basename = firstToken.split('/').pop() || '';
  if (!['node', 'npx', 'visor'].includes(basename)) return false;

  // Exclude CLI subcommands — these are tools, not long-running servers
  const cliSubcommands = ['process', 'tasks', 'config', 'code-review', 'review', 'policy-check'];
  for (const sub of cliSubcommands) {
    if (cmd.includes(`index.js ${sub}`) || cmd.includes(`visor ${sub}`)) return false;
  }

  // Must be a node process running visor's dist/index.js
  if (/visor[^/]*\/dist\/index\.js/.test(cmd)) return true;

  // Match: npx visor, npx @probelabs/visor
  if (/npx\s+.*visor/.test(cmd) && !cmd.includes('probe')) return true;

  // Match: direct visor binary (e.g. /usr/local/bin/visor)
  if (basename === 'visor') return true;

  return false;
}

function getProcessCwd(pid: number, platform: string): string | null {
  if (platform === 'linux') {
    return getProcessCwdLinux(pid);
  } else if (platform === 'darwin') {
    return getProcessCwdMacOS(pid);
  }
  return null;
}

function getProcessCwdLinux(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function getProcessCwdMacOS(pid: number): string | null {
  try {
    const raw = execSync(`lsof -d cwd -a -p ${pid} -Fn 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // lsof -Fn output: lines starting with 'n' contain the path
    for (const line of raw.split('\n')) {
      if (line.startsWith('n') && line.length > 1) {
        return line.slice(1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}
