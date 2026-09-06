#!/usr/bin/env node
'use strict';

/*
 * Small launch/collection helper for milestone A.
 *
 * It owns only a run-output directory.  It never clones, deletes, or edits the
 * subject checkout.  The caller prepares an isolated checkout and invokes this
 * helper from any directory; the helper then runs Visor with that checkout as
 * cwd.  stdout/stderr are appended as chunks while Visor is running, so an
 * interrupted or failed run still has diagnostics and Proof artifacts.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function realpathExisting(value, label) {
  if (!value || typeof value !== 'string') throw new Error(`${label} is required`);
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error(`${label} is not a directory: ${value}`);
  return resolved;
}

function isWithin(candidate, root) {
  const rel = path.relative(root, candidate);
  return (
    rel === '' || (rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
  );
}

function validateRoots(subjectRoot, originalRoot) {
  const subject = realpathExisting(subjectRoot, 'subjectRoot');
  const original = realpathExisting(originalRoot, 'originalRoot');
  if (subject === original) throw new Error('subjectRoot must differ from originalRoot');
  // The subject may be a sibling or a nested temporary clone, but the
  // protected original can never be a parent of the writable subject.
  if (isWithin(subject, original)) throw new Error('subjectRoot must not be inside originalRoot');
  const git = spawnSync('git', ['-C', subject, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (git.status !== 0)
    throw new Error(`subjectRoot is not a git checkout: ${git.stderr || ''}`.trim());
  const gitRoot = fs.realpathSync(String(git.stdout || '').trim());
  if (gitRoot !== subject)
    throw new Error(`subjectRoot must be the git root (resolved ${gitRoot})`);
  return { subject, original };
}

function ensureOutputPath(output, subject, original) {
  const target = path.resolve(output);
  if (isWithin(target, subject) || isWithin(target, original)) {
    throw new Error('output directory must be outside both subjectRoot and originalRoot');
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error('output directory must be empty so prior diagnostics are not overwritten');
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}

function parseArgs(argv) {
  const options = {
    subjectRoot: process.env.SUBJECT_ROOT,
    originalRoot: process.env.PROTECTED_ORIGINAL,
    output: process.env.NATIVE_ONBOARDING_OUTPUT_DIR,
    proofBin: process.env.PROOF_BIN,
    visorBin: process.env.VISOR_BIN,
    config: path.resolve(__dirname, 'visor.yaml'),
    timeout: '1800000',
    preflightOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--subject-root') options.subjectRoot = next();
    else if (arg === '--original-root') options.originalRoot = next();
    else if (arg === '--output') options.output = next();
    else if (arg === '--proof-bin') options.proofBin = next();
    else if (arg === '--visor') options.visorBin = next();
    else if (arg === '--config') options.config = next();
    else if (arg === '--timeout') options.timeout = next();
    else if (arg === '--preflight-only') options.preflightOnly = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function help() {
  return [
    'Usage: node run-demo.cjs --subject-root <isolated-checkout> --original-root <protected-checkout>',
    '       [--visor <visor-entry>] [--proof-bin </absolute/path/to/proof>] [--output <run-dir>]',
    '       [--config <visor.yaml>] [--timeout <ms>] [--preflight-only]',
    '',
    'The subject checkout must be a distinct git root. The helper runs Visor from',
    'that root and preserves incremental stdout/stderr plus final Proof artifacts.',
  ].join('\n');
}

function defaultVisor() {
  if (process.env.VISOR_BIN) return process.env.VISOR_BIN;
  // This path is for the source checkout that contains this example.  The
  // caller can always provide --visor; no built or temporary binary is pinned.
  return path.resolve(__dirname, '../../../src/index.ts');
}

function validateProofBin(value) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error('proofBin must be an absolute path to the intended Proof executable');
  }
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`proofBin is not a file: ${value}`);
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

function childCommand(visorBin, config, timeout, preflightOnly) {
  const args = [];
  let executable = visorBin;
  if (visorBin.endsWith('.ts')) {
    executable = process.execPath;
    // Resolve from this example's repository rather than from the isolated
    // subject checkout, which intentionally has no Visor node_modules.
    args.push('-r', require.resolve('ts-node/register/transpile-only'), visorBin);
  } else if (visorBin.endsWith('.js')) {
    executable = process.execPath;
    args.push(visorBin);
  }
  args.push(
    '--config',
    config,
    '--event',
    'manual',
    '--output',
    'json',
    '--timeout',
    String(timeout),
    '--max-parallelism',
    '1'
  );
  // Explicit sinks avoid the CLI's default sink pruning.  Tags admit the
  // tagged transitive dependencies while retaining a deterministic root.
  if (preflightOnly) args.push('--check', 'preflight-init', '--tags', 'preflight');
  else args.push('--check', 'final-evidence', '--tags', 'native-onboarding');
  return { executable, args };
}

function append(stream, file, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  fs.appendFileSync(file, text, 'utf8');
  if (stream === 'stdout' && process.env.NATIVE_ONBOARDING_FORWARD_STDOUT === '1')
    process.stdout.write(text);
  if (stream === 'stderr' && process.env.NATIVE_ONBOARDING_FORWARD_STDERR === '1')
    process.stderr.write(text);
}

function countNativeRequirements(subject) {
  const roots = [path.join(subject, 'specs')];
  let count = 0;
  const files = [];
  const walk = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.req.yaml')) {
        count += 1;
        files.push(path.relative(subject, file));
      }
    }
  };
  for (const root of roots) walk(root);
  return { count, files: files.sort() };
}

function assertUnannotatedSubject(subject) {
  const native = countNativeRequirements(subject);
  if (native.count > 0) {
    throw new Error(
      `subjectRoot already contains ${native.count} native requirement file(s); use a fresh unannotated checkout`
    );
  }
  for (const marker of ['proof.yaml', '.proof']) {
    if (fs.existsSync(path.join(subject, marker))) {
      throw new Error(`subjectRoot already contains ${marker}; use a fresh unannotated checkout`);
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).sort().join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function nativeRequirementDelta(output) {
  const load = name => {
    const file = path.join(output, name);
    try {
      if (!fs.existsSync(file)) {
        return { status: 'unknown', rows: null, reason: `${name} is missing` };
      }
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(rows)) {
        return { status: 'invalid', rows: null, reason: `${name} is not a JSON array` };
      }
      return { status: 'ok', rows, reason: null };
    } catch (error) {
      return {
        status: 'invalid',
        rows: null,
        reason: `${name} is not valid JSON: ${error.message}`,
      };
    }
  };
  const key = row => String(row.file_path || row.path || row.id || row.slug || stableJson(row));
  const baseline = load('requirements-baseline.json');
  const final = load('requirements-final.json');
  if (baseline.status !== 'ok') {
    return {
      value: null,
      status: baseline.status,
      reason: baseline.reason,
    };
  }
  if (final.status !== 'ok') {
    return {
      value: null,
      status: final.status,
      reason: final.reason,
    };
  }
  const before = new Map(baseline.rows.map(row => [key(row), stableJson(row)]));
  return {
    value: final.rows.filter(
      row => !before.has(key(row)) || before.get(key(row)) !== stableJson(row)
    ).length,
    status: 'computed',
    reason: null,
  };
}

const NATIVE_SPEC_ROOTS = [
  'specs/stakeholder',
  'specs/system',
  'specs/software',
  'specs/integration',
];

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function hasSymlinkComponent(subject, relative) {
  let current = subject;
  for (const component of relative.split(path.sep)) {
    if (!component || component === '.') continue;
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function collectNativeBundleFiles(subject) {
  const files = new Set();
  const collect = (relativeRoot, predicate) => {
    if (hasSymlinkComponent(subject, relativeRoot)) return;
    const walk = relative => {
      const absolute = path.join(subject, relative);
      let entries;
      try {
        entries = fs.readdirSync(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = path.join(relative, entry.name);
        const childAbsolute = path.join(subject, child);
        // lstat intentionally prevents symlinked files/directories from
        // escaping the explicit bundle whitelist.
        let stat;
        try {
          stat = fs.lstatSync(childAbsolute);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(child);
        else if (stat.isFile() && predicate(child)) files.add(child);
      }
    };
    walk(relativeRoot);
  };
  const collectDirect = (relativeRoot, predicate) => {
    if (hasSymlinkComponent(subject, relativeRoot)) return;
    const absoluteRoot = path.join(subject, relativeRoot);
    let entries;
    try {
      entries = fs.readdirSync(absoluteRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = path.join(relativeRoot, entry.name);
      const absolute = path.join(subject, relative);
      if (!isRegularFile(absolute)) continue;
      if (predicate(relative)) files.add(relative);
    }
  };

  for (const root of NATIVE_SPEC_ROOTS) {
    collect(root, relative => relative.endsWith('.req.yaml') || relative.endsWith('.vars.yaml'));
  }
  collectDirect('proof/checklists', relative => relative.endsWith('.state.yaml'));
  for (const relative of ['proof.yaml', 'docs/get-string-requirements.md']) {
    if (!hasSymlinkComponent(subject, relative) && isRegularFile(path.join(subject, relative))) {
      files.add(relative);
    }
  }
  return [...files].sort();
}

function copyNativeArtifacts(subject, output) {
  const copied = [];
  for (const relative of collectNativeBundleFiles(subject)) {
    const source = path.join(subject, relative);
    const destination = path.join(output, 'native', relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    copied.push(path.join('native', relative));
  }
  return copied.sort();
}

function captureSourceAnnotations(subject, output) {
  const relativePaths = ['.gitignore', 'parser.go', 'parser_test.go'];
  const relativeOutput = 'source-annotations.patch';
  const destination = path.join(output, relativeOutput);
  try {
    const diff = spawnSync(
      'git',
      ['-C', subject, 'diff', '--no-ext-diff', '--unified=3', '--', ...relativePaths],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    if (diff.error) throw diff.error;
    if (diff.status !== 0) {
      const reason = String(diff.stderr || `git diff exited with ${diff.status}`).trim();
      fs.writeFileSync(destination, `source annotation diff unavailable: ${reason}\n`, {
        mode: 0o600,
      });
      return { path: relativeOutput, status: 'error', reason };
    }
    fs.writeFileSync(destination, diff.stdout || '', { mode: 0o600 });
    return { path: relativeOutput, status: 'captured', reason: null };
  } catch (error) {
    const reason = String(error && error.message ? error.message : error);
    try {
      fs.writeFileSync(destination, `source annotation diff unavailable: ${reason}\n`, {
        mode: 0o600,
      });
    } catch {}
    return { path: relativeOutput, status: 'error', reason };
  }
}

function redactedEnvironment(env, subject, original, output) {
  return {
    cwd: subject,
    subject_root: subject,
    original_root: original,
    output_directory: output,
    use_codex: env.USE_CODEX === 'true',
    debug_ai_sessions: env.VISOR_DEBUG_AI_SESSIONS === 'true',
    proof_bin: env.PROOF_BIN,
    visor_bin: env.VISOR_BIN,
    ts_node_project: env.TS_NODE_PROJECT,
    code_home_set: Boolean(env.CODEX_HOME),
    auth_environment_present: Boolean(env.OPENAI_API_KEY || env.CODEX_AUTH_FILE || env.CODEX_HOME),
  };
}

async function runDemo(input) {
  const options = { ...input };
  const roots = validateRoots(options.subjectRoot, options.originalRoot);
  assertUnannotatedSubject(roots.subject);
  const proofBin = validateProofBin(options.proofBin || process.env.PROOF_BIN);
  const output = ensureOutputPath(
    options.output || fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-onboarding-')),
    roots.subject,
    roots.original
  );
  const visor = path.resolve(options.visorBin || defaultVisor());
  if (!fs.existsSync(visor)) throw new Error(`Visor entry does not exist: ${visor}`);
  const config = path.resolve(options.config || path.join(__dirname, 'visor.yaml'));
  if (!fs.existsSync(config)) throw new Error(`config does not exist: ${config}`);
  const stdoutFile = path.join(output, 'visor.stdout.log');
  const stderrFile = path.join(output, 'visor.stderr.log');
  fs.writeFileSync(stdoutFile, '', { mode: 0o600 });
  fs.writeFileSync(stderrFile, '', { mode: 0o600 });

  const env = {
    ...process.env,
    USE_CODEX: 'true',
    DISABLE_FALLBACK: '1',
    AUTO_FALLBACK: '0',
    PROOF_BIN: proofBin,
    VISOR_WORKSPACE_MAIN_PROJECT: roots.subject,
    VISOR_ORIGINAL_WORKDIR: roots.original,
    SUBJECT_ROOT: roots.subject,
    PROTECTED_ORIGINAL: roots.original,
    NATIVE_ONBOARDING_OUTPUT_DIR: output,
    VISOR_BIN: visor,
    VISOR_DEBUG_AI_SESSIONS: 'true',
    VISOR_TRACE_DIR: process.env.VISOR_TRACE_DIR || path.join(output, 'traces'),
    VISOR_DEBUG_ARTIFACTS: process.env.VISOR_DEBUG_ARTIFACTS || path.join(output, 'ai'),
  };
  if (visor.endsWith('.ts') && !env.TS_NODE_PROJECT) {
    env.TS_NODE_PROJECT = path.resolve(__dirname, '../../../tsconfig.json');
  }
  fs.writeFileSync(
    path.join(output, 'launch.json'),
    `${JSON.stringify(
      {
        version: 'urn:reqproof:native-onboarding-launch:v1',
        command: childCommand(visor, config, options.timeout || '1800000', options.preflightOnly),
        environment: redactedEnvironment(env, roots.subject, roots.original, output),
        preflight_only: Boolean(options.preflightOnly),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const command = childCommand(visor, config, options.timeout || '1800000', options.preflightOnly);
  const startedAt = new Date().toISOString();
  let interrupted = false;
  let child;
  const result = await new Promise(resolve => {
    child = spawn(command.executable, command.args, {
      cwd: roots.subject,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => append('stdout', stdoutFile, chunk));
    child.stderr.on('data', chunk => append('stderr', stderrFile, chunk));
    const stop = signal => {
      interrupted = true;
      try {
        child.kill(signal);
      } catch {}
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    child.on('error', error => resolve({ error }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const artifacts = countNativeRequirements(roots.subject);
  let copiedNativeArtifacts = [];
  try {
    copiedNativeArtifacts = copyNativeArtifacts(roots.subject, output);
  } catch (error) {
    // Preserve the primary run report even if a concurrently removed artifact
    // cannot be copied into the evidence directory.
    copiedNativeArtifacts = [`copy-error: ${error.message}`];
  }
  const sourceAnnotations = captureSourceAnnotations(roots.subject, output);
  const hasPreflightMarker = fs.existsSync(path.join(output, 'preflight-complete'));
  const hasFinalMarker = fs.existsSync(path.join(output, 'final-evidence-complete'));
  const requirementDelta = nativeRequirementDelta(output);
  const hasNativeArtifacts = artifacts.count > 0;
  const executionStatus =
    interrupted || result.signal
      ? 'interrupted'
      : result.error
        ? 'launcher-error'
        : result.code === 0
          ? 'execution-succeeded'
          : 'execution-failed';
  const terminalStatus =
    interrupted || result.signal
      ? 'interrupted'
      : options.preflightOnly
        ? result.error || result.code !== 0 || !hasPreflightMarker
          ? 'failed-preflight'
          : 'preflight-complete'
        : result.error || result.code !== 0 || !hasFinalMarker
          ? !hasNativeArtifacts
            ? 'failed-empty-native-requirements'
            : 'failed-execution-with-artifacts'
          : !hasNativeArtifacts
            ? 'failed-empty-native-requirements'
            : requirementDelta.status !== 'computed'
              ? 'failed-final-inventory-unknown'
              : requirementDelta.value === 0
                ? 'failed-empty-native-requirements'
                : 'execution-complete-review-required';
  const report = {
    version: 'urn:reqproof:agent-governance:native-onboarding:v1',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    execution_status: executionStatus,
    terminal_status: terminalStatus,
    exit_code: result.code === undefined ? null : result.code,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : null,
    preflight_only: Boolean(options.preflightOnly),
    model_calls: options.preflightOnly ? 0 : 'unknown',
    network_calls: options.preflightOnly ? 0 : 'unknown',
    subject: {
      root: roots.subject,
      protected_original: roots.original,
      implementation_behavior_changed_by_helper: false,
    },
    materialized: {
      native_requirement_count: artifacts.count,
      native_requirement_files: artifacts.files,
      native_requirement_delta_after_init: requirementDelta.value,
      native_requirement_delta_status: requirementDelta.status,
      native_requirement_delta_reason: requirementDelta.reason,
      copied_native_artifacts: copiedNativeArtifacts,
      proof_artifacts_present: fs.existsSync(path.join(roots.subject, 'proof.yaml')),
    },
    admission: {
      status: 'not_claimed',
      note: 'Exit status alone never proves Proof validation, review, or full-campaign admission.',
    },
    deferred: [
      'hazard-analysis',
      'broad-coverage',
      'history-mining',
      'interruption-resume',
      'selective-reruns',
      'full-campaign-admission',
    ],
    artifacts: {
      stdout: path.basename(stdoutFile),
      stderr: path.basename(stderrFile),
      launch: 'launch.json',
      command_output_directory: output,
      preflight_marker: hasPreflightMarker ? 'preflight-complete' : null,
      final_evidence_marker: hasFinalMarker ? 'final-evidence-complete' : null,
      source_annotations: sourceAnnotations,
    },
  };
  fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return { outputDirectory: output, report };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const result = await runDemo(options);
  process.stdout.write(
    `${JSON.stringify({ output_directory: result.outputDirectory, terminal_status: result.report.terminal_status })}\n`
  );
  if (
    result.report.execution_status !== 'execution-succeeded' ||
    (result.report.preflight_only
      ? result.report.terminal_status !== 'preflight-complete'
      : result.report.terminal_status !== 'execution-complete-review-required')
  ) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  childCommand,
  countNativeRequirements,
  isWithin,
  runDemo,
  validateProofBin,
  validateRoots,
};
