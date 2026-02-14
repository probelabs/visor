/**
 * CLI command handlers for config snapshot management
 *
 * Commands:
 *   visor config snapshots                      - List all snapshots
 *   visor config show <id>                      - Print full YAML of a snapshot
 *   visor config diff <id_a> <id_b>             - Unified diff between two snapshots
 *   visor config restore <id> --output <path>   - Write snapshot YAML to file
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { configureLoggerFromCli } from '../logger';
import { ConfigSnapshotStore } from './config-snapshot-store';

/**
 * Parse CLI arguments for config commands
 */
function parseArgs(argv: string[]): {
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const subcommand = argv[0] || 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  return { subcommand, positional, flags };
}

/**
 * Handle the config subcommand
 */
export async function handleConfigCommand(argv: string[]): Promise<void> {
  const { subcommand, positional, flags } = parseArgs(argv);

  configureLoggerFromCli({
    output: 'table',
    debug: flags.debug === true || process.env.VISOR_DEBUG === 'true',
    verbose: flags.verbose === true,
    quiet: flags.quiet === true,
  });

  switch (subcommand) {
    case 'snapshots':
      await handleSnapshots();
      break;
    case 'show':
      await handleShow(positional);
      break;
    case 'diff':
      await handleDiff(positional);
      break;
    case 'restore':
      await handleRestore(positional, flags);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

function printHelp(): void {
  console.log(`
Visor Config - Manage configuration snapshots

USAGE:
  visor config <command> [options]

COMMANDS:
  snapshots                       List all configuration snapshots
  show <id>                       Print the full YAML of a snapshot
  diff <id_a> <id_b>              Show unified diff between two snapshots
  restore <id> --output <path>    Write snapshot YAML to a file
  help                            Show this help text

EXAMPLES:
  visor config snapshots
  visor config show 1
  visor config diff 1 2
  visor config restore 1 --output /tmp/restored.yaml
`);
}

async function withStore<T>(fn: (store: ConfigSnapshotStore) => Promise<T>): Promise<T> {
  const store = new ConfigSnapshotStore();
  await store.initialize();
  try {
    return await fn(store);
  } finally {
    await store.shutdown();
  }
}

async function handleSnapshots(): Promise<void> {
  await withStore(async store => {
    const snapshots = await store.list();

    if (snapshots.length === 0) {
      console.log('No configuration snapshots found.');
      return;
    }

    // Table header
    const header = ['ID', 'Created At', 'Trigger', 'Hash', 'Source Path'];
    const rows = snapshots.map(s => [
      String(s.id),
      s.created_at,
      s.trigger,
      s.config_hash,
      s.source_path || '-',
    ]);

    // Calculate column widths
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));

    const sep = widths.map(w => '-'.repeat(w)).join('  ');
    const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');

    console.log(fmt(header));
    console.log(sep);
    rows.forEach(row => console.log(fmt(row)));
  });
}

async function handleShow(positional: string[]): Promise<void> {
  const idStr = positional[0];
  if (!idStr) {
    console.error('Usage: visor config show <id>');
    process.exitCode = 1;
    return;
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    console.error(`Invalid snapshot ID: ${idStr}`);
    process.exitCode = 1;
    return;
  }

  await withStore(async store => {
    const snapshot = await store.get(id);
    if (!snapshot) {
      console.error(`Snapshot ${id} not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(snapshot.config_yaml);
  });
}

async function handleDiff(positional: string[]): Promise<void> {
  if (positional.length < 2) {
    console.error('Usage: visor config diff <id_a> <id_b>');
    process.exitCode = 1;
    return;
  }

  const idA = parseInt(positional[0], 10);
  const idB = parseInt(positional[1], 10);
  if (isNaN(idA) || isNaN(idB)) {
    console.error(`Invalid snapshot IDs: ${positional[0]}, ${positional[1]}`);
    process.exitCode = 1;
    return;
  }

  await withStore(async store => {
    const [snapA, snapB] = await Promise.all([store.get(idA), store.get(idB)]);

    if (!snapA) {
      console.error(`Snapshot ${idA} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!snapB) {
      console.error(`Snapshot ${idB} not found.`);
      process.exitCode = 1;
      return;
    }

    // Try system diff command with temp files
    const tmpDir = os.tmpdir();
    const fileA = path.join(tmpDir, `visor-config-${idA}.yaml`);
    const fileB = path.join(tmpDir, `visor-config-${idB}.yaml`);

    try {
      fs.writeFileSync(fileA, snapA.config_yaml, 'utf8');
      fs.writeFileSync(fileB, snapB.config_yaml, 'utf8');

      try {
        const output = execSync(
          `diff -u --label "snapshot ${idA}" --label "snapshot ${idB}" "${fileA}" "${fileB}"`,
          { encoding: 'utf8' }
        );
        // diff returns exit code 0 when files are identical
        console.log(output || 'Snapshots are identical.');
      } catch (diffErr: any) {
        // diff exits with code 1 when files differ (stdout has the diff)
        if (diffErr.status === 1 && diffErr.stdout) {
          console.log(diffErr.stdout);
        } else {
          // diff command not available — fallback
          console.log(`--- snapshot ${idA} ---`);
          console.log(snapA.config_yaml);
          console.log(`--- snapshot ${idB} ---`);
          console.log(snapB.config_yaml);
        }
      }
    } finally {
      try {
        fs.unlinkSync(fileA);
      } catch {}
      try {
        fs.unlinkSync(fileB);
      } catch {}
    }
  });
}

async function handleRestore(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const idStr = positional[0];
  if (!idStr) {
    console.error('Usage: visor config restore <id> --output <path>');
    process.exitCode = 1;
    return;
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    console.error(`Invalid snapshot ID: ${idStr}`);
    process.exitCode = 1;
    return;
  }

  const outputPath = flags.output;
  if (!outputPath || typeof outputPath !== 'string') {
    console.error('--output <path> is required');
    process.exitCode = 1;
    return;
  }

  await withStore(async store => {
    const snapshot = await store.get(id);
    if (!snapshot) {
      console.error(`Snapshot ${id} not found.`);
      process.exitCode = 1;
      return;
    }

    const resolved = path.resolve(process.cwd(), outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, snapshot.config_yaml, 'utf8');
    console.log(`Snapshot ${id} restored to ${resolved}`);
  });
}
