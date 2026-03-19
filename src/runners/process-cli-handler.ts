/**
 * CLI command handlers for Visor process management.
 *
 * Uses OS-level process discovery (ps + cwd matching) to find running
 * Visor instances and send signals for reload/restart/stop.
 */
import { Command } from 'commander';
import { findVisorProcesses, signalProcess, type VisorProcess } from './process-discovery';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatUptime(secs?: number): string {
  if (secs === undefined) return '-';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

function shortenCmd(cmd: string, maxLen: number): string {
  if (cmd.length <= maxLen) return cmd;
  return cmd.slice(0, maxLen - 1) + '…';
}

function formatProcessCard(proc: VisorProcess, termWidth: number): string {
  const lines: string[] = [];

  const left = `${GREEN}●${RESET} ${BOLD}PID ${proc.pid}${RESET}`;
  const right = `${DIM}up ${formatUptime(proc.uptimeSecs)}${RESET}`;
  const stripLen = (s: string) => s.replace(/\x1b\[\d*(;\d+)*m/g, '').length;
  const pad = Math.max(1, termWidth - stripLen(left) - stripLen(right));
  lines.push(left + ' '.repeat(pad) + right);

  const indent = '  ';
  const cmdMax = termWidth - indent.length;
  lines.push(`${indent}${DIM}${shortenCmd(proc.cmd, cmdMax)}${RESET}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function handleList(): void {
  const procs = findVisorProcesses();
  const termWidth = process.stdout.columns || 80;

  if (procs.length === 0) {
    console.log('No running Visor processes found in this directory.');
    return;
  }

  console.log(`${procs.length} Visor process${procs.length > 1 ? 'es' : ''} running:\n`);
  for (let i = 0; i < procs.length; i++) {
    console.log(formatProcessCard(procs[i], termWidth));
    if (i < procs.length - 1) console.log('');
  }
}

function handleReload(targetPid?: string): void {
  const procs = resolveTargets(targetPid);
  if (!procs) return;

  for (const proc of procs) {
    const ok = signalProcess(proc.pid, 'SIGUSR2');
    if (ok) {
      console.log(`${GREEN}✓${RESET} Sent config reload signal to PID ${proc.pid}`);
    } else {
      console.error(`✗ Failed to signal PID ${proc.pid}`);
      process.exitCode = 1;
    }
  }
}

async function handleRestart(targetPid?: string, wait?: boolean): Promise<void> {
  const procs = resolveTargets(targetPid);
  if (!procs) return;

  for (const proc of procs) {
    const ok = signalProcess(proc.pid, 'SIGUSR1');
    if (ok) {
      console.log(`${YELLOW}⟳${RESET} Sent graceful restart signal to PID ${proc.pid}`);
    } else {
      console.error(`✗ Failed to signal PID ${proc.pid}`);
      process.exitCode = 1;
      return;
    }
  }

  if (wait) {
    const oldPids = new Set(procs.map(p => p.pid));
    console.log(`${DIM}Waiting for restart to complete...${RESET}`);

    const timeout = 300_000; // 5 minutes max
    const start = Date.now();

    while (Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const current = findVisorProcesses();
      // Old PIDs should be gone and at least one new process should exist
      const oldStillAlive = current.filter(p => oldPids.has(p.pid));
      const newOnes = current.filter(p => !oldPids.has(p.pid));

      if (oldStillAlive.length === 0 && newOnes.length > 0) {
        console.log(
          `${GREEN}✓${RESET} Restart complete — new PID ${newOnes.map(p => p.pid).join(', ')} (took ${Math.round((Date.now() - start) / 1000)}s)`
        );
        return;
      }

      // Show progress
      if (oldStillAlive.length > 0) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        process.stdout.write(
          `\r${DIM}  ${oldStillAlive.length} old process(es) still draining... ${elapsed}s${RESET}`
        );
      }
    }

    console.log(`\n${YELLOW}⚠${RESET} Timed out after 5m — old process(es) may still be draining`);
    process.exitCode = 1;
  }
}

function handleStop(targetPid?: string): void {
  const procs = resolveTargets(targetPid);
  if (!procs) return;

  for (const proc of procs) {
    const ok = signalProcess(proc.pid, 'SIGTERM');
    if (ok) {
      console.log(`Sent shutdown signal to PID ${proc.pid}`);
    } else {
      console.error(`✗ Failed to signal PID ${proc.pid}`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTargets(targetPid?: string): VisorProcess[] | null {
  const procs = findVisorProcesses();

  if (procs.length === 0) {
    console.error('No running Visor processes found in this directory.');
    process.exitCode = 1;
    return null;
  }

  if (targetPid) {
    const pid = parseInt(targetPid, 10);
    const match = procs.find(p => p.pid === pid);
    if (!match) {
      console.error(`PID ${targetPid} is not a Visor process in this directory.`);
      console.error(`Running processes: ${procs.map(p => p.pid).join(', ')}`);
      process.exitCode = 1;
      return null;
    }
    return [match];
  }

  if (procs.length > 1) {
    console.error(`Multiple Visor processes found. Specify --pid to target one:`);
    for (const p of procs) {
      console.error(`  PID ${p.pid}  (up ${formatUptime(p.uptimeSecs)})`);
    }
    process.exitCode = 1;
    return null;
  }

  return procs;
}

// ---------------------------------------------------------------------------
// Commander entry point
// ---------------------------------------------------------------------------

export async function handleProcessCommand(argv: string[]): Promise<void> {
  const program = new Command('process').description('Manage running Visor processes').addHelpText(
    'after',
    `
Signals:
  reload   SIGUSR2  Hot-reload configuration without restart
  restart  SIGUSR1  Graceful restart (new process spawns, old drains)
  stop     SIGTERM  Graceful shutdown`
  );

  program
    .command('list', { isDefault: true })
    .description('List running Visor processes in this directory')
    .action(() => {
      handleList();
    });

  program
    .command('reload')
    .description('Hot-reload configuration (SIGUSR2)')
    .option('--pid <pid>', 'Target a specific process by PID')
    .action(opts => {
      handleReload(opts.pid);
    });

  program
    .command('restart')
    .description('Graceful restart (SIGUSR1)')
    .option('--pid <pid>', 'Target a specific process by PID')
    .option('--wait', 'Block until old process exits and new one is running')
    .action(async opts => {
      await handleRestart(opts.pid, opts.wait);
    });

  program
    .command('stop')
    .description('Graceful shutdown (SIGTERM)')
    .option('--pid <pid>', 'Target a specific process by PID')
    .action(opts => {
      handleStop(opts.pid);
    });

  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err: any) {
    if (err?.exitCode === 0) return;
    if (err?.code === 'commander.helpDisplayed') return;
    if (err?.code === 'commander.unknownCommand' || err?.code === 'commander.missingArgument') {
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
