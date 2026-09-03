/*
 * EXP-0209 live-demo preflight, baseline child, and selective-resume child.
 *
 * The preflight proves the subject/evaluator boundary, the pinned local tool
 * chain, the Proof oracle, and the graph contract before baseline-only is
 * allowed to dispatch any governed/model work. Baseline-only and resume-only
 * live work is confined to their fresh internal child processes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import { qualifiedNestedExpansionOwner } from '../../../src/state-machine/graph/instance-plan';
import { StateMachineExecutionEngine } from '../../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import { createProofAdmissionCapability } from '../../../src/providers/proof-admission-cli-child';
import { withGovernedProbeRunnerBudget } from '../../../src/providers/governed-probe-runner';
import {
  validateProofCandidateEvidence,
} from '../../../src/providers/governed-proof-inspect-check-provider';
import {
  validateProofCandidateAdmissionBinding,
  validateProofComponentCandidateAdmissionBinding,
} from '../../../src/providers/proof-catalog-check-providers';
import {
  governedResultDigest,
  governedWireModeFromEvidence,
  proofCandidateEvidenceFingerprint,
  governedCanonicalJson,
  governedPayloadFingerprint,
  proofCanonicalJson,
} from '../../../src/providers/proof-wire';
import {
  canonicalGraphCheckpointJson,
  ExecutionJournal,
} from '../../../src/snapshot-store';
import { deriveProofProjectReconciliationParentClaimIds } from '../../../src/state-machine/graph/instance-kernel';

type JsonRecord = Record<string, any>;
type CommandResult = { status: number; stdout: string; stderr: string };

const REPO_ROOT = path.resolve(__dirname, '../../../');
const PROFILE_PATH = path.join(__dirname, 'visor.yaml');
const BASE_VISOR_COMMIT = '2f633faf';
const PROOF_COMMIT = 'b6662983f50d58c4fdede138fc0585627bd8cf8c';
const PROBE_VERSION = '0.6.0-rc332';
const CODEX_VERSION = '0.150.1';
const SUBJECT_FILES = [
  'entry.go',
  'go.mod',
  'http.go',
  'http_test.go',
  'service.go',
  'service_test.go',
  'store.go',
] as const;
const SUBJECT_SHA256: Record<string, string> = {
  'entry.go': '274207a0d307f800f9431a8e6ad79567dedea60f7edbc9f2351c6effd842f897',
  'go.mod': '0f48e9ffaefb5e8bb6568c171801fd151489b22a2df23ecaeb6dfdd06e5cda91',
  'http.go': '8456418dfa0abf25d7a1d43827397ca000b0121e3d7c6362aeb67698b7a2000d',
  'http_test.go': 'e242e388ebd5612b076457b65a7b9a6282dd295370b34fc31ebbb070f591aab4',
  'service.go': 'a5df87acddbd86c03bcff1f758e18610c77587151f87748e1bf83f9a93e976c9',
  'service_test.go': 'c363c8d6b326072abd39d4fdedca90efd4cc26fae0610e5bacc84c6fd32fa3b6',
  'store.go': 'c0e129c5695e5d56c70fc3bbd597f403dbe490bdae87c287ce00443ac3184c46',
};
const SUBJECT_TREE_SHA256 = '70fdbd2b22a444bd2685197dcb85d2a4164d098db7dd2e60249509e8ed1407ad';
const HIDDEN_TEST_SHA256 = '19e47a9847cbf32c1f29cad928b40cd71beb96ec9258cfbe8b3fa437505f2541';
const PATCH_SHA256 = 'c34a8efcc74c170ca9c169da4eea2a99ba5a15d12dea4af23935ab246ceeacaa';
const MANUAL_BASELINE_SHA256 = 'b8ede3472fbda6efa9fc21f7b707e6f14f0d073159cb5d521aceda5cbf9e6c83';
const PATCH_RESULT_TREE_SHA256 = '8afdd288cae0d3713d30b8cfdbaea7956dd684be3b0af0ccee781d4a179ef82f';
const INVENTORY_VERSION = 'proof.structural-inventory/v1';
const INVENTORY_AUTHORITY_VERSION = 'proof.project-authority/v1';
const INVENTORY_INPUT_OWNER = 'onboarding_structural_inventory';
const LIVE_SCRIPT = 'examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts';
const LIVE_FILES = new Set([
  LIVE_SCRIPT,
  'examples/agent-governance/exp-0209-discovery-egress/visor.yaml',
  'examples/agent-governance/exp-0209-discovery-egress/README.md',
  'tests/integration/exp-0209-discovery-egress.test.ts',
  'tests/integration/exp-0209-onboarding-quality.test.ts',
  'tests/unit/exp-0209-live-baseline-validator.test.ts',
  'tests/fixtures/proof-current-catalog-checkpoint-child.ts',
  'src/providers/governed-proof-inspect-check-provider.ts',
  'src/providers/governed-probe-runner.ts',
  'src/providers/proof-catalog-check-providers.ts',
  'tests/unit/providers/governed-proof-context.exp-0209.test.ts',
  'tests/unit/providers/governed-proof-inspect-check-provider.test.ts',
  'tests/unit/providers/governed-probe-runner.test.ts',
]);
const PRECHECK_ARTIFACT = 'preflight.json';
const EFFECTIVE_CONFIG_FILE = 'effective-config.yaml';
const BASELINE_CHECKPOINT_FILE = 'baseline.checkpoint.json';
const BASELINE_REPORT_FILE = 'baseline-report.json';
const BASELINE_REPORT_MARKDOWN_FILE = 'baseline-report.md';
const BASELINE_CHILD_FLAG = '--baseline-child';
const RESUME_CHILD_FLAG = '--resume-child';
const CONTROLLER_PID_FLAG = '--controller-pid';
const BASELINE_ROLE_RUN_LIMIT = 4;
const RESUME_STARTED_FILE = 'resume.started.json';
const RESUME_REVALIDATION_FILE = 'resume.revalidation.json';
const RESUME_WORK_ITEMS_FILE = 'resume.work-items.json';
const RESUME_INPUT_METADATA_FILE = 'resume-inputs.json';
const RESUME_CHECKPOINT_FILE = 'continued.checkpoint.json';
const RESUME_REPORT_FILE = 'resume-report.json';
const RESUME_REPORT_MARKDOWN_FILE = 'resume-report.md';
const RESUME_FAILURE_CHECKPOINT_FILE = 'resume-failure.checkpoint.json';
const RESUME_COMPLETED_FILE = 'resume.completed.json';
const EVALUATION_STARTED_FILE = 'evaluation.started.json';
const EVALUATION_FILE = 'evaluation.json';
const LIVE_REPORT_FILE = 'live-report.json';
const LIVE_REPORT_MARKDOWN_FILE = 'live-report.md';
const EVALUATION_COMPLETED_FILE = 'evaluation.completed.json';
const GRAPH_SOURCE_FILE = 'graph-source.yaml';
const OFFLINE_GO_ENV = {
  GOPROXY: 'off',
  GOSUMDB: 'off',
  GOTOOLCHAIN: 'local',
};

const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

function assertInvariant(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`preflight invariant failed: ${name}`);
}

function boundedText(value: string, limit = 16_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function command(
  executable: string,
  args: readonly string[],
  cwd = REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = spawnSync(executable, [...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${executable} ${args.join(' ')}: ${result.error.message}`);
  return {
    status: result.status === null ? -1 : result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function requireCommand(
  executable: string,
  args: readonly string[],
  cwd = REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = command(executable, args, cwd, env);
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed (${result.status}): ${boundedText(
        result.stderr || result.stdout,
      )}`,
    );
  }
  return result;
}

function packageJsonForResolution(
  specifier: string,
  resolved: string,
): { resolved: string; nearestPackageJson: string; packageJson: string; version: string } {
  // A package export may resolve to package/cjs/index.cjs while the nearest
  // package.json (package/cjs/package.json) is intentionally versionless. Walk
  // to the package.json whose name matches instead of requiring the blocked
  // `specifier/package.json` subpath.
  let directory = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  let nearest: string | undefined;
  let matching: { file: string; version: unknown } | undefined;
  while (true) {
    const candidate = path.join(directory, 'package.json');
    if (!nearest && fs.existsSync(candidate)) nearest = candidate;
    if (fs.existsSync(candidate)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(candidate, 'utf8')) as JsonRecord;
        if (metadata.name === specifier && metadata.version !== undefined) {
          matching = { file: candidate, version: metadata.version };
          break;
        }
      } catch {
        // Keep walking; the package root is still checked below.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  assertInvariant(`${specifier} package.json is discoverable`, matching && nearest);
  assertInvariant(`${specifier} package.json has a version`, typeof matching.version === 'string');
  return {
    resolved,
    nearestPackageJson: nearest as string,
    packageJson: matching.file,
    version: matching.version as string,
  };
}

function verifyLocalModules(): JsonRecord {
  const modules: JsonRecord = {};
  for (const specifier of ['@probelabs/probe', 'ts-node/register/transpile-only', 'js-yaml']) {
    let resolved: string;
    try {
      resolved = requireFromRepo.resolve(specifier);
    } catch (error) {
      throw new Error(`local module ${specifier} does not resolve: ${String(error)}`);
    }
    const metadata = packageJsonForResolution(
      specifier === 'ts-node/register/transpile-only' ? 'ts-node' : specifier,
      resolved,
    );
    modules[specifier] = metadata;
  }
  assertInvariant('@probelabs/probe requires the pinned local version', modules['@probelabs/probe'].version === PROBE_VERSION);
  const probe = requireFromRepo('@probelabs/probe') as JsonRecord;
  assertInvariant('@probelabs/probe exports ProbeAgent', typeof probe.ProbeAgent === 'function');
  const prototype = probe.ProbeAgent.prototype as JsonRecord;
  const requiredProbeMethods = ['initialize', 'answerGoverned', 'previewGovernedAnswerDispatch', 'close'];
  for (const method of requiredProbeMethods) assertInvariant(`ProbeAgent.prototype.${method} is available`, typeof prototype[method] === 'function');
  modules['@probelabs/probe'].probe_agent_api = requiredProbeMethods;
  return modules;
}

type LiveMode = 'preflight-only' | 'baseline-only' | 'baseline-child' | 'resume-only' | 'resume-child' | 'evaluate-only';

function parseArgs(argv: readonly string[]): {
  mode: LiveMode;
  outputDirectory: string;
  subjectDirectory: string;
  evaluatorDirectory: string;
  controllerPid?: number;
} {
  let preflightOnly = false;
  let baselineOnly = false;
  let baselineChild = false;
  let resumeOnly = false;
  let resumeChild = false;
  let evaluateOnly = false;
  let outputValue: string | undefined;
  let subjectValue: string | undefined;
  let evaluatorValue: string | undefined;
  let controllerPid: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--preflight-only') {
      preflightOnly = true;
      continue;
    }
    if (flag === '--baseline-only') {
      baselineOnly = true;
      continue;
    }
    if (flag === '--resume-only') {
      resumeOnly = true;
      continue;
    }
    if (flag === '--evaluate-only') {
      evaluateOnly = true;
      continue;
    }
    if (flag === BASELINE_CHILD_FLAG) {
      baselineChild = true;
      continue;
    }
    if (flag === RESUME_CHILD_FLAG) {
      resumeChild = true;
      continue;
    }
    if (flag === '--output' || flag === '--subject' || flag === '--evaluator') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
      index += 1;
      if (flag === '--output') outputValue = value;
      else if (flag === '--subject') subjectValue = value;
      else evaluatorValue = value;
      continue;
    }
    if (flag === CONTROLLER_PID_FLAG) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a PID`);
      index += 1;
      const parsed = Number(value);
      assertInvariant(`${CONTROLLER_PID_FLAG} is a positive integer`, Number.isSafeInteger(parsed) && parsed > 0);
      controllerPid = parsed;
      continue;
    }
    throw new Error(`unsupported option ${flag}`);
  }
  const selected = [preflightOnly, baselineOnly, baselineChild, resumeOnly, resumeChild, evaluateOnly].filter(Boolean).length;
  assertInvariant('exactly one live mode is selected', selected === 1);
  if (baselineChild || resumeChild) {
    assertInvariant(`${CONTROLLER_PID_FLAG} is required for the child`, controllerPid !== undefined);
    assertInvariant('child does not accept subject/evaluator paths', subjectValue === undefined && evaluatorValue === undefined);
  }
  const defaultSubject = '/Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/subject';
  const defaultEvaluator = '/Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/evaluator';
  return {
    mode: resumeChild ? 'resume-child' : baselineChild ? 'baseline-child' : evaluateOnly ? 'evaluate-only' : resumeOnly ? 'resume-only' : baselineOnly ? 'baseline-only' : 'preflight-only',
    outputDirectory: path.resolve(outputValue || path.join(os.tmpdir(), `visor-exp-0209-preflight-${process.pid}`)),
    subjectDirectory: path.resolve(subjectValue || defaultSubject),
    evaluatorDirectory: path.resolve(evaluatorValue || defaultEvaluator),
    controllerPid,
  };
}

function outputHint(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--output');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? path.resolve(value) : undefined;
}

function makePrivateDirectory(directory: string): void {
  fs.chmodSync(directory, 0o700);
}

function ensureFreshDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    assertInvariant(`temporary directory ${directory} is empty`, fs.readdirSync(directory).length === 0);
  } else {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}

function pathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}

function realDirectory(directory: string, label: string): string {
  assertInvariant(`${label} exists`, fs.existsSync(directory));
  const stat = fs.lstatSync(directory);
  assertInvariant(`${label} is a directory`, stat.isDirectory());
  return fs.realpathSync(directory);
}

type OutputState = { directory: string; owned: boolean };

function createOutput(
  directory: string,
  subjectDirectory: string,
  evaluatorDirectory: string,
  proofSource: string,
  state: OutputState,
): void {
  const target = path.resolve(directory);
  const parent = path.dirname(target);
  assertInvariant('output parent exists', fs.existsSync(parent));
  assertInvariant('output parent is a directory', fs.statSync(parent).isDirectory());
  const parentReal = fs.realpathSync(parent);
  const basename = path.basename(target);
  assertInvariant('output target has a safe basename', basename.length > 0 && basename !== '.' && basename !== '..');
  const projectedTarget = path.join(parentReal, basename);
  let existingTarget: fs.Stats | undefined;
  try {
    existingTarget = fs.lstatSync(target);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  assertInvariant('output target is absent', !existingTarget);
  assertInvariant('output target is not a symlink', !existingTarget?.isSymbolicLink());
  const home = fs.realpathSync(os.homedir());
  const root = path.parse(projectedTarget).root;
  assertInvariant('output target is not filesystem root', projectedTarget !== root);
  assertInvariant('output target is not home', projectedTarget !== home);
  assertInvariant('output target is not repository or an input tree', !pathsOverlap(projectedTarget, REPO_ROOT));
  assertInvariant('output target is not subject/evaluator/proof source', !pathsOverlap(projectedTarget, subjectDirectory) && !pathsOverlap(projectedTarget, evaluatorDirectory) && !pathsOverlap(projectedTarget, proofSource));
  assertInvariant('output parent resolves to a real directory', fs.statSync(parentReal).isDirectory());
  fs.mkdirSync(target, { mode: 0o700 });
  state.directory = target;
  state.owned = true;
  fs.chmodSync(target, 0o700);
  assertInvariant('output target resolves through its requested parent', fs.realpathSync(target) === projectedTarget);
}

function copyBaseline(subjectDirectory: string, destination: string): void {
  ensureFreshDirectory(destination);
  for (const file of SUBJECT_FILES) {
    const source = path.join(subjectDirectory, file);
    const stat = fs.lstatSync(source);
    assertInvariant(`subject file ${file} is a regular file`, stat.isFile());
    fs.copyFileSync(source, path.join(destination, file));
    fs.chmodSync(path.join(destination, file), 0o600);
  }
  fs.writeFileSync(path.join(destination, 'proof.yaml'), 'project:\n  name: journalservice\n', { mode: 0o600 });
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function pinnedInputs(subjectDirectory: string, evaluatorDirectory: string): JsonRecord {
  realDirectory(subjectDirectory, 'subject');
  realDirectory(evaluatorDirectory, 'evaluator');
  const subjectHashes: Record<string, string> = {};
  for (const file of SUBJECT_FILES) {
    const source = path.join(subjectDirectory, file);
    assertInvariant(`subject contains ${file}`, fs.existsSync(source));
    assertInvariant(`subject ${file} is a regular file`, fs.lstatSync(source).isFile());
    assertInvariant(`subject ${file} is not a symlink`, !fs.lstatSync(source).isSymbolicLink());
    const digest = sha256File(source);
    assertInvariant(`subject ${file} matches the pinned SHA-256`, digest === SUBJECT_SHA256[file]);
    subjectHashes[file] = digest;
  }
  const treeRecords = SUBJECT_FILES.map(file => `${subjectHashes[file]}  ${file}\n`).join('');
  const treeDigest = createHash('sha256').update(treeRecords).digest('hex');
  assertInvariant('subject tree matches the pinned manifest digest', treeDigest === SUBJECT_TREE_SHA256);
  const hiddenTest = path.join(evaluatorDirectory, 'hidden_missing_return_test.go');
  const patch = path.join(evaluatorDirectory, 'changes', '0001-reject-malformed-write.patch');
  assertInvariant('hidden evaluator oracle exists', fs.lstatSync(hiddenTest).isFile());
  assertInvariant('hidden evaluator oracle is not a symlink', !fs.lstatSync(hiddenTest).isSymbolicLink());
  assertInvariant('hidden evaluator oracle matches the pinned SHA-256', sha256File(hiddenTest) === HIDDEN_TEST_SHA256);
  assertInvariant('evaluator patch exists', fs.lstatSync(patch).isFile());
  assertInvariant('evaluator patch is not a symlink', !fs.lstatSync(patch).isSymbolicLink());
  assertInvariant('evaluator patch matches the pinned SHA-256', sha256File(patch) === PATCH_SHA256);
  return {
    subject_files: subjectHashes,
    subject_tree_sha256: treeDigest,
    hidden_test_sha256: HIDDEN_TEST_SHA256,
    patch_sha256: PATCH_SHA256,
  };
}

function initBaselineGit(workspace: string): JsonRecord {
  requireCommand('git', ['init', '-q'], workspace);
  requireCommand('git', ['config', 'user.email', 'visor-exp-0209@example.invalid'], workspace);
  requireCommand('git', ['config', 'user.name', 'Visor EXP-0209 preflight'], workspace);
  requireCommand('git', ['add', '--', ...SUBJECT_FILES, 'proof.yaml'], workspace);
  requireCommand('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'EXP-0209 preflight baseline'], workspace);
  const tracked = requireCommand('git', ['ls-files'], workspace).stdout.trim().split('\n').filter(Boolean).sort();
  const expected = [...SUBJECT_FILES, 'proof.yaml'].sort();
  assertInvariant('workspace tracks exactly the seven source files plus proof.yaml', JSON.stringify(tracked) === JSON.stringify(expected));
  const revision = requireCommand('git', ['rev-parse', 'HEAD'], workspace).stdout.trim();
  return { revision, tracked_files: tracked };
}

function verifyVisorBase(): JsonRecord {
  requireCommand('git', ['rev-parse', '--verify', `${BASE_VISOR_COMMIT}^{commit}`]);
  const ancestry = command('git', ['merge-base', '--is-ancestor', BASE_VISOR_COMMIT, 'HEAD']);
  assertInvariant(`Visor base ${BASE_VISOR_COMMIT} is an ancestor`, ancestry.status === 0);
  const names = new Set<string>();
  for (const args of [
    ['diff', '--name-only', `${BASE_VISOR_COMMIT}..HEAD`, '--'],
    ['diff', '--name-only', BASE_VISOR_COMMIT, '--'],
    ['diff', '--cached', '--name-only', BASE_VISOR_COMMIT, '--'],
  ] as const) {
    for (const name of requireCommand('git', args).stdout.split('\n').map(value => value.trim()).filter(Boolean)) names.add(name);
  }
  const changed = [...names].sort();
  assertInvariant('tracked changes since accepted base are limited to this live-demo slice', changed.every(name => LIVE_FILES.has(name)));
  const untracked = requireCommand('git', ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').map(value => value.trim()).filter(Boolean).sort();
  assertInvariant('untracked files are limited to this live-demo slice', untracked.every(name => LIVE_FILES.has(name)));
  return { commit: BASE_VISOR_COMMIT, is_ancestor: true, tracked_changes_since_base: changed, untracked_files: untracked, allowed: [...LIVE_FILES].sort() };
}

function copyBaselineFromWorkspace(workspace: string, destination: string): void {
  ensureFreshDirectory(destination);
  for (const file of SUBJECT_FILES) {
    fs.copyFileSync(path.join(workspace, file), path.join(destination, file));
    fs.chmodSync(path.join(destination, file), 0o600);
  }
  fs.copyFileSync(path.join(workspace, 'proof.yaml'), path.join(destination, 'proof.yaml'));
  fs.chmodSync(path.join(destination, 'proof.yaml'), 0o600);
}

function parseJsonOutput(stdout: string, label: string): JsonRecord {
  const trimmed = stdout.trim();
  try {
    const value = JSON.parse(trimmed) as JsonRecord;
    assertInvariant(`${label} is a JSON object`, value && typeof value === 'object' && !Array.isArray(value));
    return value;
  } catch (error) {
    throw new Error(`${label} is not one complete JSON object: ${String(error)}`);
  }
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function verifyInventory(proofBinary: string, workspace: string): JsonRecord {
  const result = requireCommand(proofBinary, ['onboarding', 'inventory'], workspace, {
    ...process.env,
    ...OFFLINE_GO_ENV,
  });
  const parsed = parseJsonOutput(result.stdout, 'Proof onboarding inventory');
  assertInvariant('Proof inventory has the pinned version', parsed.version === INVENTORY_VERSION);
  assertInvariant('Proof inventory top-level shape is exact', exactKeys(parsed, ['version', 'authority', 'sorted_paths', 'sorted_module_paths', 'boundary_fingerprint', 'input_state']));
  assertInvariant('Proof inventory boundary fingerprint is a digest', typeof parsed.boundary_fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(parsed.boundary_fingerprint));
  const expected = [...SUBJECT_FILES].sort();
  const authority = parsed.authority as JsonRecord;
  assertInvariant('Proof inventory authority is exact', authority && exactKeys(authority, ['version', 'project_id', 'subject_fingerprint', 'code_fingerprint', 'tests_fingerprint']));
  assertInvariant('Proof inventory authority is for journalservice', authority.version === INVENTORY_AUTHORITY_VERSION && authority.project_id === 'journalservice');
  for (const field of ['subject_fingerprint', 'code_fingerprint', 'tests_fingerprint']) assertInvariant(`Proof inventory authority ${field} is a digest`, typeof authority[field] === 'string' && /^sha256:[0-9a-f]{64}$/.test(authority[field]));
  const paths = parsed.sorted_paths;
  assertInvariant('Proof inventory sorted_paths is exact', Array.isArray(paths) && JSON.stringify(paths) === JSON.stringify(expected));
  assertInvariant('Proof inventory sorted_module_paths is exact', JSON.stringify(parsed.sorted_module_paths) === JSON.stringify(['go.mod']));
  const hashes = SUBJECT_SHA256;
  const expectedInputState = [
    ['entry.go', 'code'], ['http.go', 'code'], ['service.go', 'code'], ['store.go', 'code'],
    ['go.mod', 'project_metadata'], ['http_test.go', 'tests'], ['service_test.go', 'tests'],
  ].map(([file, inputKind]) => ({ owner_kind: INVENTORY_INPUT_OWNER, owner_id: 'journalservice', input_kind: inputKind, path: file, file_hash: `sha256:${hashes[file]}` }));
  assertInvariant('Proof inventory input_state mapping is exact', JSON.stringify(parsed.input_state) === JSON.stringify(expectedInputState));
  return {
    command: 'proof onboarding inventory',
    version: INVENTORY_VERSION,
    paths,
    expected_paths: expected,
    sorted_module_paths: ['go.mod'],
    input_state: expectedInputState,
    exact: true,
    authority,
    raw_sha256: createHash('sha256').update(result.stdout).digest('hex'),
  };
}

function buildProof(proofSource: string, outputDirectory: string): { binary: string; evidence: JsonRecord } {
  const sourceRoot = requireCommand('git', ['rev-parse', '--show-toplevel'], proofSource).stdout.trim();
  const commitCheck = command('git', ['cat-file', '-e', `${PROOF_COMMIT}^{commit}`], sourceRoot);
  assertInvariant(`Proof commit ${PROOF_COMMIT} exists`, commitCheck.status === 0);
  const archiveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp-0209-proof-archive-'));
  makePrivateDirectory(archiveDirectory);
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', PROOF_COMMIT], {
      cwd: sourceRoot,
      maxBuffer: 512 * 1024 * 1024,
    });
    execFileSync('tar', ['-xf', '-', '-C', archiveDirectory], { input: archive, maxBuffer: 32 * 1024 * 1024 });
    const toolchain = path.join(outputDirectory, 'toolchain');
    ensureFreshDirectory(toolchain);
    const binary = path.join(toolchain, 'proof');
    const build = requireCommand('go', ['build', '-trimpath', '-o', binary, './cmd/proof'], archiveDirectory, {
      ...process.env,
      ...OFFLINE_GO_ENV,
    });
    assertInvariant('pinned Proof binary exists', fs.statSync(binary).isFile());
    return {
      binary,
      evidence: {
        binary,
        binary_sha256: sha256File(binary),
        source_repo: sourceRoot,
        commit: PROOF_COMMIT,
        commit_exists: true,
        archive_source: `git archive ${PROOF_COMMIT}`,
        build_command: 'go build -trimpath -o <output>/toolchain/proof ./cmd/proof',
        build_environment: OFFLINE_GO_ENV,
        build_status: build.status,
        archive_cleaned: true,
      },
    };
  } finally {
    fs.rmSync(archiveDirectory, { recursive: true, force: true });
  }
}

function writeEffectiveConfig(outputDirectory: string, config: JsonRecord): JsonRecord {
  // Keep the runtime config human-readable and make its exact bytes part of
  // the child hand-off. The child re-reads these bytes; it never receives the
  // controller's in-memory config or any evaluator path.
  const file = path.join(outputDirectory, EFFECTIVE_CONFIG_FILE);
  const bytes = yaml.dump(config, { noRefs: true, lineWidth: -1 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return {
    file,
    sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'),
  };
}

function verifyCodex(): JsonRecord {
  const resolved = requireCommand('which', ['codex']).stdout.trim();
  const version = requireCommand('codex', ['--version']).stdout.trim();
  assertInvariant(`codex --version is ${CODEX_VERSION}`, version === `codex-cli ${CODEX_VERSION}` || version.endsWith(` ${CODEX_VERSION}`));
  const login = requireCommand('codex', ['login', 'status']);
  return {
    executable: resolved,
    version,
    required_version: CODEX_VERSION,
    login_status: boundedText((login.stdout || login.stderr).trim()),
  };
}

function resolveProjectRoleWithInput(
  proofBinary: string,
  workspace: string,
  invocation: JsonRecord,
  rootCheck: JsonRecord,
  config: JsonRecord,
): JsonRecord {
  const request = JSON.stringify(invocation);
  const result = spawnSync(proofBinary, ['resolve-role-invocation'], {
    cwd: workspace,
    input: request,
    encoding: 'utf8',
    env: { ...process.env, ...OFFLINE_GO_ENV },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Proof resolve-role-invocation failed (${result.status}): ${boundedText(String(result.stderr || result.error || ''))}`);
  const resolved = parseJsonOutput(String(result.stdout || ''), 'Proof resolved onboard role');
  assertInvariant('Proof resolved onboard role is shipped onboard', resolved.role_id === 'onboard' && resolved.role_source === 'builtin');
  assertInvariant('Proof resolved onboard role has instructions', typeof resolved.instructions === 'string' && resolved.instructions.length > 0);
  assertInvariant('Proof resolved onboard role has digest', typeof resolved.invocation_digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(resolved.invocation_digest));
  rootCheck.invocation = invocation;
  // Proof's shipped onboard role owns the system instructions.  The graph's
  // bounded specialization is carried by the authored user message below.
  rootCheck.instructions = resolved.instructions;
  rootCheck.invocation_digest = resolved.invocation_digest;
  rootCheck.result_schema = Buffer.from(String(invocation.output_schema), 'base64').toString('utf8');
  assertInvariant('resolved role schema is injected', rootCheck.result_schema.length > 0);
  config.subgraphs['discover-project'].checks.inspect = rootCheck;
  return {
    request: invocation,
    role_source: resolved.role_source,
    instructions_sha256: createHash('sha256').update(resolved.instructions).digest('hex'),
    invocation_digest: resolved.invocation_digest,
    output_schema_id: invocation.output_schema_id,
    output_schema_digest: resolved.output_schema_digest,
    result_schema: rootCheck.result_schema,
  };
}

function verifyGraph(config: JsonRecord): JsonRecord {
  const plan = compileClaimPlan(config);
  const inspectNodes: string[] = [];
  const profiles = new Set<string>();
  for (const [subgraphName, subgraph] of Object.entries(config.subgraphs || {})) {
    for (const [checkName, check] of Object.entries((subgraph as JsonRecord).checks || {})) {
      const checkRecord = check as JsonRecord;
      if (checkRecord.type === 'governed-proof-inspect') {
        inspectNodes.push(`${subgraphName}.${checkName}`);
        profiles.add(String(checkRecord.profile));
      }
    }
  }
  assertInvariant('graph max_parallelism is 3', config.max_parallelism === 3);
  assertInvariant('graph has two governed inspect nodes', inspectNodes.length === 2);
  assertInvariant('both governed inspect nodes use luna-xhigh-readonly-v1', profiles.size === 1 && profiles.has('luna-xhigh-readonly-v1'));
  assertInvariant('compiled graph digest is present', typeof plan.expansionPlan.graphSemanticDigest === 'string' && plan.expansionPlan.graphSemanticDigest.length > 0);
  return {
    max_parallelism: config.max_parallelism,
    governed_inspect_nodes: inspectNodes.sort(),
    profile: 'luna-xhigh-readonly-v1',
    graph_semantic_digest: plan.expansionPlan.graphSemanticDigest,
    compiled: true,
  };
}

function runWorkspaceTest(workspace: string): JsonRecord {
  const result = command('go', ['test', './...'], workspace, { ...process.env, ...OFFLINE_GO_ENV });
  assertInvariant('workspace public go test passes', result.status === 0);
  return { command: 'go test ./...', status: result.status, passed: true, stdout: boundedText(result.stdout), stderr: boundedText(result.stderr) };
}

function runHiddenOracle(workspace: string, evaluatorDirectory: string): JsonRecord {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp-0209-evaluator-'));
  makePrivateDirectory(directory);
  try {
    copyBaselineFromWorkspace(workspace, directory);
    const hiddenTest = path.join(evaluatorDirectory, 'hidden_missing_return_test.go');
    assertInvariant('evaluator supplies hidden_missing_return_test.go', fs.statSync(hiddenTest).isFile());
    fs.copyFileSync(hiddenTest, path.join(directory, 'hidden_missing_return_test.go'));
    fs.chmodSync(path.join(directory, 'hidden_missing_return_test.go'), 0o600);
    const result = command('go', ['test', './...'], directory, { ...process.env, ...OFFLINE_GO_ENV });
    assertInvariant('hidden evaluator oracle fails at baseline', result.status !== 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assertInvariant('hidden evaluator failure identifies the expected rejected write', output.includes('entries after rejected write = 1'));
    return {
      command: 'go test ./...',
      status: result.status,
      baseline_failed: true,
      hidden_test: 'hidden_missing_return_test.go',
      outside_workspace: !pathWithin(directory, workspace),
      cleaned: true,
      failure_marker: 'entries after rejected write = 1',
      stdout: boundedText(result.stdout),
      stderr: boundedText(result.stderr),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runPatchCheck(workspace: string, evaluatorDirectory: string): JsonRecord {
  let directory: string | undefined;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp-0209-patch-'));
    makePrivateDirectory(directory);
    copyBaselineFromWorkspace(workspace, directory);
    const patch = path.join(evaluatorDirectory, 'changes', '0001-reject-malformed-write.patch');
    assertInvariant('evaluator supplies the baseline patch', fs.statSync(patch).isFile());
    const result = command('git', ['apply', '--check', patch], directory);
    assertInvariant('baseline patch applies in a separate copy', result.status === 0);
    return {
      command: 'git apply --check 0001-reject-malformed-write.patch',
      status: result.status,
      applies: true,
      outside_workspace: !pathWithin(directory, workspace),
      cleaned: true,
    };
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

function preflight(
  outputDirectory: string,
  subjectDirectory: string,
  evaluatorDirectory: string,
  outputState: OutputState,
): JsonRecord {
  const subjectReal = realDirectory(subjectDirectory, 'subject');
  const evaluatorReal = realDirectory(evaluatorDirectory, 'evaluator');
  const proofSource = realDirectory(process.env.VISOR_PROOF_SOURCE_REPO || path.join(REPO_ROOT, '../reqforge'), 'Proof source');
  const inputPins = pinnedInputs(subjectReal, evaluatorReal);
  assertInvariant('subject and evaluator are separate trees', !pathsOverlap(subjectReal, evaluatorReal));
  createOutput(outputDirectory, subjectReal, evaluatorReal, proofSource, outputState);
  const workspace = path.join(outputDirectory, 'workspace');
  ensureFreshDirectory(workspace);
  const workspaceReal = fs.realpathSync(workspace);
  assertInvariant('evaluator is outside workspace', !pathWithin(evaluatorReal, workspaceReal));
  assertInvariant('workspace is outside evaluator', !pathWithin(workspaceReal, evaluatorReal));
  assertInvariant('subject is outside workspace', !pathWithin(subjectReal, workspaceReal) && !pathWithin(workspaceReal, subjectReal));
  assertInvariant('Proof source is outside workspace', !pathWithin(proofSource, workspaceReal) && !pathWithin(workspaceReal, proofSource));
  copyBaseline(subjectReal, workspace);
  const baselineGit = initBaselineGit(workspace);
  const visorBase = verifyVisorBase();
  const modules = verifyLocalModules();
  const codex = verifyCodex();
  const proof = buildProof(proofSource, outputDirectory);
  const workspaceTest = runWorkspaceTest(workspace);
  const evaluator = runHiddenOracle(workspace, evaluatorDirectory);
  const patch = runPatchCheck(workspace, evaluatorDirectory);
  const inventory = verifyInventory(proof.binary, workspace);
  const config = yaml.load(fs.readFileSync(PROFILE_PATH, 'utf8')) as JsonRecord;
  config.checks.project.value.projects[0].root = workspace;
  const role = resolveProjectRoleWithInput(
    proof.binary,
    workspace,
    {
      role_id: 'onboard',
      stance: 'owner',
      subject: {
        kind: 'project',
        id: inventory.authority.project_id,
        fingerprint: inventory.authority.subject_fingerprint,
      },
      output_schema_id: config.subgraphs['discover-project'].checks.inspect.invocation.output_schema_id,
      output_schema: config.subgraphs['discover-project'].checks.inspect.invocation.output_schema,
    },
    config.subgraphs['discover-project'].checks.inspect,
    config,
  );
  const graph = verifyGraph(config);
  const effectiveConfig = writeEffectiveConfig(outputDirectory, config);
  const workspaceFiles = fs.readdirSync(workspace).sort();
  assertInvariant('workspace is isolated from evaluator source', !pathWithin(evaluatorReal, workspaceReal) && !pathWithin(workspaceReal, evaluatorReal));
  assertInvariant('evaluator source is not copied into workspace', !workspaceFiles.includes('hidden_missing_return_test.go'));
  return {
    schema: 'urn:reqproof:agent-governance:exp-0209-preflight:v1',
    status: 'passed',
    mode: 'preflight-only',
    governed_calls: 0,
    model_calls: 0,
    network_dispatches_requested: 0,
    offline_go: true,
    pins: {
      visor_base: BASE_VISOR_COMMIT,
      proof_commit: PROOF_COMMIT,
      probe_version: PROBE_VERSION,
      ts_node_version: modules['ts-node/register/transpile-only'].version,
      js_yaml_version: modules['js-yaml'].version,
      codex_version: CODEX_VERSION,
      subject_files: inputPins.subject_files,
      subject_tree_sha256: inputPins.subject_tree_sha256,
      hidden_test_sha256: inputPins.hidden_test_sha256,
      patch_sha256: inputPins.patch_sha256,
    },
    call_counts: { governed: 0, model: 0 },
    isolation: {
      output: outputDirectory,
      owned_output: outputState.owned,
      output_mode: '0700',
      workspace,
      workspace_mode: '0700',
      workspace_files: workspaceFiles,
      subject_source: subjectReal,
      evaluator_source: evaluatorReal,
      proof_source: proofSource,
      evaluator_copies_outside_workspace: true,
      evaluator_not_in_workspace: true,
    },
    modules,
    codex,
    proof: proof.evidence,
    baseline: baselineGit,
    visor_base: visorBase,
    tests: { workspace: workspaceTest, oracle: evaluator, patch },
    inventory,
    role_resolution: role,
    graph,
    effective_config: effectiveConfig,
    baseline_contract: {
      maximum_role_runs: BASELINE_ROLE_RUN_LIMIT,
      expected_inspect_attempts: 4,
      retries: 0,
      fallback: false,
      discovered_components: 3,
    },
  };
}

export interface LiveBaselineCheckpointValidation {
  readonly sessionId: string;
  readonly graphSemanticDigest: string;
  readonly componentIds: readonly string[];
  readonly receiptId: string;
  readonly counts: Readonly<{
    inspectAttempts: number;
    proofCandidates: number;
    proofAdmissions: number;
    inspectTerminations: number;
    components: number;
    currentCatalogs: number;
    currentRevalidations: number;
    projectReconciliations: number;
  }>;
  readonly gatePassed: true;
}

function record(value: unknown, label: string): JsonRecord {
  assertInvariant(`${label} is an object`, !!value && typeof value === 'object' && !Array.isArray(value));
  return value as JsonRecord;
}

function array(value: unknown, label: string): readonly JsonRecord[] {
  assertInvariant(`${label} is an array`, Array.isArray(value));
  return value as readonly JsonRecord[];
}

function scopeKey(scope: unknown, label: string): string {
  const parts = array(scope, `${label} scope`);
  assertInvariant(`${label} scope is non-empty`, parts.length > 0);
  for (const [index, part] of parts.entries()) {
    assertInvariant(`${label} scope segment ${index} is keyed`, part.kind === 'keyed');
    assertInvariant(`${label} scope segment ${index} has an expansion owner`, typeof part.expansionOwnerCheck === 'string' && part.expansionOwnerCheck.length > 0);
    assertInvariant(`${label} scope segment ${index} has a key`, typeof part.key === 'string' && part.key.length > 0);
    assertInvariant(`${label} scope segment ${index} has a subgraph instance`, typeof part.subgraphInstanceId === 'string' && /^[0-9a-f]{64}$/.test(part.subgraphInstanceId));
  }
  return parts.map(part => `${part.expansionOwnerCheck}:${part.key}:${part.subgraphInstanceId}`).join('/');
}

function sameBinding(left: unknown, right: unknown): boolean {
  return canonicalGraphCheckpointJson(left) === canonicalGraphCheckpointJson(right);
}

function proofBindingForEvent(event: JsonRecord): JsonRecord {
  const scope = array(event.scope, 'Proof binding').map(segment => ({
    Kind: segment.kind,
    ...(segment.kind === 'keyed' ? {
      ExpansionOwnerCheck: segment.expansionOwnerCheck,
      Key: segment.key,
      SubgraphInstanceID: segment.subgraphInstanceId,
    } : { Check: segment.check, Index: segment.index }),
  }));
  return {
    ManagedRunID: event.managedRunId,
    SessionID: event.sessionId,
    CheckID: event.checkId,
    Scope: scope,
    NodeInstanceID: event.nodeInstanceId,
    NodeGenerationID: event.nodeGenerationId,
    AttemptID: event.attemptId,
    Fence: event.fence,
  };
}

/**
 * The journal's projection deliberately uses `proofCandidateEvidence` as its
 * storage name.  The catalog validators consume the narrower generated-claim
 * view (`proofAdmission`) so that controller/projection bookkeeping can never
 * accidentally become part of a Proof claim identity.
 */
function generatedClaimView(claim: JsonRecord, label: string): JsonRecord {
  assertInvariant(`${label} is a generated attempt claim`, claim.kind === 'generated-output' &&
    typeof claim.producerAttemptId === 'string' && Number.isSafeInteger(claim.producerFence));
  return {
    claimId: claim.claimId,
    claim: claim.claim,
    payload: claim.payload,
    payloadFingerprint: claim.payloadFingerprint,
    producerCheckId: claim.producerCheckId,
    scope: claim.scope,
    parentClaimIds: claim.parentClaimIds,
    wireMode: claim.wireMode,
    provenance: 'attempt',
    attemptId: claim.producerAttemptId,
    fence: claim.producerFence,
    ...(claim.proofCandidateEvidence ? { proofAdmission: claim.proofCandidateEvidence } : {}),
  };
}

/**
 * Shared candidate-side contract for baseline and continuation evidence. Keep
 * the full Probe attestation/result-identity checks in one place: a resume
 * candidate must be indistinguishable from a baseline governed inspection.
 */
function validateCandidateExecutionContract(
  candidate: JsonRecord,
  attempts: readonly JsonRecord[],
  label: string,
): { evidence: JsonRecord; attempt: JsonRecord; invocation: JsonRecord } {
  assertInvariant(`${label} is emitted by inspect`, candidate.producerCheckId === 'inspect' && candidate.checkId === 'inspect');
  assertInvariant(`${label} has its evidence sidecar`, candidate.proofCandidateEvidence !== undefined && typeof candidate.proofCandidateEvidenceFingerprint === 'string');
  const evidence = validateProofCandidateEvidence(candidate.proofCandidateEvidence) as JsonRecord;
  assertInvariant(`${label} evidence fingerprint is bound`, candidate.proofCandidateEvidenceFingerprint === proofCandidateEvidenceFingerprint(evidence));
  assertInvariant(`${label} evidence wire mode matches publication`, governedWireModeFromEvidence(evidence) === candidate.wireMode);
  const mode = governedWireModeFromEvidence(evidence);
  assertInvariant(`${label} wire mode matches its scope`, mode === (array(candidate.scope, `${label} scope`).length === 1 ? 'proof' : 'generic') && candidate.wireMode === mode);
  const payloadBytes = governedCanonicalJson(candidate.payload, mode);
  assertInvariant(`${label} payload fingerprint is bound`, candidate.payloadFingerprint === governedPayloadFingerprint(candidate.payload, mode));
  assertInvariant(`${label} identity digest matches payload`, evidence.probe.resultIdentity.resultDigest === governedResultDigest(candidate.payload, mode));
  assertInvariant(`${label} identity byte count matches payload`, evidence.probe.resultIdentity.canonicalBytes === Buffer.byteLength(payloadBytes, 'utf8'));
  const invocation = record(evidence.role.invocation, `${label} invocation`);
  assertInvariant(`${label} invocation is onboard owner`, invocation.role_id === 'onboard' && invocation.stance === 'owner');
  const attestation = record(evidence.probe.attestation, `${label} Probe attestation`);
  const requested = record(attestation.requested, `${label} requested attestation`);
  const observed = record(attestation.observed, `${label} observed attestation`);
  const dispatch = record(attestation.dispatch, `${label} Probe dispatch attestation`);
  assertInvariant(`${label} attestation uses Luna xhigh readonly never`, attestation.profileId === 'luna-xhigh-readonly-v1' && requested.model === 'gpt-5.6-luna' && requested.reasoningEffort === 'xhigh' && requested.sandbox === 'read-only' && requested.approvalPolicy === 'never' && observed.model === 'gpt-5.6-luna' && observed.modelProviderId === 'openai' && observed.reasoningEffort === 'xhigh' && observed.approvalPolicy === 'never' && observed.filesystem === 'restricted-read-root' && observed.network === 'restricted');
  assertInvariant(`${label} attestation binds the Probe dispatch`, dispatch.source === 'probe-host-tools-call' && dispatch.tool === 'codex' && typeof dispatch.promptDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(dispatch.promptDigest));
  const matchingAttempts = attempts.filter(value => value.nodeGenerationId === candidate.nodeGenerationId && value.attemptId === candidate.attemptId && value.fence === candidate.fence);
  assertInvariant(`${label} is bound to exactly one inspect attempt`, matchingAttempts.length === 1 && sameBinding(matchingAttempts[0].scope, candidate.scope));
  return { evidence, attempt: matchingAttempts[0], invocation };
}

/**
 * Shared admission-side contract. In addition to checking the exact Proof
 * decision wire and managed termination binding, this validates the projected
 * candidate/admission pair with the same catalog validator used by baseline.
 */
function validateAdmissionExecutionContract(
  admission: JsonRecord,
  candidate: JsonRecord,
  inspectTerminals: readonly JsonRecord[],
  projection: JsonRecord,
  label: string,
): JsonRecord {
  const parents = Array.isArray(admission.parentClaimIds) ? admission.parentClaimIds : [];
  assertInvariant(`${label} has exactly one candidate parent`, parents.length === 1 && parents[0] === candidate.claimId && sameBinding(candidate.scope, admission.scope));
  const payload = record(admission.payload, `${label} payload`);
  assertInvariant(`${label} retains Proof decision wire`, typeof payload.__proof_admission_wire === 'string' && payload.__proof_admission_wire.length > 0);
  const wire = record(JSON.parse(payload.__proof_admission_wire), `${label} decision wire`);
  const receipt = record(wire.receipt, `${label} receipt`);
  const depth = array(admission.scope, `${label} scope`).length;
  assertInvariant(`${label} decision is admitted`, wire.status === 'ADMITTED' && wire.reject_code === null && receipt.Status === 'ADMITTED' && receipt.Claim === 'proof.candidate@1' && receipt.ClaimID === candidate.claimId);
  const inspectTerminal = inspectTerminals.filter(value => {
    const binding = record(value.binding, `${label} inspect terminal binding`);
    return binding.nodeGenerationId === candidate.nodeGenerationId && binding.attemptId === candidate.attemptId && binding.fence === candidate.fence;
  });
  assertInvariant(`${label} has exactly one candidate managed termination`, inspectTerminal.length === 1);
  const terminal = inspectTerminal[0];
  const terminalBinding = record(terminal.binding, `${label} terminal binding`);
  assertInvariant(`${label} termination is clean/completed`, terminal.cleanupStatus === 'clean' && terminal.controllerDecision === 'completed' && terminal.failureCode === null && terminal.sessionId === candidate.sessionId);
  assertInvariant(`${label} termination binding is exact`, sameBinding(terminalBinding, {
    managedRunId: terminalBinding.managedRunId,
    sessionId: candidate.sessionId,
    checkId: candidate.checkId,
    scope: candidate.scope,
    nodeInstanceId: candidate.nodeInstanceId,
    nodeGenerationId: candidate.nodeGenerationId,
    attemptId: candidate.attemptId,
    fence: candidate.fence,
  }));
  const candidateBinding = proofBindingForEvent({ ...candidate, managedRunId: terminalBinding.managedRunId });
  assertInvariant(`${label} receipt binding matches inspect termination`, sameBinding(receipt.Binding, candidateBinding) && record(receipt.Termination, `${label} termination`).Type === 'ManagedRunTerminated' && sameBinding(record(receipt.Termination, `${label} termination`).Binding, candidateBinding));
  assertInvariant(`${label} receipt identity is present`, typeof receipt.receipt_id === 'string' && /^sha256:[0-9a-f]{64}$/.test(receipt.receipt_id));
  assertInvariant(`${label} version and subject kind match scope`, depth === 1 ? receipt.Version === 'proof.role-result-candidate-admission/v2' && record(receipt.Subject, `${label} project subject`).kind === 'project' : depth === 2 ? receipt.Version === 'proof.role-result-candidate-admission/v1' && record(receipt.Subject, `${label} component subject`).kind === 'component' : false);
  const candidateClaim = projection.claimsById?.[candidate.claimId];
  const admissionClaim = projection.claimsById?.[admission.claimId];
  assertInvariant(`${label} projected candidate/admission are active`, candidateClaim?.active === true && admissionClaim?.active === true);
  try {
    const candidateView = generatedClaimView(candidateClaim, `${label} candidate projection`);
    const admissionView = generatedClaimView(admissionClaim, `${label} admission projection`);
    if (depth === 1) validateProofCandidateAdmissionBinding(candidateView as any, admissionView as any);
    else validateProofComponentCandidateAdmissionBinding(candidateView as any, admissionView as any);
  } catch (error) {
    throw new Error(`${label} Proof admission binding is detached: ${error instanceof Error ? error.message : String(error)}`);
  }
  return receipt;
}

/**
 * Validate the complete, quiescent four-role baseline. This function only
 * consumes a checkpoint and compiled config: it performs no filesystem,
 * process, Probe, or Proof calls, which makes it safe to exercise in focused
 * zero-model tests.
 */
export function validateLiveBaselineCheckpoint(
  checkpoint: unknown,
  config: JsonRecord,
): LiveBaselineCheckpointValidation {
  const plan = compileClaimPlan(JSON.parse(JSON.stringify(config)) as any);
  const restored = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  const canonicalCheckpoint = canonicalGraphCheckpointJson(checkpoint);
  const reexported = canonicalGraphCheckpointJson(restored.exportGraphCheckpoint((checkpoint as JsonRecord).sessionId));
  assertInvariant('checkpoint restore/re-export is canonical and identical', canonicalCheckpoint === reexported);
  assertInvariant('checkpoint projection replay agrees', canonicalGraphCheckpointJson(restored.getInstanceProjection()) === canonicalGraphCheckpointJson(restored.replayInstanceProjection()));

  const envelope = record(checkpoint, 'baseline checkpoint');
  const events = array(envelope.events, 'baseline checkpoint events');
  assertInvariant('checkpoint session is non-empty', typeof envelope.sessionId === 'string' && envelope.sessionId.length > 0);
  assertInvariant('checkpoint graph digest is present', typeof envelope.graphSemanticDigest === 'string' && envelope.graphSemanticDigest === plan.expansionPlan.graphSemanticDigest);

  const attempts = events.filter(event => event.type === 'AttemptStarted' && event.checkId === 'inspect');
  assertInvariant('baseline has exactly four inspect attempts', attempts.length === 4);
  const projectAttempts = attempts.filter(event => array(event.scope, 'project inspect').length === 1);
  const componentAttempts = attempts.filter(event => array(event.scope, 'component inspect').length === 2);
  assertInvariant('baseline has one project inspect attempt', projectAttempts.length === 1);
  assertInvariant('baseline has three component inspect attempts', componentAttempts.length === 3);
  assertInvariant('inspect attempts have four unique bindings', new Set(attempts.map(event => `${event.nodeGenerationId}:${event.attemptId}`)).size === 4);
  const projectScope = projectAttempts[0].scope;
  const projectScopeParts = array(projectScope, 'project inspect').length === 1 ? array(projectScope, 'project inspect') : [];
  assertInvariant('project inspect expands from project', projectScopeParts[0]?.expansionOwnerCheck === 'project');
  const componentIds = componentAttempts.map(event => {
    const parts = array(event.scope, 'component inspect');
    assertInvariant('component inspect is nested under the authored project expansion', parts[0].expansionOwnerCheck === 'project' && parts[1].expansionOwnerCheck === qualifiedNestedExpansionOwner('discover-project', 'materialize_catalog'));
    return String(parts[1].key);
  });
  assertInvariant('discovery has exactly three distinct component ids', new Set(componentIds).size === 3);
  const componentScopeInstanceIds = componentAttempts.map(event => String(array(event.scope, 'component inspect')[1].subgraphInstanceId));
  assertInvariant('discovery has exactly three distinct component subgraph instances', new Set(componentScopeInstanceIds).size === 3);
  const sortedComponentIds = [...componentIds].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));

  const candidates = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1');
  assertInvariant('baseline has exactly four Proof candidates', candidates.length === 4);
  const projectCandidates = candidates.filter(event => array(event.scope, 'candidate').length === 1);
  const componentCandidates = candidates.filter(event => array(event.scope, 'candidate').length === 2);
  assertInvariant('baseline has one project Proof candidate', projectCandidates.length === 1);
  assertInvariant('baseline has three component Proof candidates', componentCandidates.length === 3);
  const candidateByScope = new Map<string, JsonRecord>();
  for (const candidate of candidates) {
    const key = scopeKey(candidate.scope, 'candidate');
    assertInvariant('candidate scopes are unique', !candidateByScope.has(key));
    candidateByScope.set(key, candidate);
    const { invocation } = validateCandidateExecutionContract(candidate, attempts, `candidate ${key}`);
    if (array(candidate.scope, 'project candidate').length === 1) {
      assertInvariant('project candidate uses Proof catalog schema', invocation.output_schema_id === 'proof.component-catalog-candidate@1');
      const payload = record(candidate.payload, 'project candidate payload');
      assertInvariant('project candidate names exactly three components', payload.version === 'proof.component-catalog-candidate/v1' && Array.isArray(payload.components) && payload.components.length === 3);
      const discovered = (payload.components as readonly JsonRecord[]).map(component => String(component.id));
      assertInvariant('project candidate component ids match inspect scopes', new Set(discovered).size === 3 && discovered.every(id => componentIds.includes(id)) && componentIds.every(id => discovered.includes(id)));
    } else {
      assertInvariant('component candidate uses onboarding schema', invocation.output_schema_id === 'reqproof.component-onboarding/v1');
    }
  }

  const projection = restored.getInstanceProjection() as any;
  const terminals = events.filter(event => event.type === 'ManagedRunTerminated');
  assertInvariant('all managed runs terminate cleanly and completed', terminals.every(event => event.cleanupStatus === 'clean' && event.controllerDecision === 'completed' && event.failureCode === null));
  const inspectTerminals = terminals.filter(event => record(event.binding, 'managed terminal binding').checkId === 'inspect');
  assertInvariant('baseline has exactly four inspect managed terminals', inspectTerminals.length === 4);
  assertInvariant('inspect managed terminals are unique and in this session', new Set(inspectTerminals.map(event => record(event.binding, 'inspect terminal binding').managedRunId)).size === 4 && inspectTerminals.every(event => event.sessionId === envelope.sessionId));
  for (const terminal of inspectTerminals) {
    const binding = record(terminal.binding, 'inspect terminal binding');
    const candidate = candidates.find(value => value.attemptId === binding.attemptId && value.fence === binding.fence && value.nodeGenerationId === binding.nodeGenerationId);
    assertInvariant('inspect terminal uniquely matches one candidate', candidate !== undefined && sameBinding(binding, {
      managedRunId: binding.managedRunId,
      sessionId: candidate.sessionId,
      checkId: candidate.checkId,
      scope: candidate.scope,
      nodeInstanceId: candidate.nodeInstanceId,
      nodeGenerationId: candidate.nodeGenerationId,
      attemptId: candidate.attemptId,
      fence: candidate.fence,
    }));
  }
  assertInvariant('no failed or cancelled runtime events exist', events.every(event => !['AttemptFailed', 'ManagedRunAcquisitionFailed', 'ManagedRunCancelRequested'].includes(String(event.type))));

  const admissions = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1');
  assertInvariant('baseline has exactly four Proof admissions', admissions.length === 4);
  const admittedCandidates = new Set<string>();
  for (const admission of admissions) {
    const parents = Array.isArray(admission.parentClaimIds) ? admission.parentClaimIds : [];
    assertInvariant('admission has exactly one candidate parent', parents.length === 1 && typeof parents[0] === 'string');
    const candidate = candidates.find(value => value.claimId === parents[0] && sameBinding(value.scope, admission.scope));
    assertInvariant('admission uniquely matches candidate', candidate !== undefined && !admittedCandidates.has(candidate.claimId));
    admittedCandidates.add(candidate.claimId);
    validateAdmissionExecutionContract(admission, candidate as JsonRecord, inspectTerminals, projection, `baseline admission ${admission.claimId}`);
  }
  assertInvariant('all four candidates have one admission', admittedCandidates.size === 4);
  const project = Object.values(projection.instancesById).find((instance: any) => instance.parentSubgraphInstanceId === undefined && instance.itemKey === projectScopeParts[0]?.key && instance.status === 'active') as any;
  assertInvariant('active project instance is present', project !== undefined);
  const children = Object.values(projection.instancesById).filter((instance: any) => instance.parentSubgraphInstanceId === project.subgraphInstanceId && instance.status === 'active') as any[];
  assertInvariant('current discovery has exactly three active component instances', children.length === 3 && new Set(children.map(instance => instance.itemKey)).size === 3 && new Set(children.map(instance => instance.subgraphInstanceId)).size === 3);
  assertInvariant('current component ids match discovery', new Set(children.map(instance => instance.itemKey)).size === new Set(componentIds).size && children.every(instance => componentIds.includes(instance.itemKey)));
  assertInvariant('current component instances match discovery scopes', children.every(instance => componentScopeInstanceIds.includes(instance.subgraphInstanceId)) && componentScopeInstanceIds.every(id => children.some(instance => instance.subgraphInstanceId === id)));
  const currentItems = Object.values(projection.claimsById).filter((claim: any) => claim.active && claim.claim === 'component.work_item@1' && claim.kind === 'controller-item' && claim.subgraphInstanceId !== project.subgraphInstanceId) as any[];
  assertInvariant('current WorkItems are exactly the three discovered components', currentItems.length === 3 && new Set(currentItems.map(claim => claim.payload.component_id)).size === 3 && currentItems.every(claim => componentIds.includes(claim.payload.component_id)) && currentItems.every(claim => children.some(instance => instance.subgraphInstanceId === claim.subgraphInstanceId && instance.itemKey === claim.payload.component_id)));
  const currentRevalidations = Object.values(projection.claimsById).filter((claim: any) => claim.active && claim.claim === 'proof.catalog_revalidation@1' && claim.subgraphInstanceId === project.subgraphInstanceId) as any[];
  const currentCatalogs = Object.values(projection.claimsById).filter((claim: any) => claim.active && claim.claim === 'component.catalog@1' && claim.subgraphInstanceId === project.subgraphInstanceId) as any[];
  const currentReceipts = Object.values(projection.claimsById).filter((claim: any) => claim.active && claim.claim === 'proof.project_reconciliation_receipt@1' && claim.subgraphInstanceId === project.subgraphInstanceId) as any[];
  const currentRevalidationPayload = currentRevalidations.length === 1 ? record(currentRevalidations[0].payload, 'current revalidation') : {};
  const currentRevalidationItems = Array.isArray(currentRevalidationPayload.work_items) ? array(currentRevalidationPayload.work_items, 'current revalidation work items') : [];
  assertInvariant('one current catalog revalidation exists', currentRevalidations.length === 1 && currentRevalidationItems.length === 3 && new Set(currentRevalidationItems.map(item => String(item.component_id))).size === 3 && componentIds.every(id => currentRevalidationItems.some(item => String(item.component_id) === id)));
  const currentCatalogPayload = currentCatalogs.length === 1 ? record(currentCatalogs[0].payload, 'current catalog') : {};
  const currentCatalogComponents = Array.isArray(currentCatalogPayload.components) ? array(currentCatalogPayload.components, 'current catalog components') : [];
  assertInvariant('one current three-item catalog exists', currentCatalogs.length === 1 && currentCatalogComponents.length === 3 && new Set(currentCatalogComponents.map(component => String(component.component_id))).size === 3 && componentIds.every(id => currentCatalogComponents.some(component => String(component.component_id) === id)));
  assertInvariant('one current project reconciliation receipt exists', currentReceipts.length === 1);
  const reconciliation = currentReceipts[0];
  const reconciliationGeneration = Object.values(projection.generationsById).find((generation: any) => generation.subgraphInstanceId === project.subgraphInstanceId && generation.checkId === 'project_reconcile' && generation.status === 'completed' && projection.activeGenerationIdByNode[generation.nodeInstanceId] === generation.nodeGenerationId) as any;
  assertInvariant('project reconciliation is current and complete', reconciliationGeneration !== undefined && reconciliationGeneration.completedOutputClaimIds.length === 1 && reconciliationGeneration.completedOutputClaimIds[0] === reconciliation.claimId);
  const expectedParents = deriveProofProjectReconciliationParentClaimIds(projection, reconciliationGeneration);
  assertInvariant('project reconciliation parents are the exact dynamic current set', JSON.stringify(reconciliation.parentClaimIds) === JSON.stringify(expectedParents));
  const reconciliationPayload = record(reconciliation.payload, 'project reconciliation receipt');
  assertInvariant('project reconciliation closes all three components', Array.isArray(reconciliationPayload.component_admissions) && reconciliationPayload.component_admissions.length === 3 && Array.isArray(reconciliationPayload.covered_work_item_digests) && reconciliationPayload.covered_work_item_digests.length === 3);
  assertInvariant('project reconciliation component rows are exact', new Set((reconciliationPayload.component_admissions as readonly JsonRecord[]).map(row => String(row.component_id))).size === 3 && [...(reconciliationPayload.component_admissions as readonly JsonRecord[])].every(row => componentIds.includes(String(row.component_id))));

  for (const child of children) {
    const childScope = child.scope;
    for (const checkId of ['inspect', 'proof_admit', 'verify']) {
      const starts = events.filter(event => event.type === 'AttemptStarted' && event.checkId === checkId && sameBinding(event.scope, childScope));
      const completes = events.filter(event => event.type === 'AttemptCompleted' && event.checkId === checkId && sameBinding(event.scope, childScope));
      assertInvariant(`component ${child.itemKey} ${checkId} starts exactly once`, starts.length === 1);
      assertInvariant(`component ${child.itemKey} ${checkId} completes exactly once`, completes.length === 1 && completes[0].attemptId === starts[0].attemptId && completes[0].fence === starts[0].fence);
      const generation = Object.values(projection.generationsById).filter((value: any) => value.subgraphInstanceId === child.subgraphInstanceId && value.checkId === checkId && value.status === 'completed' && projection.activeGenerationIdByNode[value.nodeInstanceId] === value.nodeGenerationId);
      assertInvariant(`component ${child.itemKey} ${checkId} current generation completes once`, generation.length === 1);
    }
  }
  const componentTerminations = terminals.filter(event => array(event.scope, 'component terminal').length === 2);
  assertInvariant('component managed terminal count includes all three inspections', componentTerminations.length >= 3);
  const firstComponentTerminal = Math.min(...componentTerminations.map(event => event.eventId));
  assertInvariant('all component inspect starts precede first component termination', componentAttempts.every(event => event.eventId < firstComponentTerminal));
  for (const generation of Object.values(projection.generationsById) as any[]) {
    if (projection.activeGenerationIdByNode[generation.nodeInstanceId] === generation.nodeGenerationId) assertInvariant('every current generation is completed', generation.status === 'completed');
  }
  const receiptId = typeof reconciliationPayload.receipt_id === 'string' ? reconciliationPayload.receipt_id : '';
  assertInvariant('project reconciliation receipt id is present', /^sha256:[0-9a-f]{64}$/.test(receiptId));
  return {
    sessionId: String(envelope.sessionId),
    graphSemanticDigest: String(envelope.graphSemanticDigest),
    componentIds: Object.freeze(sortedComponentIds),
    receiptId,
    counts: Object.freeze({ inspectAttempts: attempts.length, proofCandidates: candidates.length, proofAdmissions: admissions.length, inspectTerminations: inspectTerminals.length, components: children.length, currentCatalogs: currentCatalogs.length, currentRevalidations: currentRevalidations.length, projectReconciliations: currentReceipts.length }),
    gatePassed: true,
  };
}

export interface LiveResumeCheckpointValidation {
  readonly sessionId: string;
  readonly graphSemanticDigest: string;
  readonly changedComponentId: string;
  readonly changedPaths: readonly string[];
  readonly suffix: readonly string[];
  readonly receiptIds: Readonly<{ baseline: string; replacement: string }>;
  readonly counts: Readonly<{
    inspectAttempts: number;
    proofCandidates: number;
    proofAdmissions: number;
    inspectTerminations: number;
    components: number;
    workItems: number;
    componentAdmissions: number;
    projectReconciliations: number;
    mutationEventCount: number;
  }>;
  readonly gatePassed: true;
}

type LiveResumeValidationOptions = {
  readonly changedComponentId?: string;
  readonly changedComponent?: string;
  readonly changedPaths?: readonly string[];
  readonly mutationEventCount?: number;
};

function canonicalValue(value: unknown): string {
  return canonicalGraphCheckpointJson(value);
}

function projectionComponentSlice(projection: JsonRecord, componentId: string): JsonRecord {
  const instances = Object.values(projection.instancesById || {}).filter((value: any) => value.itemKey === componentId);
  const instanceIds = new Set(instances.map((value: any) => value.subgraphInstanceId));
  const generations = Object.values(projection.generationsById || {}).filter((value: any) => instanceIds.has((value as any).subgraphInstanceId));
  const claims = Object.values(projection.claimsById || {}).filter((value: any) => instanceIds.has((value as any).subgraphInstanceId));
  return {
    instances,
    generations,
    claims,
  };
}

function activeComponentInstances(projection: JsonRecord): JsonRecord[] {
  return Object.values(projection.instancesById || {}).filter((value: any) => value.status === 'active' && value.parentSubgraphInstanceId) as JsonRecord[];
}

function activeClaims(projection: JsonRecord, claim: string, scopeLength?: number): JsonRecord[] {
  return Object.values(projection.claimsById || {}).filter((value: any) => value.active === true && value.claim === claim && (scopeLength === undefined || value.scope?.length === scopeLength)) as JsonRecord[];
}

function eventScopeLength(event: JsonRecord): number {
  return Array.isArray(event.scope) ? event.scope.length : -1;
}

function suffixAttemptSequence(events: readonly JsonRecord[], baselineLength: number): {
  starts: JsonRecord[];
  suffix: JsonRecord[];
} {
  const suffix = events.slice(baselineLength);
  const starts = suffix.filter(event => event.type === 'AttemptStarted');
  assertInvariant('resume suffix has exactly four attempt starts', starts.length === 4);
  assertInvariant('resume suffix dispatches inspect, proof_admit, verify, project_reconcile exactly once',
    canonicalValue(starts.map(event => event.checkId)) === canonicalValue(['inspect', 'proof_admit', 'verify', 'project_reconcile']));
  for (const [index, start] of starts.entries()) {
    const completes = suffix.filter(event => event.type === 'AttemptCompleted' && event.checkId === start.checkId && event.attemptId === start.attemptId && event.fence === start.fence && event.nodeGenerationId === start.nodeGenerationId);
    assertInvariant(`resume ${start.checkId} attempt completes exactly once`, completes.length === 1);
    if (index < 3) assertInvariant(`resume ${start.checkId} is scoped to the changed component`, eventScopeLength(start) === 2);
    else assertInvariant('resume project reconciliation is project-scoped', eventScopeLength(start) === 1);
  }
  return { starts, suffix };
}

/**
 * Validate one selective Proof continuation without starting a provider. The
 * baseline and continuation must be quiescent Graph-v2 checkpoints from the
 * same effective config. The optional fourth argument is intentionally plain
 * data so focused tests can exercise the complete gate with zero model calls.
 */
export function validateLiveResumeCheckpoint(
  checkpoint: unknown,
  baselineCheckpoint: unknown,
  config: JsonRecord,
  options: LiveResumeValidationOptions = {},
): LiveResumeCheckpointValidation {
  // Permit callers that naturally write (checkpoint, config, baseline,
  // options) while retaining the documented continuation-first form.
  if (!(baselineCheckpoint as any)?.events && (config as any)?.events) {
    const swapped = baselineCheckpoint;
    baselineCheckpoint = config;
    config = swapped as JsonRecord;
  }
  const plan = compileClaimPlan(JSON.parse(JSON.stringify(config)) as any);
  const baselineEnvelope = record(baselineCheckpoint, 'resume baseline checkpoint');
  const envelope = record(checkpoint, 'resume checkpoint');
  const baselineEvents = array(baselineEnvelope.events, 'resume baseline events');
  const events = array(envelope.events, 'resume events');
  const baselineCanonical = canonicalValue(baselineCheckpoint);
  const canonical = canonicalValue(checkpoint);
  assertInvariant('resume baseline restores and re-exports canonically',
    canonicalValue(ExecutionJournal.restoreGraphCheckpoint(plan, baselineCheckpoint).exportGraphCheckpoint(baselineEnvelope.sessionId)) === baselineCanonical);
  const restored = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  assertInvariant('resume restores and re-exports canonically', canonicalValue(restored.exportGraphCheckpoint(envelope.sessionId)) === canonical);
  assertInvariant('resume projection replay agrees', canonicalValue(restored.getInstanceProjection()) === canonicalValue(restored.replayInstanceProjection()));
  const baselineGate = validateLiveBaselineCheckpoint(baselineCheckpoint, config);
  assertInvariant('resume session is the accepted baseline session', envelope.sessionId === baselineGate.sessionId);
  assertInvariant('resume graph digest is the accepted baseline digest', envelope.graphSemanticDigest === baselineGate.graphSemanticDigest && envelope.graphSemanticDigest === plan.expansionPlan.graphSemanticDigest);
  assertInvariant('resume event prefix is byte-identical to baseline', canonicalValue(events.slice(0, baselineEvents.length)) === canonicalValue(baselineEvents));
  assertInvariant('resume appends at least one event', events.length > baselineEvents.length);

  const projection = restored.getInstanceProjection() as any;
  const baselineProjection = ExecutionJournal.restoreGraphCheckpoint(plan, baselineCheckpoint).getInstanceProjection() as any;
  const components = activeComponentInstances(projection);
  assertInvariant('resume retains exactly three active components', components.length === 3 && new Set(components.map(value => value.itemKey)).size === 3);
  const componentIds = components.map(value => String(value.itemKey)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  assertInvariant('resume component set matches baseline', canonicalValue(componentIds) === canonicalValue([...baselineGate.componentIds]));

  const baselineSlices = new Map(baselineGate.componentIds.map(id => [id, projectionComponentSlice(baselineProjection, id)]));
  const finalSlices = new Map(componentIds.map(id => [id, projectionComponentSlice(projection, id)]));
  const changedBySlice = componentIds.filter(id => canonicalValue(baselineSlices.get(id)) !== canonicalValue(finalSlices.get(id)));
  const inferredChanged = changedBySlice.length === 1 ? changedBySlice[0] : undefined;
  const changedComponentId = options.changedComponentId || options.changedComponent || inferredChanged || '';
  assertInvariant('exactly one component slice changed', changedBySlice.length === 1 && changedComponentId === inferredChanged);
  assertInvariant('changed component is active and known', componentIds.includes(changedComponentId));

  const baselineItems = activeClaims(baselineProjection, 'component.work_item@1', 2);
  const finalItems = activeClaims(projection, 'component.work_item@1', 2);
  assertInvariant('resume has exactly three current WorkItems', finalItems.length === 3 && new Set(finalItems.map(value => value.payload.component_id)).size === 3);
  const baselineItemByComponent = new Map(baselineItems.map(value => [String(value.payload.component_id), value]));
  const finalItemByComponent = new Map(finalItems.map(value => [String(value.payload.component_id), value]));
  assertInvariant('baseline and current WorkItems close the same three components', componentIds.every(id => baselineItemByComponent.has(id) && finalItemByComponent.has(id)));
  const changedItems = componentIds.filter(id => canonicalValue(baselineItemByComponent.get(id)?.payload) !== canonicalValue(finalItemByComponent.get(id)?.payload));
  assertInvariant('exactly one of three WorkItem authorities/input states changed', changedItems.length === 1 && changedItems[0] === changedComponentId);
  for (const id of componentIds.filter(value => value !== changedComponentId)) {
    assertInvariant(`unchanged ${id} WorkItem is byte-identical`, canonicalValue(baselineItemByComponent.get(id)?.payload) === canonicalValue(finalItemByComponent.get(id)?.payload));
    assertInvariant(`unchanged ${id} component projection slice is byte-identical`, canonicalValue(baselineSlices.get(id)) === canonicalValue(finalSlices.get(id)));
  }
  const changedItem = record(finalItemByComponent.get(changedComponentId), 'changed WorkItem');
  const changedPaths = [...(options.changedPaths || [])].map(String).sort();
  const baselineChangedItem = record(baselineItemByComponent.get(changedComponentId), 'baseline changed WorkItem');
  const changedInputPaths = array(changedItem.payload.proof_input_state, 'changed WorkItem input state').filter(row => {
    const value = String(row.path);
    const before = (baselineChangedItem.payload.proof_input_state as readonly JsonRecord[]).find(previous => previous.path === value);
    return !before || before.file_hash !== row.file_hash;
  }).map(value => String(value.path)).sort();
  const effectiveChangedPaths = changedPaths.length > 0 ? changedPaths : changedInputPaths;
  assertInvariant('resume changed paths are non-empty', effectiveChangedPaths.length > 0);
  assertInvariant('changed WorkItem owns every changed path', effectiveChangedPaths.every(file => Array.isArray(changedItem.payload.sorted_owned_paths) && changedItem.payload.sorted_owned_paths.includes(file)));
  assertInvariant('changed WorkItem input state changes every changed path', effectiveChangedPaths.every(file => changedInputPaths.includes(file)));

  const suffixResult = suffixAttemptSequence(events, baselineEvents.length);
  const suffix = suffixResult.suffix;
  const newCandidates = suffix.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1');
  const newAdmissions = suffix.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1');
  const newTerminals = suffix.filter(event => event.type === 'ManagedRunTerminated' && record(event.binding, 'resume terminal binding').checkId === 'inspect');
  assertInvariant('resume adds exactly one governed candidate, admission, and clean inspect termination', newCandidates.length === 1 && newAdmissions.length === 1 && newTerminals.length === 1);
  const newCandidate = newCandidates[0];
  const newAdmission = newAdmissions[0];
  assertInvariant('new candidate and admission are changed-component scoped', eventScopeLength(newCandidate) === 2 && eventScopeLength(newAdmission) === 2 && sameBinding(newCandidate.scope, newAdmission.scope));
  assertInvariant('new component admission is active in the current projection', projection.claimsById[newAdmission.claimId]?.active === true);
  const candidateScopeParts = array(newCandidate.scope, 'resume candidate scope');
  assertInvariant('new candidate scope names the changed component', String(candidateScopeParts[candidateScopeParts.length - 1].key) === changedComponentId);
  validateCandidateExecutionContract(newCandidate, suffixResult.starts, 'resume candidate');
  validateAdmissionExecutionContract(newAdmission, newCandidate, newTerminals, projection, 'resume admission');

  const candidates = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1');
  const admissions = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1');
  const inspectAttempts = events.filter(event => event.type === 'AttemptStarted' && event.checkId === 'inspect');
  const inspectTerminations = events.filter(event => event.type === 'ManagedRunTerminated' && record(event.binding, 'inspect terminal').checkId === 'inspect');
  assertInvariant('resume totals are exactly five candidates/admissions/inspects', candidates.length === 5 && admissions.length === 5 && inspectAttempts.length === 5 && inspectTerminations.length === 5);
  const componentAdmissions = admissions.filter(event => eventScopeLength(event) === 2);
  assertInvariant('resume has exactly three current component admissions', activeClaims(projection, 'proof.admitted_receipt@1', 2).length === 3 && componentAdmissions.length === 4);

  const oldItem = baselineItemByComponent.get(changedComponentId) as JsonRecord;
  const currentItem = finalItemByComponent.get(changedComponentId) as JsonRecord;
  assertInvariant('old changed WorkItem is inactive and replacement is current', projection.claimsById[oldItem.claimId]?.active === false && projection.claimsById[currentItem.claimId]?.active === true && oldItem.claimId !== currentItem.claimId);
  const oldComponentClaims = Object.values(baselineProjection.claimsById || {}).filter((value: any) => value.subgraphInstanceId === oldItem.subgraphInstanceId && ['proof.candidate@1', 'proof.admitted_receipt@1'].includes(value.claim)) as JsonRecord[];
  for (const oldClaim of oldComponentClaims) assertInvariant(`old changed ${oldClaim.claim} is inactive`, projection.claimsById[oldClaim.claimId]?.active === false);
  const currentComponentClaims = activeClaims(projection, 'proof.admitted_receipt@1', 2).filter(value => value.subgraphInstanceId === currentItem.subgraphInstanceId);
  assertInvariant('changed component has one current replacement admission', currentComponentClaims.length === 1 && currentComponentClaims[0].active === true);
  const changedCurrentGenerations = Object.values(projection.generationsById || {}).filter((value: any) => value.subgraphInstanceId === currentItem.subgraphInstanceId && value.status === 'completed' && projection.activeGenerationIdByNode[value.nodeInstanceId] === value.nodeGenerationId);
  assertInvariant('changed component current inspect/proof_admit/verify generations are complete', ['inspect', 'proof_admit', 'verify'].every(checkId => changedCurrentGenerations.some((value: any) => value.checkId === checkId)));

  const baselineProject = Object.values(baselineProjection.instancesById).find((value: any) => value.itemKey === 'journalservice' && !value.parentSubgraphInstanceId) as JsonRecord | undefined;
  const finalProject = Object.values(projection.instancesById).find((value: any) => value.itemKey === 'journalservice' && !value.parentSubgraphInstanceId && value.status === 'active') as JsonRecord | undefined;
  assertInvariant('baseline and current project instances exist', !!baselineProject && !!finalProject);
  const projectReconcileGenerations = Object.values(projection.generationsById).filter((value: any) => value.subgraphInstanceId === finalProject?.subgraphInstanceId && value.checkId === 'project_reconcile') as JsonRecord[];
  const baselineProjectGeneration = Object.values(baselineProjection.generationsById).find((value: any) => value.subgraphInstanceId === baselineProject?.subgraphInstanceId && value.checkId === 'project_reconcile' && value.status === 'completed') as JsonRecord | undefined;
  const currentProjectGeneration = projectReconcileGenerations.find(value => value.status === 'completed' && projection.activeGenerationIdByNode[value.nodeInstanceId] === value.nodeGenerationId);
  assertInvariant('old project reconciliation generation is inactive and new one is active/complete', !!baselineProjectGeneration && projection.generationsById[baselineProjectGeneration.nodeGenerationId]?.status === 'inactive' && !!currentProjectGeneration && currentProjectGeneration.nodeGenerationId !== baselineProjectGeneration.nodeGenerationId);
  const baselineReceipt = activeClaims(baselineProjection, 'proof.project_reconciliation_receipt@1', 1)[0];
  const currentReceipts = activeClaims(projection, 'proof.project_reconciliation_receipt@1', 1);
  assertInvariant('old project reconciliation receipt is inactive and new receipt is active', !!baselineReceipt && projection.claimsById[baselineReceipt.claimId]?.active === false && currentReceipts.length === 1 && currentReceipts[0].claimId !== baselineReceipt.claimId);
  assertInvariant('new reconciliation generation emits the new receipt', currentProjectGeneration.completedOutputClaimIds.length === 1 && currentProjectGeneration.completedOutputClaimIds[0] === currentReceipts[0].claimId);
  const currentReceiptPayload = record(currentReceipts[0].payload, 'current reconciliation receipt');
  assertInvariant('current reconciliation closes three components', Array.isArray(currentReceiptPayload.component_admissions) && currentReceiptPayload.component_admissions.length === 3 && Array.isArray(currentReceiptPayload.covered_work_item_digests) && currentReceiptPayload.covered_work_item_digests.length === 3);
  const expectedParents = deriveProofProjectReconciliationParentClaimIds(projection, currentProjectGeneration);
  assertInvariant('new reconciliation has exact current parent claims', canonicalValue(currentReceipts[0].parentClaimIds) === canonicalValue(expectedParents));
  for (const generation of Object.values(projection.generationsById || {}) as JsonRecord[]) {
    if (projection.activeGenerationIdByNode[generation.nodeInstanceId] === generation.nodeGenerationId) assertInvariant(`current ${generation.checkId} generation is complete`, generation.status === 'completed');
  }

  const appliedHeaders = suffix.filter(event => event.type === 'ProofCurrentCatalogAuthorityApplied');
  assertInvariant('resume applies one non-empty Proof authority batch', appliedHeaders.length === 1 && Number.isSafeInteger(appliedHeaders[0].mutationEventCount) && appliedHeaders[0].mutationEventCount > 0);
  assertInvariant('Proof authority application is bound to its preceding record', suffix[0].type === 'ProofCurrentCatalogAuthorityRecorded' && suffix[1].type === 'ProofCurrentCatalogAuthorityApplied' && suffix[0].authorityId === suffix[1].authorityId && suffix[1].projectSubgraphInstanceId === finalProject.subgraphInstanceId);
  if (options.mutationEventCount !== undefined) assertInvariant('recorded Proof mutation count matches controller evidence', options.mutationEventCount === appliedHeaders[0].mutationEventCount);
  const mutationEventCount = Number(appliedHeaders[0].mutationEventCount);
  const dispatchSuffix = Object.freeze(suffixResult.starts.map((start, index) => index < 3 ? `${changedComponentId}:${start.checkId}` : 'journalservice:project_reconcile'));

  return {
    sessionId: String(envelope.sessionId),
    graphSemanticDigest: String(envelope.graphSemanticDigest),
    changedComponentId,
    changedPaths: Object.freeze(effectiveChangedPaths),
    suffix: dispatchSuffix,
    receiptIds: Object.freeze({ baseline: String(record(baselineReceipt.payload, 'baseline reconciliation receipt').receipt_id), replacement: String(currentReceiptPayload.receipt_id) }),
    counts: Object.freeze({ inspectAttempts: inspectAttempts.length, proofCandidates: candidates.length, proofAdmissions: admissions.length, inspectTerminations: inspectTerminations.length, components: components.length, workItems: finalItems.length, componentAdmissions: activeClaims(projection, 'proof.admitted_receipt@1', 2).length, projectReconciliations: currentReceipts.length, mutationEventCount }),
    gatePassed: true,
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const baselinePrInfo = {
  number: 1,
  title: 'EXP-0209 live baseline',
  body: '',
  author: 'visor-exp-0209',
  base: 'main',
  head: 'baseline',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as import('../../../src/pr-analyzer').PRInfo;

function baselineArtifact(outputDirectory: string): { preflight: JsonRecord; config: JsonRecord; workspace: string; proofBinary: string } {
  const preflightPath = path.join(outputDirectory, PRECHECK_ARTIFACT);
  assertInvariant('preflight artifact exists', fs.existsSync(preflightPath));
  const preflight = record(JSON.parse(fs.readFileSync(preflightPath, 'utf8')), 'preflight artifact');
  assertInvariant('preflight artifact has the expected accepted schema', preflight.schema === 'urn:reqproof:agent-governance:exp-0209-preflight:v1' && preflight.status === 'passed');
  assertInvariant('preflight artifact has no prior governed/model dispatch', preflight.governed_calls === 0 && preflight.model_calls === 0 && preflight.network_dispatches_requested === 0);
  const isolation = record(preflight.isolation, 'preflight isolation');
  const workspace = realDirectory(String(isolation.workspace), 'preflight workspace');
  assertInvariant('preflight workspace is owned by this output', pathWithin(workspace, outputDirectory));
  const effective = record(preflight.effective_config, 'effective config metadata');
  const effectiveFile = path.resolve(String(effective.file));
  assertInvariant('effective config is the output-owned file', effectiveFile === path.join(path.resolve(outputDirectory), EFFECTIVE_CONFIG_FILE));
  const effectiveStat = fs.lstatSync(effectiveFile);
  assertInvariant('effective config is a private regular file', effectiveStat.isFile() && !effectiveStat.isSymbolicLink() && (effectiveStat.mode & 0o777) === 0o600);
  const effectiveBytes = fs.readFileSync(effectiveFile);
  assertInvariant('effective config bytes match preflight', createHash('sha256').update(effectiveBytes).digest('hex') === effective.sha256);
  const config = record(yaml.load(effectiveBytes.toString('utf8')), 'effective config');
  const proof = record(preflight.proof, 'preflight Proof evidence');
  assertInvariant('preflight Proof commit is pinned', proof.commit === PROOF_COMMIT);
  const proofBinary = path.resolve(String(proof.binary));
  assertInvariant('pinned Proof binary is output-owned', proofBinary === path.join(path.resolve(outputDirectory), 'toolchain', 'proof'));
  const proofStat = fs.lstatSync(proofBinary);
  assertInvariant('pinned Proof binary is a regular executable', proofStat.isFile() && !proofStat.isSymbolicLink() && (proofStat.mode & 0o111) !== 0);
  assertInvariant('pinned Proof binary bytes match preflight', sha256File(proofBinary) === proof.binary_sha256);
  const plan = compileClaimPlan(JSON.parse(JSON.stringify(config)) as any);
  const graph = record(preflight.graph, 'preflight graph');
  assertInvariant('effective config graph digest matches preflight', graph.graph_semantic_digest === plan.expansionPlan.graphSemanticDigest);
  const contract = record(preflight.baseline_contract, 'baseline contract');
  assertInvariant('baseline contract has the four-role ceiling', contract.maximum_role_runs === BASELINE_ROLE_RUN_LIMIT && contract.expected_inspect_attempts === 4 && contract.discovered_components === 3);
  assertInvariant('baseline contract disables retries and fallback', contract.retries === 0 && contract.fallback === false);
  return { preflight, config, workspace, proofBinary };
}

function validateBaselineWorkspace(preflight: JsonRecord, workspace: string): void {
  const expectedTracked = [...SUBJECT_FILES, 'proof.yaml'].sort();
  const baseline = record(preflight.baseline, 'preflight baseline git evidence');
  assertInvariant('workspace HEAD is the accepted preflight revision', requireCommand('git', ['rev-parse', 'HEAD'], workspace).stdout.trim() === baseline.revision);
  assertInvariant('preflight recorded the exact expected tracked files', JSON.stringify(baseline.tracked_files) === JSON.stringify(expectedTracked));
  const tracked = requireCommand('git', ['ls-files'], workspace).stdout.trim().split('\n').filter(Boolean).sort();
  assertInvariant('workspace tracks exactly the accepted preflight files', JSON.stringify(tracked) === JSON.stringify(expectedTracked));
  const status = requireCommand('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=no'], workspace).stdout;
  assertInvariant('workspace git status is clean with no untracked files', status === '');
  for (const file of expectedTracked) {
    const filePath = path.join(workspace, file);
    const stat = fs.lstatSync(filePath);
    assertInvariant(`workspace ${file} is a regular non-symlink file`, stat.isFile() && !stat.isSymbolicLink());
  }
  for (const file of SUBJECT_FILES) {
    assertInvariant(`workspace ${file} still matches its pinned SHA-256`, sha256File(path.join(workspace, file)) === SUBJECT_SHA256[file]);
  }
}

function regularPrivateFile(file: string, label: string): void {
  const stat = fs.lstatSync(file);
  assertInvariant(`${label} is a private regular file`, stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
}

function writeExclusiveJson(file: string, value: unknown): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeExclusiveBytes(file, bytes);
}

function writeExclusiveBytes(file: string, bytes: string): void {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch {
    // Directory fsync is not available on every supported filesystem. File
    // contents are still fsynced before publication.
  }
}

function resumeArtifacts(outputDirectory: string): string[] {
  return [
    RESUME_STARTED_FILE,
    RESUME_REVALIDATION_FILE,
    RESUME_WORK_ITEMS_FILE,
    RESUME_INPUT_METADATA_FILE,
    RESUME_CHECKPOINT_FILE,
    RESUME_REPORT_FILE,
    RESUME_REPORT_MARKDOWN_FILE,
    RESUME_FAILURE_CHECKPOINT_FILE,
    RESUME_COMPLETED_FILE,
  ].filter(file => {
    try {
      fs.lstatSync(path.join(outputDirectory, file));
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

function resumeStagingEntries(outputDirectory: string): string[] {
  try {
    return fs.readdirSync(outputDirectory).filter(name => name.startsWith('.resume-publish-'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function resumeFinalArtifacts(outputDirectory: string): string[] {
  return resumeArtifacts(outputDirectory).filter(file => [
    RESUME_CHECKPOINT_FILE,
    RESUME_REPORT_FILE,
    RESUME_REPORT_MARKDOWN_FILE,
    RESUME_FAILURE_CHECKPOINT_FILE,
    RESUME_COMPLETED_FILE,
  ].includes(file));
}

const RESUME_PUBLICATION_FILES = [
  RESUME_CHECKPOINT_FILE,
  RESUME_REPORT_FILE,
  RESUME_REPORT_MARKDOWN_FILE,
  RESUME_COMPLETED_FILE,
] as const;

type PublishedResumeArtifact = {
  name: string;
  device: number;
  inode: number;
};

function createResumeStagingDirectory(outputDirectory: string): string {
  const existing = resumeFinalArtifacts(outputDirectory);
  const staging = resumeStagingEntries(outputDirectory);
  assertInvariant('resume publication has no pre-existing final evidence', existing.length === 0);
  assertInvariant('resume publication has no pre-existing staging directory', staging.length === 0);
  const directory = fs.mkdtempSync(path.join(outputDirectory, '.resume-publish-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function stageResumeArtifact(stagingDirectory: string, name: string, bytes: string): void {
  assertInvariant('resume publication file name is fixed', RESUME_PUBLICATION_FILES.includes(name as typeof RESUME_PUBLICATION_FILES[number]));
  const staged = path.join(stagingDirectory, `${name}.stage`);
  writeExclusiveBytes(staged, bytes);
  regularPrivateFile(staged, `staged resume ${name}`);
}

function publishResumeArtifacts(
  outputDirectory: string,
  stagingDirectory: string,
  published: PublishedResumeArtifact[],
): void {
  assertInvariant('resume staging directory is output-owned', path.dirname(path.resolve(stagingDirectory)) === path.resolve(outputDirectory) && path.basename(stagingDirectory).startsWith('.resume-publish-'));
  for (const name of RESUME_PUBLICATION_FILES) {
    const staged = path.join(stagingDirectory, `${name}.stage`);
    const final = path.join(outputDirectory, name);
    try {
      fs.lstatSync(final);
      throw new Error(`resume final artifact already exists: ${name}`);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    fs.renameSync(staged, final);
    const stat = fs.lstatSync(final);
    published.push({ name, device: stat.dev, inode: stat.ino });
    assertInvariant(`published resume ${name} is a private regular file`, stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
    fsyncDirectory(outputDirectory);
  }
  fsyncDirectory(outputDirectory);
}

function cleanupResumePublication(
  outputDirectory: string,
  stagingDirectory: string | undefined,
  published: readonly PublishedResumeArtifact[],
  preExisting: ReadonlySet<string>,
): void {
  for (const artifact of published) {
    if (preExisting.has(artifact.name)) continue;
    const file = path.join(outputDirectory, artifact.name);
    try {
      const stat = fs.lstatSync(file);
      // A publication can only remove the same regular inode it just renamed;
      // a symlink or replacement is never treated as child-owned evidence.
      if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === artifact.device && stat.ino === artifact.inode) fs.unlinkSync(file);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  if (stagingDirectory !== undefined) {
    const resolvedOutput = path.resolve(outputDirectory);
    const resolvedStaging = path.resolve(stagingDirectory);
    assertInvariant('resume staging cleanup is output-owned', path.dirname(resolvedStaging) === resolvedOutput && path.basename(resolvedStaging).startsWith('.resume-publish-'));
    fs.rmSync(resolvedStaging, { recursive: true, force: true });
  }
  fsyncDirectory(outputDirectory);
}

function assertNoPriorResumeArtifacts(outputDirectory: string): void {
  const existing = resumeArtifacts(outputDirectory);
  const staging = resumeStagingEntries(outputDirectory);
  assertInvariant('resume output has no prior marker or evidence', existing.length === 0 && staging.length === 0);
}

function proofJsonCommand(binary: string, args: readonly string[], workspace: string, input: string): { value: JsonRecord; bytes: string } {
  const result = spawnSync(binary, [...args], {
    cwd: workspace,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...OFFLINE_GO_ENV },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Proof ${args.join(' ')} failed (${result.status}): ${boundedText(String(result.stderr || result.error || ''))}`);
  const value = parseJsonOutput(String(result.stdout || ''), `Proof ${args.join(' ')}`);
  return { value, bytes: proofCanonicalJson(value) };
}

function baselineDiscoveryClaims(checkpoint: JsonRecord): { candidate: JsonRecord; admission: JsonRecord } {
  const events = array(checkpoint.events, 'baseline discovery events');
  const candidates = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && eventScopeLength(event) === 1);
  const admissions = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1' && eventScopeLength(event) === 1);
  assertInvariant('baseline has one active project candidate', candidates.length === 1);
  assertInvariant('baseline has one active project admission', admissions.length === 1);
  assertInvariant('baseline project admission consumes candidate', Array.isArray(admissions[0].parentClaimIds) && admissions[0].parentClaimIds.length === 1 && admissions[0].parentClaimIds[0] === candidates[0].claimId);
  return { candidate: candidates[0], admission: admissions[0] };
}

function activeRowsFromProjection(projection: JsonRecord): JsonRecord[] {
  return activeClaims(projection, 'component.work_item@1', 2).sort((left, right) => String(left.payload.component_id).localeCompare(String(right.payload.component_id)));
}

function deriveResumeProofInputs(
  proofBinary: string,
  workspace: string,
  baselineCheckpoint: JsonRecord,
  baselineProjection: JsonRecord,
  changedPaths: readonly string[],
): { revalidationBytes: string; workItemsBytes: string; changedComponentId: string; authority: JsonRecord } {
  const discovery = baselineDiscoveryClaims(baselineCheckpoint);
  const admissionPayload = record(discovery.admission.payload, 'baseline project admission payload');
  assertInvariant('baseline project admission retains exact Proof wire', typeof admissionPayload.__proof_admission_wire === 'string' && admissionPayload.__proof_admission_wire.length > 0);
  const admissionWire = admissionPayload.__proof_admission_wire as string;
  const revalidationRequest = `{"version":${proofCanonicalJson('proof.catalog-revalidation-request/v2')},"candidate":${proofCanonicalJson(discovery.candidate.payload)},"admission":${admissionWire}}`;
  const revalidation = proofJsonCommand(proofBinary, ['onboarding', 'revalidate'], workspace, revalidationRequest);
  const workItemsRequest = `{"version":${proofCanonicalJson('proof.onboarding-work-items-request/v1')},"candidate":${proofCanonicalJson(discovery.candidate.payload)},"admission":${admissionWire},"revalidation_receipt":${proofCanonicalJson(revalidation.value.receipt)}}`;
  const workItems = proofJsonCommand(proofBinary, ['onboarding', 'work-items'], workspace, workItemsRequest);
  assertInvariant('Proof revalidation has an accepted inventory/catalog/work-items authority', revalidation.value.version === 'proof.catalog-revalidation/v2' && workItems.value.version === 'proof.onboarding-work-item-projection/v1');
  const baselineEvents = array(baselineCheckpoint.events, 'baseline events');
  const inventory = baselineEvents.find(event => event.type === 'ClaimPublished' && event.claim === 'proof.structural_inventory@1' && eventScopeLength(event) === 1);
  assertInvariant('baseline structural inventory is present', inventory !== undefined);
  const baselineItems = activeRowsFromProjection(baselineProjection);
  const afterItems = Array.isArray(workItems.value.work_items) ? workItems.value.work_items as JsonRecord[] : [];
  assertInvariant('Proof returned exactly three work items', afterItems.length === 3);
  const beforeById = new Map(baselineItems.map(row => [String(row.payload.component_id), row.payload]));
  const afterById = new Map(afterItems.map(row => [String(row.component_id), row]));
  assertInvariant('Proof work-item component set matches baseline', beforeById.size === afterById.size && [...beforeById.keys()].every(id => afterById.has(id)));
  const changed = [...beforeById.keys()].filter(id => canonicalValue(beforeById.get(id)) !== canonicalValue(afterById.get(id)));
  assertInvariant('exactly one WorkItem authority changed', changed.length === 1);
  const changedComponentId = changed[0];
  const changedItem = record(afterById.get(changedComponentId), 'changed Proof WorkItem');
  assertInvariant('changed WorkItem owns both patched paths', changedPaths.every(file => Array.isArray(changedItem.sorted_owned_paths) && changedItem.sorted_owned_paths.includes(file)));
  assertInvariant('changed WorkItem input state owns both patched paths', changedPaths.every(file => Array.isArray(changedItem.proof_input_state) && changedItem.proof_input_state.some((row: JsonRecord) => row.path === file)));
  for (const id of [...beforeById.keys()].filter(value => value !== changedComponentId)) {
    assertInvariant(`Proof WorkItem ${id} is byte-identical to baseline`, canonicalValue(beforeById.get(id)) === canonicalValue(afterById.get(id)));
  }
  const baselineCandidate = record(discovery.candidate.payload, 'baseline project candidate');
  assertInvariant('Proof catalog authority is unchanged by a selective source patch', canonicalValue(revalidation.value.catalog) === canonicalValue(baselineCandidate));
  const baselineInventoryPayload = record(inventory.payload, 'baseline structural inventory');
  const changedInventoryPaths = array(revalidation.value.inventory?.input_state, 'revalidated inventory input state').filter(row => {
    const before = array(baselineInventoryPayload.input_state, 'baseline inventory input state').find(value => value.path === row.path);
    return !before || before.file_hash !== row.file_hash;
  }).map(row => String(row.path)).sort();
  assertInvariant('revalidated inventory changes exactly the patched paths', canonicalValue(changedInventoryPaths) === canonicalValue([...changedPaths].sort()));
  return {
    revalidationBytes: revalidation.bytes,
    workItemsBytes: workItems.bytes,
    changedComponentId,
    authority: {
      revalidation_sha256: createHash('sha256').update(revalidation.bytes).digest('hex'),
      work_items_sha256: createHash('sha256').update(workItems.bytes).digest('hex'),
      changed_component_id: changedComponentId,
      changed_paths: [...changedPaths].sort(),
      inventory_changed_paths: changedInventoryPaths,
      catalog_unchanged: true,
    },
  };
}

type AcceptedResumeArtifact = {
  preflight: JsonRecord;
  config: JsonRecord;
  workspace: string;
  proofBinary: string;
  baselineCheckpoint: JsonRecord;
  baselineProjection: JsonRecord;
  baselineWorkItems: JsonRecord[];
  baselineGate: LiveBaselineCheckpointValidation;
};

function acceptedResumeArtifact(outputDirectory: string, requireBaselineWorkspace = true): AcceptedResumeArtifact {
  const outputReal = realDirectory(outputDirectory, 'accepted baseline output');
  assertInvariant('accepted baseline output is private', (fs.statSync(outputReal).mode & 0o777) === 0o700);
  const artifact = baselineArtifact(outputDirectory);
  if (requireBaselineWorkspace) validateBaselineWorkspace(artifact.preflight, artifact.workspace);
  const baselinePath = path.join(outputDirectory, BASELINE_CHECKPOINT_FILE);
  const reportPath = path.join(outputDirectory, BASELINE_REPORT_FILE);
  regularPrivateFile(baselinePath, 'baseline checkpoint');
  regularPrivateFile(reportPath, 'baseline report');
  const baselineBytes = fs.readFileSync(baselinePath, 'utf8');
  const baselineCheckpoint = record(JSON.parse(baselineBytes), 'accepted baseline checkpoint');
  assertInvariant('baseline checkpoint bytes are canonical', baselineBytes === `${canonicalValue(baselineCheckpoint)}\n`);
  const baselineReport = record(JSON.parse(fs.readFileSync(reportPath, 'utf8')), 'accepted baseline report');
  assertInvariant('baseline report is an accepted baseline', baselineReport.status === 'passed' && baselineReport.mode === 'baseline-only' && baselineReport.gate_passed === true);
  const pins = record(artifact.preflight.pins, 'accepted baseline pins');
  const modules = record(artifact.preflight.modules, 'accepted baseline modules');
  assertInvariant('accepted baseline toolchain pins are exact', pins.visor_base === BASE_VISOR_COMMIT && pins.proof_commit === PROOF_COMMIT && pins.probe_version === PROBE_VERSION && pins.codex_version === CODEX_VERSION && pins.hidden_test_sha256 === HIDDEN_TEST_SHA256 && pins.patch_sha256 === PATCH_SHA256 && pins.ts_node_version === modules['ts-node/register/transpile-only']?.version && pins.js_yaml_version === modules['js-yaml']?.version);
  assertInvariant('accepted baseline subject pins are exact', canonicalValue(pins.subject_files) === canonicalValue(SUBJECT_SHA256) && pins.subject_tree_sha256 === SUBJECT_TREE_SHA256);
  const baselineGate = validateLiveBaselineCheckpoint(baselineCheckpoint, artifact.config);
  assertInvariant('baseline report session and receipt match its checkpoint gate', baselineReport.session_id === baselineGate.sessionId && baselineReport.receipt_id === baselineGate.receiptId);
  const plan = compileClaimPlan(JSON.parse(JSON.stringify(artifact.config)) as any);
  const restored = ExecutionJournal.restoreGraphCheckpoint(plan, baselineCheckpoint);
  const baselineProjection = restored.getInstanceProjection() as JsonRecord;
  const baselineWorkItems = activeOnboardingWorkItemsFromProjection(baselineProjection);
  assertInvariant('accepted baseline has exactly three active depth-2 WorkItems', baselineWorkItems.length === 3);
  return {
    ...artifact,
    baselineCheckpoint,
    baselineProjection,
    baselineWorkItems,
    baselineGate,
  };
}

function verifyResumePins(artifact: AcceptedResumeArtifact, subjectDirectory: string, evaluatorDirectory: string): JsonRecord {
  const subjectReal = realDirectory(subjectDirectory, 'resume subject');
  const evaluatorReal = realDirectory(evaluatorDirectory, 'resume evaluator');
  assertInvariant('resume subject and evaluator are separate', !pathsOverlap(subjectReal, evaluatorReal));
  const isolation = record(artifact.preflight.isolation, 'accepted baseline isolation');
  assertInvariant('resume subject/evaluator are the accepted input trees', subjectReal === path.resolve(String(isolation.subject_source)) && evaluatorReal === path.resolve(String(isolation.evaluator_source)));
  const pins = record(artifact.preflight.pins, 'accepted preflight pins');
  const inputs = pinnedInputs(subjectReal, evaluatorReal);
  assertInvariant('resume subject tree matches accepted baseline pins', canonicalValue(inputs.subject_files) === canonicalValue(pins.subject_files) && inputs.subject_tree_sha256 === pins.subject_tree_sha256);
  assertInvariant('resume evaluator oracle and patch match accepted pins', inputs.hidden_test_sha256 === pins.hidden_test_sha256 && inputs.patch_sha256 === pins.patch_sha256 && inputs.patch_sha256 === PATCH_SHA256);
  return { subject_tree_sha256: inputs.subject_tree_sha256, hidden_test_sha256: inputs.hidden_test_sha256, patch_sha256: inputs.patch_sha256 };
}

function workspaceHashes(workspace: string): Record<string, string> {
  return Object.fromEntries(SUBJECT_FILES.map(file => [file, sha256File(path.join(workspace, file))]));
}

function applySelectiveResumePatch(workspace: string, evaluatorDirectory: string, baselineHashes: Record<string, string>): JsonRecord {
  const patch = path.join(evaluatorDirectory, 'changes', '0001-reject-malformed-write.patch');
  const patchStat = fs.lstatSync(patch);
  assertInvariant('resume evaluator patch is a regular non-symlink file', patchStat.isFile() && !patchStat.isSymbolicLink());
  assertInvariant('resume evaluator patch remains at the accepted SHA-256', sha256File(patch) === PATCH_SHA256);
  const patchCheck = command('git', ['apply', '--check', patch], workspace);
  assertInvariant('accepted evaluator patch applies cleanly to baseline workspace', patchCheck.status === 0);
  const applied = command('git', ['apply', patch], workspace);
  assertInvariant('accepted evaluator patch applies to workspace', applied.status === 0);
  const diffCheck = command('git', ['diff', '--check'], workspace);
  assertInvariant('patched workspace has no whitespace errors', diffCheck.status === 0);
  const changedPaths = requireCommand('git', ['diff', '--name-only'], workspace).stdout.split('\n').map(value => value.trim()).filter(Boolean).sort();
  assertInvariant('selective patch changes exactly http.go and http_test.go', canonicalValue(changedPaths) === canonicalValue(['http.go', 'http_test.go']));
  const status = requireCommand('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=no'], workspace).stdout.split('\n').map(value => value.trim()).filter(Boolean);
  assertInvariant('patched workspace has only the two accepted tracked modifications', status.length === 2 && status.every(line => /^( M|M )/.test(line)));
  for (const file of SUBJECT_FILES) {
    const filePath = path.join(workspace, file);
    const stat = fs.lstatSync(filePath);
    assertInvariant(`patched workspace ${file} is a regular non-symlink file`, stat.isFile() && !stat.isSymbolicLink());
  }
  const after = workspaceHashes(workspace);
  for (const file of SUBJECT_FILES.filter(value => !changedPaths.includes(value))) assertInvariant(`unchanged workspace ${file} remains pinned`, after[file] === baselineHashes[file]);
  for (const file of changedPaths) assertInvariant(`changed workspace ${file} differs from baseline`, after[file] !== baselineHashes[file]);
  const diffBytes = requireCommand('git', ['diff', '--binary'], workspace).stdout;
  return {
    changed_paths: changedPaths,
    workspace_hashes: after,
    diff_sha256: createHash('sha256').update(diffBytes, 'utf8').digest('hex'),
    patch_sha256: sha256File(patch),
    public_test: runWorkspaceTest(workspace),
  };
}

function resumeMarkdownBytes(report: JsonRecord): string {
  const lines = [
    '# EXP-0209 selective resume',
    '',
    `- Status: ${report.status}`,
    `- Gate passed: ${report.gate_passed === true ? 'yes' : 'no'}`,
    `- Controller PID: ${report.controller_pid ?? 'unknown'}`,
    `- Child PID: ${report.child_pid ?? 'unknown'}`,
    `- Session: ${report.session_id ?? 'unknown'}`,
    `- Changed component: ${report.changed_component_id ?? 'unknown'}`,
    `- Changed paths: ${Array.isArray(report.changed_paths) ? report.changed_paths.join(', ') : 'unknown'}`,
    `- Counts: ${report.counts?.status || JSON.stringify(report.counts || {})}`,
    `- Error: ${report.error ?? 'none'}`,
    '',
    'This report is evidence from one explicitly invoked selective resume. No retry or fallback is performed.',
    '',
  ];
  return lines.join('\n');
}

function writeResumeMarkdown(report: JsonRecord): void {
  const file = path.join(String(report.output_directory), RESUME_REPORT_MARKDOWN_FILE);
  writeExclusiveBytes(file, resumeMarkdownBytes(report));
}

/**
 * A controller may add only the missing report after a launched child exits
 * without publishing one.  Any lstat error other than ENOENT is treated as
 * evidence: an unreadable/racing path must never be overwritten.
 */
function resumeReportExistsSafely(outputDirectory: string): boolean {
  try {
    fs.lstatSync(path.join(outputDirectory, RESUME_REPORT_FILE));
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    return true;
  }
}

export function writeControllerResumeFailureIfMissing(
  outputDirectory: string,
  checkpoint: unknown,
  error: unknown,
): void {
  if (resumeReportExistsSafely(outputDirectory)) return;
  const report = resumeFailureReport(outputDirectory, process.pid, undefined, checkpoint, error);
  try {
    // wx is the final race guard: a child report winning between lstat and
    // open is preserved, and its checkpoint/failure evidence is untouched.
    writeExclusiveJson(path.join(outputDirectory, RESUME_REPORT_FILE), report);
  } catch {
    return;
  }
  try {
    writeResumeMarkdown(report);
  } catch {
    // Markdown is supplementary; a safely published JSON report is enough.
  }
}

function existingBaselineArtifacts(outputDirectory: string): string[] {
  return [BASELINE_REPORT_FILE, BASELINE_REPORT_MARKDOWN_FILE, BASELINE_CHECKPOINT_FILE, 'baseline-failure.checkpoint.json']
    .filter(file => {
      try {
        fs.lstatSync(path.join(outputDirectory, file));
        return true;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    });
}

function assertNoPriorBaselineArtifacts(outputDirectory: string): void {
  const existing = existingBaselineArtifacts(outputDirectory);
  assertInvariant('baseline output has no prior baseline evidence', existing.length === 0);
}

function baselineEvidenceExistsSafely(outputDirectory: string): boolean {
  try {
    return existingBaselineArtifacts(outputDirectory).length > 0;
  } catch {
    // An unreadable output cannot be safely classified as fresh. Preserve any
    // possible evidence rather than attempting a best-effort overwrite.
    return true;
  }
}

function checkpointEventCounts(checkpoint: unknown): JsonRecord {
  if (!checkpoint || typeof checkpoint !== 'object' || !Array.isArray((checkpoint as JsonRecord).events)) return { status: 'unknown' };
  const events = (checkpoint as JsonRecord).events as readonly JsonRecord[];
  return {
    status: 'partial',
    inspect_attempts: events.filter(event => event.type === 'AttemptStarted' && event.checkId === 'inspect').length,
    proof_candidates: events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1').length,
    proof_admissions: events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1').length,
  };
}

function writeBaselineMarkdown(report: JsonRecord): void {
  const outputDirectory = String(report.output_directory);
  const lines = [
    '# EXP-0209 live baseline',
    '',
    `- Status: ${report.status}`,
    `- Gate passed: ${report.gate_passed === true ? 'yes' : 'no'}`,
    `- Controller PID: ${report.controller_pid ?? 'unknown'}`,
    `- Child PID: ${report.child_pid ?? 'unknown'}`,
    `- Session: ${report.session_id ?? 'unknown'}`,
    `- Components: ${Array.isArray(report.component_ids) ? report.component_ids.join(', ') : 'unknown'}`,
    `- Error: ${report.error ?? 'none'}`,
    '',
    'This report is evidence from one explicitly invoked baseline-only run. No retry or resume is performed by this demo.',
    '',
  ];
  fs.writeFileSync(path.join(outputDirectory, BASELINE_REPORT_MARKDOWN_FILE), lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(path.join(outputDirectory, BASELINE_REPORT_MARKDOWN_FILE), 0o600);
}

async function runBaselineChild(outputDirectory: string, controllerPid: number): Promise<void> {
  let checkpoint: unknown;
  // Capture this before any assertion that may throw. The catch block repeats
  // the check to cover direct replay and races after the initial inspection.
  let priorBaselineEvidence = baselineEvidenceExistsSafely(outputDirectory);
  const baseFailure: JsonRecord = {
    schema: 'urn:reqproof:agent-governance:exp-0209-baseline:v1',
    status: 'failed',
    mode: 'baseline-child',
    output_directory: outputDirectory,
    controller_pid: controllerPid,
    child_pid: process.pid,
    gate_passed: false,
    counts: { status: 'unknown' },
    retries: 0,
    fallback: false,
  };
  try {
    assertInvariant('baseline child PID differs from controller PID', controllerPid !== process.pid);
    assertInvariant('baseline child parent is the controller', process.ppid === controllerPid);
    const outputReal = realDirectory(outputDirectory, 'owned baseline output');
    assertInvariant('baseline output is private', (fs.statSync(outputReal).mode & 0o777) === 0o700);
    priorBaselineEvidence ||= baselineEvidenceExistsSafely(outputDirectory);
    assertNoPriorBaselineArtifacts(outputDirectory);
    try {
      process.kill(controllerPid, 0);
    } catch (error) {
      throw new Error(`baseline controller PID ${controllerPid} is not alive`, { cause: error });
    }
    const artifact = baselineArtifact(outputDirectory);
    validateBaselineWorkspace(artifact.preflight, artifact.workspace);
    const config = artifact.config as import('../../../src/types/config').VisorConfig;
    const capability = createProofAdmissionCapability(artifact.proofBinary);
    const registry = CheckProviderRegistry.getInstance();
    registry.bootstrapProofAdmission(capability);
    const engine = new StateMachineExecutionEngine(artifact.workspace);
    const result = await withGovernedProbeRunnerBudget(BASELINE_ROLE_RUN_LIMIT, () => engine.executeGroupedChecks(
      baselinePrInfo,
      ['project'],
      undefined,
      config as any,
      'json',
      false,
      3,
      true,
    ));
    checkpoint = engine.exportGraphCheckpoint();
    // Keep this explicit restore adjacent to the public export. It is the
    // canonical checkpoint gate the baseline contract promises to callers.
    const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
    assertInvariant('canonical checkpoint restore projection agrees with replay', canonicalGraphCheckpointJson(restored.getInstanceProjection()) === canonicalGraphCheckpointJson(restored.replayInstanceProjection()));
    const gate = validateLiveBaselineCheckpoint(checkpoint, config);
    const success: JsonRecord = {
      schema: 'urn:reqproof:agent-governance:exp-0209-baseline:v1',
      status: 'passed',
      mode: 'baseline-only',
      output_directory: outputDirectory,
      controller_pid: controllerPid,
      child_pid: process.pid,
      session_id: gate.sessionId,
      component_ids: gate.componentIds,
      counts: gate.counts,
      receipt_id: gate.receiptId,
      gate_passed: true,
      graph_semantic_digest: gate.graphSemanticDigest,
      role_runs: { maximum: BASELINE_ROLE_RUN_LIMIT, inspect: gate.counts.inspectAttempts, retries: 0, fallback: false },
      execution: { statistics: result.statistics, restored_reexport_agreement: true, replay_agreement: true },
    };
    fs.writeFileSync(path.join(outputDirectory, BASELINE_CHECKPOINT_FILE), `${canonicalGraphCheckpointJson(checkpoint)}\n`, { mode: 0o600 });
    fs.chmodSync(path.join(outputDirectory, BASELINE_CHECKPOINT_FILE), 0o600);
    writeJson(path.join(outputDirectory, BASELINE_REPORT_FILE), success);
    writeBaselineMarkdown(success);
    process.stdout.write(`EXP-0209 baseline passed: ${outputDirectory}\n`);
  } catch (error) {
    const failure: JsonRecord = {
      ...baseFailure,
      session_id: checkpoint && typeof checkpoint === 'object' ? (checkpoint as JsonRecord).sessionId : undefined,
      counts: checkpointEventCounts(checkpoint),
      checkpoint_exported: checkpoint !== undefined,
      error: error instanceof Error ? error.message : String(error),
    };
    // A rejected gate must not be published as a successful baseline
    // checkpoint. Preserve safely exported evidence under a failure-only name.
    let preserveExistingEvidence = priorBaselineEvidence;
    try {
      preserveExistingEvidence ||= existingBaselineArtifacts(outputDirectory).length > 0;
    } catch {
      preserveExistingEvidence = true;
    }
    if (!preserveExistingEvidence) {
      if (checkpoint !== undefined) {
        try {
          fs.writeFileSync(path.join(outputDirectory, 'baseline-failure.checkpoint.json'), `${canonicalGraphCheckpointJson(checkpoint)}\n`, { mode: 0o600 });
        } catch {
          failure.checkpoint_exported = 'unknown';
        }
      }
      try {
        writeJson(path.join(outputDirectory, BASELINE_REPORT_FILE), failure);
        writeBaselineMarkdown(failure);
      } catch {
        // Keep the original error on stderr when the owned output is unwritable.
      }
    }
    throw error;
  }
}

function runBaselineOnly(args: ReturnType<typeof parseArgs>, outputState: OutputState): void {
  const report = preflight(args.outputDirectory, args.subjectDirectory, args.evaluatorDirectory, outputState);
  writeJson(path.join(args.outputDirectory, PRECHECK_ARTIFACT), { ...report, mode: 'baseline-only' });
  const child = spawnSync(process.execPath, [
    '-r', 'ts-node/register/transpile-only', __filename,
    BASELINE_CHILD_FLAG, '--output', args.outputDirectory,
    CONTROLLER_PID_FLAG, String(process.pid),
  ], {
    cwd: REPO_ROOT,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(^|_)(EVALUATOR|SUBJECT)(_|$)/i.test(key))),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    throw new Error(`baseline child failed (${child.status}): ${boundedText(String(child.stderr || child.error || child.stdout || ''))}`);
  }
  process.stdout.write(String(child.stdout || `EXP-0209 baseline passed: ${args.outputDirectory}\n`));
}

function resumeFailureReport(outputDirectory: string, controllerPid: number, childPid: number | undefined, checkpoint: unknown, error: unknown): JsonRecord {
  return {
    schema: 'urn:reqproof:agent-governance:exp-0209-resume:v1',
    status: 'failed',
    mode: childPid === undefined ? 'resume-only' : 'resume-child',
    output_directory: outputDirectory,
    controller_pid: controllerPid,
    ...(childPid === undefined ? {} : { child_pid: childPid }),
    gate_passed: false,
    counts: checkpointEventCounts(checkpoint),
    retries: 0,
    fallback: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function runResumeOnly(args: ReturnType<typeof parseArgs>): void {
  const outputDirectory = args.outputDirectory;
  let checkpoint: unknown;
  let childStarted = false;
  try {
    const artifact = acceptedResumeArtifact(outputDirectory);
    assertNoPriorResumeArtifacts(outputDirectory);
    const pinEvidence = verifyResumePins(artifact, args.subjectDirectory, args.evaluatorDirectory);
    const baselineConfigBytes = fs.readFileSync(path.join(outputDirectory, EFFECTIVE_CONFIG_FILE));
    const baselineCheckpointBytes = fs.readFileSync(path.join(outputDirectory, BASELINE_CHECKPOINT_FILE));
    const baselineHashes = workspaceHashes(artifact.workspace);
    const started = {
      schema: 'urn:reqproof:agent-governance:exp-0209-resume-started:v1',
      status: 'started',
      output_directory: outputDirectory,
      controller_pid: process.pid,
      baseline_session_id: artifact.baselineGate.sessionId,
      baseline_checkpoint_sha256: createHash('sha256').update(baselineCheckpointBytes).digest('hex'),
      effective_config_sha256: createHash('sha256').update(baselineConfigBytes).digest('hex'),
      baseline_workspace_hashes: baselineHashes,
      pins: pinEvidence,
      changed_paths: ['http.go', 'http_test.go'],
      retries: 0,
      fallback: false,
    };
    // This is deliberately the first write in the resume flow and uses an
    // exclusive open. A second controller can therefore never overwrite or
    // reinterpret an in-flight/failed resume.
    writeExclusiveJson(path.join(outputDirectory, RESUME_STARTED_FILE), started);
    const patchEvidence = applySelectiveResumePatch(artifact.workspace, args.evaluatorDirectory, baselineHashes);
    const authority = deriveResumeProofInputs(proofBinaryFromArtifact(artifact), artifact.workspace, artifact.baselineCheckpoint, artifact.baselineProjection, patchEvidence.changed_paths);
    writeExclusiveBytes(path.join(outputDirectory, RESUME_REVALIDATION_FILE), authority.revalidationBytes);
    writeExclusiveBytes(path.join(outputDirectory, RESUME_WORK_ITEMS_FILE), authority.workItemsBytes);
    const inputMetadata = {
      schema: 'urn:reqproof:agent-governance:exp-0209-resume-inputs:v1',
      baseline_checkpoint_sha256: started.baseline_checkpoint_sha256,
      effective_config_sha256: started.effective_config_sha256,
      revalidation_sha256: authority.authority.revalidation_sha256,
      work_items_sha256: authority.authority.work_items_sha256,
      changed_component_id: authority.changedComponentId,
      changed_paths: patchEvidence.changed_paths,
      inventory_changed_paths: authority.authority.inventory_changed_paths,
      catalog_unchanged: authority.authority.catalog_unchanged,
      workspace_hashes_before: baselineHashes,
      workspace_hashes_after: patchEvidence.workspace_hashes,
      diff_sha256: patchEvidence.diff_sha256,
      patch_sha256: patchEvidence.patch_sha256,
      session_id: artifact.baselineGate.sessionId,
      graph_semantic_digest: artifact.baselineGate.graphSemanticDigest,
      public_test: { status: patchEvidence.public_test.status, passed: patchEvidence.public_test.passed },
      retries: 0,
      fallback: false,
    };
    writeExclusiveJson(path.join(outputDirectory, RESUME_INPUT_METADATA_FILE), inputMetadata);
    const child = spawnSync(process.execPath, [
      '-r', 'ts-node/register/transpile-only', __filename,
      RESUME_CHILD_FLAG, '--output', outputDirectory,
      CONTROLLER_PID_FLAG, String(process.pid),
    ], {
      cwd: REPO_ROOT,
      // The child receives only its owned output and controller PID. In
      // particular, evaluator/subject environment variables are stripped.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(^|_)(EVALUATOR|SUBJECT)(_|$)/i.test(key))),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    // spawnSync can return a result object with an error without launching a
    // child. Only an actually launched child owns failure evidence.
    if (!child.error) childStarted = true;
    if (child.error || child.status !== 0) throw new Error(`resume child failed (${child.status}): ${boundedText(String(child.stderr || child.error || child.stdout || ''))}`);
    process.stdout.write(String(child.stdout || `EXP-0209 selective resume passed: ${outputDirectory}\n`));
  } catch (error) {
    // A launched child normally owns publication, but a nonzero child exit
    // with no report still needs honest controller-side unknown/partial
    // evidence.  Only an actually present child report suppresses this; all
    // checkpoint/failure artifacts are left untouched.
    void childStarted;
    try { writeControllerResumeFailureIfMissing(outputDirectory, checkpoint, error); } catch {
      // Preserve the original diagnostic if the output is not writable.
    }
    throw error;
  }
}

function proofBinaryFromArtifact(artifact: AcceptedResumeArtifact): string {
  return artifact.proofBinary;
}

function validateResumeWorkspace(artifact: AcceptedResumeArtifact, marker: JsonRecord, metadata: JsonRecord): void {
  const workspace = artifact.workspace;
  const expectedPaths = ['http.go', 'http_test.go'];
  assertInvariant('resume marker expects the two accepted changed paths', canonicalValue(marker.changed_paths) === canonicalValue(expectedPaths));
  assertInvariant('resume metadata baseline session and digest match accepted baseline', metadata.session_id === artifact.baselineGate.sessionId && metadata.graph_semantic_digest === artifact.baselineGate.graphSemanticDigest);
  const status = requireCommand('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=no'], workspace).stdout.split('\n').map(value => value.trim()).filter(Boolean);
  assertInvariant('resume workspace has only two modified tracked files', status.length === 2 && status.every(line => /^( M|M )/.test(line)));
  const changed = requireCommand('git', ['diff', '--name-only'], workspace).stdout.split('\n').map(value => value.trim()).filter(Boolean).sort();
  assertInvariant('resume workspace diff is exactly the accepted component files', canonicalValue(changed) === canonicalValue(expectedPaths));
  assertInvariant('resume metadata changed paths are exact', canonicalValue(metadata.changed_paths) === canonicalValue(expectedPaths));
  const before = record(marker.baseline_workspace_hashes, 'resume baseline workspace hashes');
  const after = workspaceHashes(workspace);
  const recordedAfter = record(metadata.workspace_hashes_after, 'resume current workspace hashes');
  assertInvariant('resume workspace hashes match controller evidence', canonicalValue(after) === canonicalValue(recordedAfter));
  for (const file of SUBJECT_FILES) {
    const stat = fs.lstatSync(path.join(workspace, file));
    assertInvariant(`resume workspace ${file} is a regular non-symlink file`, stat.isFile() && !stat.isSymbolicLink());
    if (!expectedPaths.includes(file)) assertInvariant(`resume workspace ${file} remains pinned`, after[file] === before[file] && after[file] === SUBJECT_SHA256[file]);
    else assertInvariant(`resume workspace ${file} changed from baseline`, after[file] !== before[file]);
  }
  const diffBytes = requireCommand('git', ['diff', '--binary'], workspace).stdout;
  assertInvariant('resume workspace diff digest matches controller evidence', createHash('sha256').update(diffBytes, 'utf8').digest('hex') === metadata.diff_sha256);
  assertInvariant('resume metadata patch pin is present', metadata.patch_sha256 === PATCH_SHA256);
}

async function runResumeChild(outputDirectory: string, controllerPid: number): Promise<void> {
  let checkpoint: unknown;
  let priorEvidence = false;
  let childAuthorized = false;
  let entryFinalArtifacts = new Set<string>();
  let entryStagingArtifacts = new Set<string>();
  let stagingDirectory: string | undefined;
  const published: PublishedResumeArtifact[] = [];
  try {
    assertInvariant('resume child PID differs from controller PID', controllerPid !== process.pid);
    assertInvariant('resume child parent is the controller', process.ppid === controllerPid);
    try {
      process.kill(controllerPid, 0);
    } catch (error) {
      throw new Error(`resume controller PID ${controllerPid} is not alive`, { cause: error });
    }
    const outputReal = realDirectory(outputDirectory, 'owned resume output');
    assertInvariant('resume output is private', (fs.statSync(outputReal).mode & 0o777) === 0o700);
    // Snapshot evidence before reading or writing any child-owned input. On a
    // replay, this snapshot is the immutable boundary: all prior final/staged
    // artifacts are preserved and no publication is attempted.
    entryFinalArtifacts = new Set(resumeFinalArtifacts(outputDirectory));
    entryStagingArtifacts = new Set(resumeStagingEntries(outputDirectory));
    assertInvariant('resume child has no prior final evidence', entryFinalArtifacts.size === 0);
    assertInvariant('resume child has no prior staging evidence', entryStagingArtifacts.size === 0);
    const markerPath = path.join(outputDirectory, RESUME_STARTED_FILE);
    regularPrivateFile(markerPath, 'resume started marker');
    const markerBytes = fs.readFileSync(markerPath, 'utf8');
    const marker = record(JSON.parse(markerBytes), 'resume started marker');
    assertInvariant('resume started marker is canonical', markerBytes === `${JSON.stringify(marker, null, 2)}\n`);
    assertInvariant('resume started marker is one-shot and owned by this controller', marker.status === 'started' && marker.controller_pid === controllerPid && marker.output_directory === outputDirectory);
    const artifact = acceptedResumeArtifact(outputDirectory, false);
    const markerPins = record(marker.pins, 'resume marker pins');
    assertInvariant('resume marker pins are exact', markerPins.subject_tree_sha256 === artifact.preflight.pins.subject_tree_sha256 && markerPins.hidden_test_sha256 === HIDDEN_TEST_SHA256 && markerPins.patch_sha256 === PATCH_SHA256);
    childAuthorized = true;
    const metadataPath = path.join(outputDirectory, RESUME_INPUT_METADATA_FILE);
    const revalidationPath = path.join(outputDirectory, RESUME_REVALIDATION_FILE);
    const workItemsPath = path.join(outputDirectory, RESUME_WORK_ITEMS_FILE);
    regularPrivateFile(metadataPath, 'resume input metadata');
    regularPrivateFile(revalidationPath, 'resume revalidation');
    regularPrivateFile(workItemsPath, 'resume work-items');
    const metadataBytes = fs.readFileSync(metadataPath, 'utf8');
    const metadata = record(JSON.parse(metadataBytes), 'resume input metadata');
    assertInvariant('resume input metadata is canonical', metadataBytes === `${JSON.stringify(metadata, null, 2)}\n`);
    const baselineBytes = fs.readFileSync(path.join(outputDirectory, BASELINE_CHECKPOINT_FILE));
    const configBytes = fs.readFileSync(path.join(outputDirectory, EFFECTIVE_CONFIG_FILE));
    assertInvariant('resume baseline/config hashes match the started marker', createHash('sha256').update(baselineBytes).digest('hex') === marker.baseline_checkpoint_sha256 && createHash('sha256').update(configBytes).digest('hex') === marker.effective_config_sha256 && metadata.baseline_checkpoint_sha256 === marker.baseline_checkpoint_sha256 && metadata.effective_config_sha256 === marker.effective_config_sha256);
    const revalidationBytes = fs.readFileSync(revalidationPath, 'utf8');
    const workItemsBytes = fs.readFileSync(workItemsPath, 'utf8');
    assertInvariant('resume Proof bytes are canonical and hash-bound', proofCanonicalJson(JSON.parse(revalidationBytes)) === revalidationBytes && proofCanonicalJson(JSON.parse(workItemsBytes)) === workItemsBytes && createHash('sha256').update(revalidationBytes).digest('hex') === metadata.revalidation_sha256 && createHash('sha256').update(workItemsBytes).digest('hex') === metadata.work_items_sha256);
    validateResumeWorkspace(artifact, marker, metadata);
    const config = artifact.config as import('../../../src/types/config').VisorConfig;
    const capability = createProofAdmissionCapability(artifact.proofBinary);
    const registry = CheckProviderRegistry.getInstance();
    registry.bootstrapProofAdmission(capability);
    const engine = new StateMachineExecutionEngine(artifact.workspace);
    // Exactly one continuation call is made after all owned artifacts and the
    // patched workspace have passed their gates.
    const continued = await engine.continueProofCurrentCatalogCheckpoint({
      checkpoint: artifact.baselineCheckpoint,
      projectSubgraphInstanceId: findProjectSubgraphInstanceId(artifact.baselineProjection),
      revalidationBytes,
      workItemsBytes,
      config,
      prInfo: baselinePrInfo,
      maxParallelism: 3,
      failFast: true,
    });
    checkpoint = engine.exportGraphCheckpoint();
    const gate = validateLiveResumeCheckpoint(checkpoint, artifact.baselineCheckpoint, config, {
      changedComponentId: metadata.changed_component_id,
      changedPaths: metadata.changed_paths,
      mutationEventCount: continued.mutationEventCount,
    });
    const checkpointBytes = `${canonicalValue(checkpoint)}\n`;
    const success: JsonRecord = {
      schema: 'urn:reqproof:agent-governance:exp-0209-resume:v1',
      status: 'passed',
      mode: 'resume-only',
      output_directory: outputDirectory,
      controller_pid: controllerPid,
      child_pid: process.pid,
      session_id: gate.sessionId,
      graph_semantic_digest: gate.graphSemanticDigest,
      changed_component_id: gate.changedComponentId,
      changed_paths: gate.changedPaths,
      suffix: gate.suffix,
      counts: gate.counts,
      totals: gate.counts,
      receipt_ids: gate.receiptIds,
      gate_passed: true,
      digests: {
        baseline_checkpoint_sha256: marker.baseline_checkpoint_sha256,
        continued_checkpoint_sha256: createHash('sha256').update(checkpointBytes).digest('hex'),
        effective_config_sha256: marker.effective_config_sha256,
        revalidation_sha256: metadata.revalidation_sha256,
        work_items_sha256: metadata.work_items_sha256,
        diff_sha256: metadata.diff_sha256,
      },
      retries: 0,
      fallback: false,
    };
    const completed: JsonRecord = {
      schema: 'urn:reqproof:agent-governance:exp-0209-resume-completed:v1',
      status: 'completed',
      session_id: gate.sessionId,
      graph_semantic_digest: gate.graphSemanticDigest,
      changed_component_id: gate.changedComponentId,
      changed_paths: gate.changedPaths,
      suffix: gate.suffix,
      totals: gate.counts,
      receipt_ids: gate.receiptIds,
      continued_checkpoint_sha256: success.digests.continued_checkpoint_sha256,
      revalidation_sha256: metadata.revalidation_sha256,
      work_items_sha256: metadata.work_items_sha256,
      diff_sha256: metadata.diff_sha256,
      controller_pid: controllerPid,
      child_pid: process.pid,
    };
    // Stage every success artifact, fsync the private files, then publish in
    // a fixed order with the completed marker last. No final success name is
    // opened for writing and a replay can never overwrite prior evidence.
    stagingDirectory = createResumeStagingDirectory(outputDirectory);
    stageResumeArtifact(stagingDirectory, RESUME_CHECKPOINT_FILE, checkpointBytes);
    stageResumeArtifact(stagingDirectory, RESUME_REPORT_FILE, `${JSON.stringify(success, null, 2)}\n`);
    stageResumeArtifact(stagingDirectory, RESUME_REPORT_MARKDOWN_FILE, resumeMarkdownBytes(success));
    stageResumeArtifact(stagingDirectory, RESUME_COMPLETED_FILE, `${JSON.stringify(completed, null, 2)}\n`);
    fsyncDirectory(stagingDirectory);
    publishResumeArtifacts(outputDirectory, stagingDirectory, published);
    cleanupResumePublication(outputDirectory, stagingDirectory, [], new Set());
    stagingDirectory = undefined;
    process.stdout.write(`EXP-0209 selective resume passed: ${outputDirectory}\n`);
  } catch (error) {
    try {
      priorEvidence = !childAuthorized || entryFinalArtifacts.size > 0 || entryStagingArtifacts.size > 0;
    } catch {
      priorEvidence = true;
    }
    if (!priorEvidence) {
      try {
        cleanupResumePublication(outputDirectory, stagingDirectory, published, new Set([...entryFinalArtifacts, ...entryStagingArtifacts]));
      } catch {
        // Do not remove anything outside the inode/path checks above.
      }
      try {
        if (checkpoint !== undefined) writeExclusiveBytes(path.join(outputDirectory, RESUME_FAILURE_CHECKPOINT_FILE), `${canonicalValue(checkpoint)}\n`);
      } catch {
        // Failure evidence is optional; never replace a prior artifact.
      }
      try {
        const report = resumeFailureReport(outputDirectory, controllerPid, process.pid, checkpoint, error);
        writeExclusiveJson(path.join(outputDirectory, RESUME_REPORT_FILE), report);
        writeResumeMarkdown(report);
      } catch {
        // Keep the original process diagnostic.
      }
    }
    throw error;
  }
}

function findProjectSubgraphInstanceId(projection: JsonRecord): string {
  const project = Object.values(projection.instancesById || {}).find((value: any) => value.itemKey === 'journalservice' && !value.parentSubgraphInstanceId && value.status === 'active') as JsonRecord | undefined;
  assertInvariant('baseline project subgraph instance is present', !!project && typeof project.subgraphInstanceId === 'string');
  return String(project.subgraphInstanceId);
}

/**
 * The quality gate intentionally has no dependency on a provider, Probe, the
 * engine, or the evaluator tree. It consumes plain controller evidence. This
 * makes the rubric useful in zero-model tests and keeps evaluator prose out
 * of the runtime graph/checkpoint hand-off.
 */
export const ONBOARDING_QUALITY_CRITERIA = Object.freeze([
  'grouping',
  'ownership',
  'coordinates',
  'baseline_http_candidate',
  'no_xss_false_positive',
  'resume_http_resolution',
  'hidden_oracle',
] as const);

type QualityInput = {
  baselineCheckpoint?: unknown;
  resumeCheckpoint?: unknown;
  baselineCandidate?: unknown;
  resumeCandidate?: unknown;
  baselineComponentCandidates?: unknown;
  resumeComponentCandidates?: unknown;
  baselineWorkItems?: unknown;
  resumeWorkItems?: unknown;
  workItems?: unknown;
  workspace?: string;
  patchedWorkspace?: string;
  sourceFiles?: Record<string, string>;
  baselineSourceFiles?: Record<string, string>;
  patchedSourceFiles?: Record<string, string>;
  changedComponentId?: string;
  changed_component_id?: string;
  oracle?: JsonRecord;
  hiddenOracle?: JsonRecord;
  source_files?: Record<string, string>;
  sources?: Record<string, string>;
};

function qualityRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function qualityPayload(value: unknown): JsonRecord | undefined {
  const object = qualityRecord(value);
  if (!object) return undefined;
  if (qualityRecord(object.payload)) return object.payload as JsonRecord;
  if (qualityRecord(object.data)) return object.data as JsonRecord;
  return object;
}

function qualityEvents(checkpoint: unknown): JsonRecord[] {
  const object = qualityRecord(checkpoint);
  return object && Array.isArray(object.events) ? object.events as JsonRecord[] : [];
}

function qualityScopeLength(value: JsonRecord): number {
  return Array.isArray(value.scope) ? value.scope.length : -1;
}

function qualityScopeKey(value: JsonRecord | undefined): string | undefined {
  if (!value) return undefined;
  const scope = Array.isArray(value.scope) ? value.scope : [];
  const last = scope[scope.length - 1] as JsonRecord | undefined;
  return last && (typeof last.key === 'string' ? last.key : typeof last.Key === 'string' ? last.Key : undefined);
}

function qualityCandidates(checkpoint: unknown, scopeLength: number): JsonRecord[] {
  return qualityEvents(checkpoint)
    .filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && qualityScopeLength(event) === scopeLength)
    .map(event => {
      const payload = qualityPayload(event.payload);
      if (payload && scopeLength === 2 && !qualityComponentId(payload)) {
        const key = qualityScopeKey(event);
        return key ? { ...payload, component_id: key } : payload;
      }
      return payload;
    })
    .filter((value): value is JsonRecord => value !== undefined);
}

function qualityCandidateComponents(candidate: unknown): JsonRecord[] {
  const payload = qualityPayload(candidate);
  if (!payload) return [];
  if (Array.isArray(payload.components)) return payload.components.map(value => qualityRecord(value)).filter((value): value is JsonRecord => value !== undefined);
  return [payload];
}

function qualityComponentId(value: JsonRecord, fallback?: string): string {
  return String(value.component_id ?? value.componentId ?? value.shard ?? value.component ?? value.id ?? fallback ?? '');
}

/**
 * Restore the authenticated journal before extracting WorkItems.  In
 * particular, the instance projection is what knows which controller item
 * claim was superseded by a selective replacement; a raw event scan cannot
 * establish that activeness safely.
 */
export function activeOnboardingWorkItemsFromCheckpoint(checkpoint: unknown, config: JsonRecord): JsonRecord[] {
  const plan = compileClaimPlan(JSON.parse(JSON.stringify(config)) as any);
  const restored = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  return activeOnboardingWorkItemsFromProjection(restored.getInstanceProjection() as unknown as JsonRecord);
}

function activeOnboardingWorkItemsFromProjection(projection: JsonRecord): JsonRecord[] {
  const claimsById = qualityRecord(projection.claimsById) || {};
  return Object.values(claimsById)
    .map(value => qualityRecord(value))
    .filter((claim): claim is JsonRecord => !!claim && claim.active === true && claim.kind === 'controller-item' && claim.claim === 'component.work_item@1' && qualityScopeLength(claim) === 2)
    .map(claim => qualityRecord(claim.payload))
    .filter((value): value is JsonRecord => value !== undefined);
}

function qualityItemsFromCheckpoint(checkpoint: unknown): JsonRecord[] {
  const object = qualityRecord(checkpoint);
  const projection = qualityRecord(object?.projection);
  const claimsById = qualityRecord(projection?.claimsById) || qualityRecord(qualityRecord(object?.instanceProjection)?.claimsById);
  if (claimsById) {
    const items = Object.values(claimsById).filter(value => {
      const claim = qualityRecord(value);
      return claim?.active === true && claim.claim === 'component.work_item@1' && qualityScopeLength(claim) === 2;
    }).map(value => qualityRecord(qualityRecord(value)?.payload)).filter((value): value is JsonRecord => value !== undefined);
    if (items.length > 0) return items;
  }
  // This compatibility path is intentionally only a final-event projection:
  // evaluate-only uses activeOnboardingWorkItemsFromCheckpoint above.  The
  // ControllerItemClaimPublished shape carries the WorkItem directly in
  // `payload`, with `itemKey` as its stable component fallback.
  const latest = new Map<string, JsonRecord>();
  for (const event of qualityEvents(checkpoint)
    .filter(event => (event.type === 'ControllerItemClaimPublished' || event.type === 'ClaimPublished') && event.claim === 'component.work_item@1' && qualityScopeLength(event) === 2)) {
    const payload = qualityRecord(event.payload);
    if (!payload) continue;
    const componentId = qualityComponentId(payload, typeof event.itemKey === 'string' ? event.itemKey : undefined);
    latest.set(componentId, payload.component_id === undefined && componentId ? { ...payload, component_id: componentId } : payload);
  }
  return [...latest.values()];
}

function qualityArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => qualityRecord(item)).filter((item): item is JsonRecord => item !== undefined);
}

function qualityText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(qualityText).join(' ');
  if (value && typeof value === 'object') return Object.entries(value as JsonRecord).map(([key, item]) => `${key} ${qualityText(item)}`).join(' ');
  return '';
}

function qualityObjects(value: unknown, key?: string): JsonRecord[] {
  const found: JsonRecord[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== 'object') return;
    const object = item as JsonRecord;
    if (!key || Object.prototype.hasOwnProperty.call(object, key)) found.push(object);
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return found;
}

function qualityPath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const match = value.match(/^(.+?):(\d+)(?:[-:]\d+)?$/);
    return match ? match[1] : value;
  }
  const object = qualityRecord(value);
  if (!object) return undefined;
  return typeof object.path === 'string' ? object.path : typeof object.file === 'string' ? object.file : typeof object.file_path === 'string' ? object.file_path : undefined;
}

function qualityLine(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const match = value.match(/:(\d+)(?:[-:]\d+)?$/);
    return match ? Number(match[1]) : undefined;
  }
  const object = qualityRecord(value);
  if (!object) return undefined;
  for (const field of ['line', 'line_number', 'lineNumber', 'start_line', 'startLine', 'line_start']) {
    if (Number.isSafeInteger(object[field])) return Number(object[field]);
  }
  return undefined;
}

function qualityCoordinates(value: unknown): Array<{ path: string; line: number }> {
  const result: Array<{ path: string; line: number }> = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== 'object' && typeof item !== 'string') return;
    const pathValue = qualityPath(item);
    const lineValue = qualityLine(item);
    if (pathValue !== undefined && lineValue !== undefined) result.push({ path: pathValue, line: lineValue });
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [key, child] of Object.entries(item as JsonRecord)) if (key.toLowerCase().includes('coordinate')) visit(child);
    }
  };
  visit(value);
  return result;
}

function qualitySafeRelative(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && value !== '.' && value !== '..' && !value.split(/[\\/]+/).includes('..') && !value.includes('\0');
}

function qualityLineCount(input: QualityInput, _workspace: string | undefined, relative: string, sourceFiles?: Record<string, string>): number | undefined {
  const files = sourceFiles || input.sourceFiles;
  if (files && typeof files[relative] === 'string') return files[relative].split(/\r?\n/).length;
  return undefined;
}

function qualityCoordinateCheck(payloads: readonly JsonRecord[], input: QualityInput, sourceFiles?: Record<string, string>, sourceScope = 'source'): { pass: boolean; details: JsonRecord } {
  const workspace = input.patchedWorkspace || input.workspace;
  const errors: string[] = [];
  let ownedCount = 0;
  let reviewedCount = 0;
  for (const payload of payloads) {
    const owned = (Array.isArray(payload.sorted_owned_paths) ? payload.sorted_owned_paths : payload.owned_paths) as unknown[] | undefined;
    const ownedPaths = (owned || []).map(String);
    const closure = (Array.isArray(payload.sorted_dependency_closure) ? payload.sorted_dependency_closure : payload.dependency_closure) as unknown[] | undefined;
    const known = new Set([...ownedPaths, ...(closure || []).map(String)]);
    const reviewed = qualityArray(payload.reviewedFiles ?? payload.reviewed_files);
    const reviewedPaths = new Set<string>();
    for (const row of reviewed) {
      const reviewedPath = qualityPath(row.path ?? row.file ?? row.file_path);
      if (!reviewedPath || !qualitySafeRelative(reviewedPath) || !known.has(reviewedPath)) errors.push(`${qualityComponentId(payload)} reviewed path`);
      else { reviewedPaths.add(reviewedPath); reviewedCount += 1; }
      const coords = qualityCoordinates(row.coordinates ?? row.coordinate ?? row.spans);
      for (const coordinate of coords) {
        const lines = qualityLineCount(input, workspace, coordinate.path, sourceFiles);
        if (!qualitySafeRelative(coordinate.path) || !known.has(coordinate.path) || lines === undefined || coordinate.line < 1 || coordinate.line > lines) errors.push(`${qualityComponentId(payload)} reviewed coordinate`);
      }
    }
    for (const ownedPath of ownedPaths) if (!reviewedPaths.has(ownedPath)) errors.push(`${qualityComponentId(payload)} missing reviewed ${ownedPath}`);
    ownedCount += ownedPaths.length;
    for (const field of ['requirements', 'interfaces', 'findings']) {
      for (const object of qualityObjects(payload[field])) {
        for (const coordinate of qualityCoordinates(object.coordinates ?? object.coordinate ?? object.spans)) {
          const lines = qualityLineCount(input, workspace, coordinate.path, sourceFiles);
          if (!qualitySafeRelative(coordinate.path) || !known.has(coordinate.path) || lines === undefined || coordinate.line < 1 || coordinate.line > lines) errors.push(`${qualityComponentId(payload)} ${field} coordinate`);
        }
      }
    }
  }
  return { pass: payloads.length > 0 && errors.length === 0 && ownedCount > 0 && reviewedCount >= ownedCount, details: { source_scope: sourceScope, payloads: payloads.length, owned_files: ownedCount, reviewed_files: reviewedCount, errors } };
}

function qualitySeverity(value: unknown): number {
  const normalized = String(value ?? '').toLowerCase();
  return normalized === 'critical' ? 4 : normalized === 'high' ? 3 : normalized === 'medium' ? 2 : 0;
}

function qualityLikelyConfirmed(value: JsonRecord): boolean {
  const text = qualityText(value).toLowerCase();
  return Number(value.confidence) >= 0.7 && (String(value.likelihood ?? value.calibration ?? value.certainty ?? '').toLowerCase().includes('likely') || String(value.likelihood ?? value.calibration ?? value.certainty ?? '').toLowerCase().includes('confirmed') || /\b(likely|confirmed)\b/.test(text));
}

function qualityBugConcepts(value: unknown): { decode: boolean; control: boolean; effect: boolean } {
  const text = qualityText(value);
  return {
    decode: /malformed|decode|invalid json|extra json/i.test(text),
    control: /fall(?:s|ing)?[-\s]*through|missing return|continues?|no return|unreturned/i.test(text),
    effect: /persist|mutat|create\s*\(|state|effect|dispatch/i.test(text),
  };
}

function qualityHasCoordinate(value: unknown, predicate: (coordinate: { path: string; line: number }) => boolean): boolean {
  return qualityCoordinates(value).some(predicate);
}

function qualityPayloadCoordinates(payload: JsonRecord): Array<{ path: string; line: number }> {
  const coordinates: Array<{ path: string; line: number }> = [];
  for (const field of ['reviewedFiles', 'reviewed_files', 'requirements', 'interfaces', 'findings']) {
    for (const object of qualityObjects(payload[field])) coordinates.push(...qualityCoordinates(object.coordinates ?? object.coordinate ?? object.spans));
  }
  return coordinates;
}

function qualityScanSpans(input: QualityInput): { returnLine?: number; testStart?: number; testEnd?: number } {
  const sourceFiles = input.patchedSourceFiles || input.sourceFiles;
  const http = sourceFiles?.['http.go'];
  const test = sourceFiles?.['http_test.go'];
  const lines = http?.split(/\r?\n/) || [];
  const decodeIndex = lines.findIndex(line => /\b(?:decodeErr|decodeError|json\.NewDecoder)\b/.test(line) && /if|Decode|decode/i.test(line));
  let returnIndex = -1;
  if (decodeIndex >= 0) {
    let depth = 0;
    for (let index = decodeIndex; index < lines.length; index += 1) {
      depth += (lines[index].match(/{/g) || []).length;
      depth -= (lines[index].match(/}/g) || []).length;
      if (/\b(?:invalid JSON|malformed|decode)\b/i.test(lines[index]) && /writeJSONError/.test(lines[index])) {
        const candidate = lines.slice(index + 1, Math.min(lines.length, index + 6)).findIndex(next => /^\s*return\s*\}?\s*$/.test(next));
        if (candidate >= 0) { returnIndex = index + 1 + candidate; break; }
      }
      if (index > decodeIndex && depth <= 0) break;
    }
  }
  const testLines = test?.split(/\r?\n/) || [];
  const testStartIndex = testLines.findIndex(line => /\bTestMalformedWriteDoesNotPersist\b/.test(line));
  let testEndIndex = -1;
  if (testStartIndex >= 0) {
    let depth = 0;
    for (let index = testStartIndex; index < testLines.length; index += 1) {
      depth += (testLines[index].match(/{/g) || []).length;
      depth -= (testLines[index].match(/}/g) || []).length;
      if (index === testStartIndex && depth <= 0) { testEndIndex = index; break; }
      if (index > testStartIndex && depth <= 0) { testEndIndex = index; break; }
    }
  }
  return { returnLine: returnIndex >= 0 ? returnIndex + 2 : undefined, testStart: testStartIndex >= 0 ? testStartIndex + 1 : undefined, testEnd: testEndIndex >= 0 ? testEndIndex + 1 : undefined };
}

function qualityResult(name: string, pass: boolean, details: JsonRecord): JsonRecord {
  return { name, pass, score: pass ? 1 : 0, details };
}

/** Evaluate the seven deterministic onboarding-quality criteria. */
export function evaluateOnboardingQuality(first: QualityInput | unknown, second?: unknown, third?: unknown): JsonRecord {
  let input: QualityInput;
  if (first && typeof first === 'object' && !Array.isArray(first) && (Object.prototype.hasOwnProperty.call(first, 'baselineCheckpoint') || Object.prototype.hasOwnProperty.call(first, 'baselineCandidate') || (Object.prototype.hasOwnProperty.call(first, 'oracle') && !Object.prototype.hasOwnProperty.call(first, 'baseline') && !Object.prototype.hasOwnProperty.call(first, 'resume')))) input = first as QualityInput;
  else if (qualityRecord(first)?.components !== undefined) input = { baselineCandidate: first, resumeCandidate: second, ...(qualityRecord(third) || {}) } as QualityInput;
  else if (Array.isArray(first)) input = { baselineCandidate: { components: first }, resumeCandidate: second, ...(qualityRecord(third) || {}) } as QualityInput;
  else if (qualityRecord(first)?.baseline !== undefined || qualityRecord(first)?.resume !== undefined) {
    const wrapper = qualityRecord(first) as JsonRecord;
    const baseline = qualityRecord(wrapper.baseline) || {};
    const resume = qualityRecord(wrapper.resume) || {};
    input = { ...wrapper, baselineCheckpoint: baseline.checkpoint || baseline, resumeCheckpoint: resume.checkpoint || resume, baselineCandidate: baseline.candidate, resumeCandidate: resume.candidate } as QualityInput;
  }
  else input = { baselineCheckpoint: first, resumeCheckpoint: second, ...(qualityRecord(third) || {}) } as QualityInput;
  if (!input.sourceFiles) input.sourceFiles = input.source_files || input.sources;
  const baselineProject = qualityPayload(input.baselineCandidate) || qualityCandidates(input.baselineCheckpoint, 1)[0];
  const baselineComponents = qualityCandidateComponents(baselineProject);
  const directResume = input.resumeCandidate ? qualityCandidateComponents(input.resumeCandidate) : [];
  const resumeCandidates = Array.isArray(input.resumeComponentCandidates) ? input.resumeComponentCandidates.map(qualityPayload).filter((value): value is JsonRecord => value !== undefined) : directResume.length > 0 ? directResume : qualityCandidates(input.resumeCheckpoint, 2);
  const directBaseline = baselineComponents.filter(component => qualityObjects(component.reviewedFiles ?? component.reviewed_files).length > 0);
  const baselineCandidates = Array.isArray(input.baselineComponentCandidates) ? input.baselineComponentCandidates.map(qualityPayload).filter((value): value is JsonRecord => value !== undefined) : directBaseline.length > 0 ? directBaseline : qualityCandidates(input.baselineCheckpoint, 2);
  const changedId = String(input.changedComponentId || input.changed_component_id || qualityScopeKey(qualityEvents(input.resumeCheckpoint).filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && qualityScopeLength(event) === 2).slice(-1)[0]) || '');
  const latestById = new Map<string, JsonRecord>();
  for (const candidate of [...baselineCandidates, ...resumeCandidates]) latestById.set(qualityComponentId(candidate), candidate);
  const baselineDetailsById = new Map<string, JsonRecord>();
  for (const candidate of baselineCandidates) baselineDetailsById.set(qualityComponentId(candidate), candidate);
  const componentPayloads = [...latestById.values()];
  const baselineItems = Array.isArray(input.baselineWorkItems) ? input.baselineWorkItems as unknown[] : qualityItemsFromCheckpoint(input.baselineCheckpoint);
  const resumedItems = Array.isArray(input.resumeWorkItems || input.workItems) ? (input.resumeWorkItems || input.workItems) as unknown[] : qualityItemsFromCheckpoint(input.resumeCheckpoint);
  const ownershipItems = baselineItems.length > 0 ? baselineItems : resumedItems;
  const finalItems = resumedItems.map(qualityPayload).filter((value): value is JsonRecord => value !== undefined);
  const ownershipItemRecords = ownershipItems.map(qualityPayload).filter((value): value is JsonRecord => value !== undefined);
  const itemByComponent = new Map(finalItems.map(item => [qualityComponentId(item), item]));
  const ownershipItemByComponent = new Map(ownershipItemRecords.map(item => [qualityComponentId(item), item]));
  const componentPaths = (item: JsonRecord | undefined): { owned_paths?: string[]; dependency_closure?: string[] } => {
    if (!item) return {};
    const subject = qualityRecord(item.proof_component_subject);
    const owned = (Array.isArray(item.sorted_owned_paths) ? item.sorted_owned_paths : Array.isArray(item.owned_paths) ? item.owned_paths : Array.isArray(subject?.sorted_owned_paths) ? subject.sorted_owned_paths : undefined)?.map(String);
    const closure = (Array.isArray(item.sorted_dependency_closure) ? item.sorted_dependency_closure : Array.isArray(item.dependency_closure) ? item.dependency_closure : Array.isArray(subject?.sorted_dependency_closure) ? subject.sorted_dependency_closure : undefined)?.map(String);
    return { ...(owned ? { owned_paths: owned } : {}), ...(closure ? { dependency_closure: closure } : {}) };
  };
  const enrichedComponentPayloads = componentPayloads.map(payload => ({ ...componentPaths(itemByComponent.get(qualityComponentId(payload))), ...payload }));

  const expectedGroups = [['http.go', 'http_test.go'], ['service.go', 'service_test.go'], ['entry.go', 'store.go', 'go.mod']].map(group => group.sort());
  const actualGroups = baselineComponents.map(component => {
    const paths = Array.isArray(component.owned_paths) ? component.owned_paths.map(String).sort() : [];
    return paths;
  });
  const groupingPass = actualGroups.length === expectedGroups.length && expectedGroups.every(group => actualGroups.some(actual => canonicalValue(actual) === canonicalValue(group)));
  const candidateOwnership = baselineComponents.flatMap(component => Array.isArray(component.owned_paths) ? component.owned_paths.map(String) : []);
  const itemOwnership = ownershipItemRecords.flatMap(item => (Array.isArray(item.sorted_owned_paths) ? item.sorted_owned_paths : item.owned_paths || []).map(String));
  const candidateIds = new Set(baselineComponents.map(component => qualityComponentId(component)));
  const itemIds = new Set(ownershipItemRecords.map(item => qualityComponentId(item)));
  const itemById = ownershipItemByComponent;
  const mappingPass = candidateIds.size === 3 && itemIds.size === 3 && [...candidateIds].every(id => itemIds.has(id)) && [...baselineComponents].every(component => {
    const item = itemById.get(qualityComponentId(component));
    const owned = Array.isArray(component.owned_paths) ? component.owned_paths.map(String).sort() : [];
    const itemOwned = item ? (Array.isArray(item.sorted_owned_paths) ? item.sorted_owned_paths : item.owned_paths || []).map(String).sort() : [];
    return !!item && canonicalValue(owned) === canonicalValue(itemOwned);
  }) && canonicalValue([...candidateOwnership].sort()) === canonicalValue([...new Set(candidateOwnership)].sort()) && canonicalValue([...itemOwnership].sort()) === canonicalValue([...new Set(itemOwnership)].sort()) && canonicalValue([...candidateOwnership].sort()) === canonicalValue([...itemOwnership].sort()) && candidateOwnership.length === SUBJECT_FILES.length;
  const baselineDetailPayloads = baselineComponents.map(component => {
    const payload = baselineDetailsById.get(qualityComponentId(component)) || component;
    return { ...componentPaths(itemByComponent.get(qualityComponentId(component))), ...payload };
  });
  const httpBaseline = baselineDetailPayloads.find(component => (Array.isArray(component.owned_paths) && component.owned_paths.includes('http.go')) || /http/i.test(qualityComponentId(component)));
  const httpResume = (enrichedComponentPayloads.find(component => qualityComponentId(component) === changedId) || (changedId ? undefined : enrichedComponentPayloads.find(component => Array.isArray(component.owned_paths) && component.owned_paths.includes('http.go'))));
  const baselineFindings = httpBaseline ? qualityObjects(httpBaseline.findings) : [];
  const bugEvidence = baselineFindings.find(finding => {
    const text = qualityText(finding);
    const concepts = qualityBugConcepts(text);
    return qualitySeverity(finding.severity) >= 2 && qualityLikelyConfirmed(finding) && concepts.decode && concepts.control && concepts.effect && qualityHasCoordinate(finding, coordinate => coordinate.path === 'http.go' && coordinate.line >= 43 && coordinate.line <= 52);
  });
  const bugPass = bugEvidence !== undefined;
  const allBaselinePayloads = baselineDetailPayloads;
  const xssFalsePositive = allBaselinePayloads.some(payload => qualityObjects(payload.findings).some(finding => qualitySeverity(finding.severity) >= 3 && /xss|cross.?site|html injection|script injection|unsanitized html/i.test(qualityText(finding))));
  const xssPass = !xssFalsePositive;
  const resumeText = qualityText(httpResume || '');
  const resolutionAssertion = /(?:malformed|decode|invalid json|rejected)[\s\S]{0,180}(?:no|without|does not|never|zero|none)[\s\S]{0,100}(?:persist|state|effect|dispatch|mutation)|(?:no|without|does not|never|zero|none)[\s\S]{0,100}(?:persist|state|effect|dispatch|mutation)[\s\S]{0,180}(?:malformed|decode|invalid json|rejected)/i.test(resumeText);
  const activeDefect = qualityObjects(httpResume?.findings).some(finding => qualitySeverity(finding.severity) >= 2 && qualityLikelyConfirmed(finding) && Object.values(qualityBugConcepts(finding)).some(Boolean) && !/resolved|fixed|closed|no active|remediated/i.test(qualityText(finding)));
  const spans = qualityScanSpans(input);
  const resumeCoordinates = httpResume ? qualityPayloadCoordinates(httpResume) : [];
  const returnCitation = spans.returnLine !== undefined && resumeCoordinates.some(coordinate => coordinate.path === 'http.go' && Math.abs(coordinate.line - spans.returnLine!) <= 1);
  const testCitation = spans.testStart !== undefined && spans.testEnd !== undefined && resumeCoordinates.some(coordinate => coordinate.path === 'http_test.go' && coordinate.line >= spans.testStart! && coordinate.line <= spans.testEnd!) && /TestMalformedWriteDoesNotPersist/.test(resumeText);
  const resolutionPass = !!httpResume && resolutionAssertion && !activeDefect && returnCitation && testCitation;
  const oracle = input.oracle || input.hiddenOracle || {};
  const oracleBaseline = qualityRecord(oracle.baseline);
  const oraclePatched = qualityRecord(oracle.patched || oracle.resume);
  const oraclePass = (oracleBaseline ? Number(oracleBaseline.status) !== 0 && (oracleBaseline.expected_failure_marker === true || oracleBaseline.failure_marker === 'entries after rejected write = 1' || oracleBaseline.marker === 'entries after rejected write = 1' || String(oracleBaseline.outcome || '').toLowerCase() === 'failed') : oracle.baseline_failed === true) && (oraclePatched ? Number(oraclePatched.status) === 0 || oraclePatched.passed === true || String(oraclePatched.outcome || '').toLowerCase() === 'passed' : oracle.patched_passed === true);
  const baselineCoordinates = qualityCoordinateCheck(baselineDetailPayloads, input, input.baselineSourceFiles || input.sourceFiles, 'original subject');
  const patchedCoordinates = qualityCoordinateCheck(httpResume ? [httpResume] : [], input, input.patchedSourceFiles || input.sourceFiles, 'patched workspace');
  const coordinates = {
    pass: baselineCoordinates.pass && patchedCoordinates.pass,
    details: { baseline: baselineCoordinates.details, resumed_changed: patchedCoordinates.details },
  };
  const criteria = [
    qualityResult('grouping', groupingPass, { expected: expectedGroups, actual: actualGroups }),
    qualityResult('ownership', mappingPass, { candidate_paths: candidateOwnership, work_item_paths: itemOwnership, candidate_to_work_item: [...candidateIds].every(id => itemIds.has(id)) }),
    qualityResult('coordinates', coordinates.pass, coordinates.details),
    qualityResult('baseline_http_candidate', bugPass, { component_id: httpBaseline ? qualityComponentId(httpBaseline) : null, detected: bugPass, boundary_coordinate: bugEvidence ? qualityCoordinates(bugEvidence).find(coordinate => coordinate.path === 'http.go') : null }),
    qualityResult('no_xss_false_positive', xssPass, { high_or_critical_xss_finding: xssFalsePositive }),
    qualityResult('resume_http_resolution', resolutionPass, { component_id: changedId || null, no_active_defect: !activeDefect, semantic_assertion: resolutionAssertion, return_citation: returnCitation, test_citation: testCitation, scanned_spans: spans }),
    qualityResult('hidden_oracle', oraclePass, { baseline_failed_expected_marker: !!oracleBaseline && Number(oracleBaseline.status) !== 0, patched_passed: !!oraclePatched && Number(oraclePatched.status) === 0 }),
  ];
  const score = criteria.reduce((total, criterion) => total + Number(criterion.score), 0);
  return { schema: 'urn:reqproof:agent-governance:exp-0209-onboarding-quality:v1', criteria, criterion_results: Object.fromEntries(criteria.map(criterion => [criterion.name, criterion])), score, total: ONBOARDING_QUALITY_CRITERIA.length, overall_pass: score === ONBOARDING_QUALITY_CRITERIA.length, pass: score === ONBOARDING_QUALITY_CRITERIA.length };
}

function verifyManualBaseline(evaluatorDirectory: string): JsonRecord {
  const file = path.join(evaluatorDirectory, 'manual-baseline.json');
  const stat = fs.lstatSync(file);
  assertInvariant('manual baseline is a regular non-symlink file', stat.isFile() && !stat.isSymbolicLink());
  const bytes = fs.readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assertInvariant('manual baseline matches the pinned SHA-256', digest === MANUAL_BASELINE_SHA256);
  const value = record(JSON.parse(bytes.toString('utf8')), 'manual baseline');
  assertInvariant('manual baseline schema is exact', value.schema === 'urn:reqproof:agent-governance:p1-manual-baseline:v2' && value.attempt === 2);
  const subject = record(value.subject, 'manual baseline subject');
  assertInvariant('manual baseline subject tree is pinned', subject.tree_sha256 === SUBJECT_TREE_SHA256 && subject.go_file_count === 6 && subject.module === 'journalservice' && subject.manifest_digest_rule === 'SHA-256 over ordered sha256sum records: 64 lowercase hex, two spaces, filename, LF.');
  assertInvariant('manual baseline subject manifest is exact', canonicalValue(subject.manifest_order) === canonicalValue([...SUBJECT_FILES].sort()) && canonicalValue(subject.file_sha256) === canonicalValue(SUBJECT_SHA256));
  const hidden = record(value.hidden_oracle, 'manual baseline hidden oracle');
  assertInvariant('manual baseline hidden oracle is pinned', hidden.path === 'evaluator/hidden_missing_return_test.go' && hidden.sha256 === HIDDEN_TEST_SHA256 && hidden.baseline_exit_code === 1 && hidden.baseline_evidence === 'entries after rejected write = 1');
  const changes = qualityArray(value.changes);
  const bugfix = changes.find(change => change.id === 'bugfix');
  assertInvariant('manual baseline bugfix pin is exact', !!bugfix && bugfix.patch === 'evaluator/changes/0001-reject-malformed-write.patch' && bugfix.patch_sha256 === PATCH_SHA256 && bugfix.parent_tree_sha256 === SUBJECT_TREE_SHA256 && bugfix.result_tree_sha256 === PATCH_RESULT_TREE_SHA256 && Array.isArray(bugfix.impact_files) && canonicalValue(bugfix.impact_files) === canonicalValue(['http.go', 'http_test.go']));
  return { sha256: digest, schema: value.schema, subject_tree_sha256: SUBJECT_TREE_SHA256, hidden_test_sha256: HIDDEN_TEST_SHA256, patch_sha256: PATCH_SHA256 };
}

type AcceptedEvaluationArtifact = AcceptedResumeArtifact & {
  resumeStarted: JsonRecord;
  resumeCheckpoint: JsonRecord;
  resumeReport: JsonRecord;
  resumeCompleted: JsonRecord;
  resumeMetadata: JsonRecord;
  resumeGate: LiveResumeCheckpointValidation;
  resumeWorkItems: JsonRecord[];
  manualBaseline: JsonRecord;
};

function canonicalPrivateJson(file: string, label: string): JsonRecord {
  regularPrivateFile(file, label);
  const bytes = fs.readFileSync(file, 'utf8');
  const value = record(JSON.parse(bytes), label);
  assertInvariant(`${label} bytes are canonical`, bytes === `${JSON.stringify(value, null, 2)}\n` || bytes === `${canonicalValue(value)}\n`);
  return value;
}

function acceptedEvaluationArtifact(outputDirectory: string, evaluatorDirectory: string): AcceptedEvaluationArtifact {
  const artifact = acceptedResumeArtifact(outputDirectory, false);
  const started = canonicalPrivateJson(path.join(outputDirectory, RESUME_STARTED_FILE), 'resume started marker');
  const metadata = canonicalPrivateJson(path.join(outputDirectory, RESUME_INPUT_METADATA_FILE), 'resume input metadata');
  const revalidationBytes = fs.readFileSync(path.join(outputDirectory, RESUME_REVALIDATION_FILE));
  const workItemsBytes = fs.readFileSync(path.join(outputDirectory, RESUME_WORK_ITEMS_FILE));
  const continued = canonicalPrivateJson(path.join(outputDirectory, RESUME_CHECKPOINT_FILE), 'continued checkpoint');
  const report = canonicalPrivateJson(path.join(outputDirectory, RESUME_REPORT_FILE), 'resume report');
  const completed = canonicalPrivateJson(path.join(outputDirectory, RESUME_COMPLETED_FILE), 'resume completed marker');
  assertInvariant('accepted resume marker is started', started.status === 'started');
  assertInvariant('accepted resume report is passed', report.status === 'passed' && report.mode === 'resume-only' && report.gate_passed === true);
  assertInvariant('accepted resume completed marker is completed', completed.status === 'completed');
  assertInvariant('accepted resume session and digest are unchanged', report.session_id === artifact.baselineGate.sessionId && completed.session_id === artifact.baselineGate.sessionId && report.graph_semantic_digest === artifact.baselineGate.graphSemanticDigest && completed.graph_semantic_digest === artifact.baselineGate.graphSemanticDigest);
  assertInvariant('accepted resume marker has the baseline binding', started.baseline_session_id === artifact.baselineGate.sessionId && started.baseline_checkpoint_sha256 === createHash('sha256').update(fs.readFileSync(path.join(outputDirectory, BASELINE_CHECKPOINT_FILE))).digest('hex'));
  assertInvariant('accepted resume metadata is bound to baseline', metadata.session_id === artifact.baselineGate.sessionId && metadata.graph_semantic_digest === artifact.baselineGate.graphSemanticDigest);
  regularPrivateFile(path.join(outputDirectory, RESUME_REVALIDATION_FILE), 'resume revalidation');
  regularPrivateFile(path.join(outputDirectory, RESUME_WORK_ITEMS_FILE), 'resume work-items');
  assertInvariant('accepted resume Proof bytes match metadata hashes', createHash('sha256').update(revalidationBytes).digest('hex') === metadata.revalidation_sha256 && createHash('sha256').update(workItemsBytes).digest('hex') === metadata.work_items_sha256);
  validateResumeWorkspace(artifact, started, metadata);
  const resumeGate = validateLiveResumeCheckpoint(continued, artifact.baselineCheckpoint, artifact.config, { changedComponentId: metadata.changed_component_id, changedPaths: metadata.changed_paths, mutationEventCount: metadata.mutation_event_count });
  assertInvariant('accepted resume has the exact 4+1 RoleRuns', artifact.baselineGate.counts.inspectAttempts === 4 && resumeGate.counts.inspectAttempts === 5 && resumeGate.counts.proofCandidates === 5 && resumeGate.counts.proofAdmissions === 5);
  const resumeWorkItems = activeOnboardingWorkItemsFromCheckpoint(continued, artifact.config);
  assertInvariant('accepted resume has exactly three active depth-2 WorkItems', resumeWorkItems.length === 3);
  const manualBaseline = verifyManualBaseline(evaluatorDirectory);
  return { ...artifact, resumeStarted: started, resumeCheckpoint: continued, resumeReport: report, resumeCompleted: completed, resumeMetadata: metadata, resumeGate, resumeWorkItems, manualBaseline };
}

function copyHiddenOracle(directory: string, evaluatorDirectory: string): void {
  const source = path.join(evaluatorDirectory, 'hidden_missing_return_test.go');
  const destination = path.join(directory, 'hidden_missing_return_test.go');
  const stat = fs.lstatSync(source);
  assertInvariant('hidden oracle is a regular non-symlink file', stat.isFile() && !stat.isSymbolicLink());
  assertInvariant('hidden oracle remains pinned', sha256File(source) === HIDDEN_TEST_SHA256);
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
}

function oracleTreeDigest(directory: string): string {
  const hashes = SUBJECT_FILES.map(file => `${sha256File(path.join(directory, file))}  ${file}\n`).join('');
  return createHash('sha256').update(hashes).digest('hex');
}

function runEvaluationOracle(workspace: string, subjectDirectory: string, evaluatorDirectory: string, outputDirectory: string): JsonRecord {
  const run = (label: string, copy: (destination: string) => void): JsonRecord => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `visor-exp-0209-evaluation-${label}-`));
    makePrivateDirectory(directory);
    try {
      assertInvariant(`${label} oracle copy is outside output/workspace`, !pathsOverlap(directory, outputDirectory) && !pathsOverlap(directory, workspace));
      copy(directory);
      copyHiddenOracle(directory, evaluatorDirectory);
      const result = command('go', ['test', './...'], directory, { ...process.env, ...OFFLINE_GO_ENV });
      const output = `${result.stdout}\n${result.stderr}`;
      return {
        status: result.status,
        passed: result.status === 0,
        expected_failure_marker: output.includes('entries after rejected write = 1'),
        tree_sha256: oracleTreeDigest(directory),
        hidden_test_sha256: HIDDEN_TEST_SHA256,
        outside_workspace: !pathWithin(directory, workspace),
        cleaned: true,
      };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  const baseline = run('baseline', destination => copyBaseline(subjectDirectory, destination));
  const patched = run('patched', destination => copyBaselineFromWorkspace(workspace, destination));
  return {
    command: 'go test ./...',
    offline_go: true,
    baseline: { status: baseline.status, failed: baseline.status !== 0, expected_failure_marker: baseline.expected_failure_marker, tree_sha256: baseline.tree_sha256, hidden_test_sha256: baseline.hidden_test_sha256, cleaned: baseline.cleaned },
    patched: { status: patched.status, passed: patched.status === 0, tree_sha256: patched.tree_sha256, hidden_test_sha256: patched.hidden_test_sha256, cleaned: patched.cleaned },
  };
}

const EVALUATION_PUBLICATION_FILES = [GRAPH_SOURCE_FILE, EVALUATION_FILE, LIVE_REPORT_FILE, LIVE_REPORT_MARKDOWN_FILE, EVALUATION_COMPLETED_FILE] as const;
type PublishedEvaluationArtifact = { name: string; device: number; inode: number };

function evaluationFinalArtifacts(outputDirectory: string): string[] {
  return [GRAPH_SOURCE_FILE, EVALUATION_FILE, LIVE_REPORT_FILE, LIVE_REPORT_MARKDOWN_FILE, EVALUATION_COMPLETED_FILE].filter(file => {
    try { fs.lstatSync(path.join(outputDirectory, file)); return true; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  });
}

function evaluationStagingEntries(outputDirectory: string): string[] {
  try { return fs.readdirSync(outputDirectory).filter(name => name.startsWith('.evaluation-publish-')); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
}

function assertNoPriorEvaluationArtifacts(outputDirectory: string): void {
  const marker = fs.existsSync(path.join(outputDirectory, EVALUATION_STARTED_FILE));
  assertInvariant('evaluation output has no prior marker or evidence', !marker && evaluationFinalArtifacts(outputDirectory).length === 0 && evaluationStagingEntries(outputDirectory).length === 0);
}

function createEvaluationStagingDirectory(outputDirectory: string): string {
  assertInvariant('evaluation publication has no pre-existing final evidence', evaluationFinalArtifacts(outputDirectory).length === 0);
  assertInvariant('evaluation publication has no pre-existing staging directory', evaluationStagingEntries(outputDirectory).length === 0);
  const directory = fs.mkdtempSync(path.join(outputDirectory, '.evaluation-publish-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function stageEvaluationArtifact(stagingDirectory: string, name: string, bytes: string): void {
  assertInvariant('evaluation publication file name is fixed', EVALUATION_PUBLICATION_FILES.includes(name as typeof EVALUATION_PUBLICATION_FILES[number]));
  writeExclusiveBytes(path.join(stagingDirectory, `${name}.stage`), bytes);
}

function publishEvaluationArtifacts(outputDirectory: string, stagingDirectory: string, published: PublishedEvaluationArtifact[]): void {
  assertInvariant('evaluation staging directory is output-owned', path.dirname(path.resolve(stagingDirectory)) === path.resolve(outputDirectory) && path.basename(stagingDirectory).startsWith('.evaluation-publish-'));
  for (const name of EVALUATION_PUBLICATION_FILES) {
    const staged = path.join(stagingDirectory, `${name}.stage`);
    const final = path.join(outputDirectory, name);
    try { fs.lstatSync(final); throw new Error(`evaluation final artifact already exists: ${name}`); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    fs.renameSync(staged, final);
    const stat = fs.lstatSync(final);
    assertInvariant(`published evaluation ${name} is private`, stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
    published.push({ name, device: stat.dev, inode: stat.ino });
    fsyncDirectory(outputDirectory);
  }
  fsyncDirectory(outputDirectory);
}

function cleanupEvaluationPublication(outputDirectory: string, stagingDirectory: string | undefined, published: readonly PublishedEvaluationArtifact[]): void {
  for (const artifact of published) {
    const file = path.join(outputDirectory, artifact.name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === artifact.device && stat.ino === artifact.inode) fs.unlinkSync(file);
    } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  if (stagingDirectory) {
    assertInvariant('evaluation staging cleanup is output-owned', path.dirname(path.resolve(stagingDirectory)) === path.resolve(outputDirectory) && path.basename(stagingDirectory).startsWith('.evaluation-publish-'));
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
  fsyncDirectory(outputDirectory);
}

function evaluationMarkdownBytes(report: JsonRecord): string {
  const criteria = Array.isArray(report.criteria) ? report.criteria.map((criterion: JsonRecord) => `- ${criterion.name}: ${criterion.pass ? 'pass' : 'fail'} (${criterion.score}/1)`).join('\n') : '';
  return ['# EXP-0209 onboarding quality evaluation', '', `- Status: ${report.status}`, `- Score: ${report.score}/${report.total}`, `- Session: ${report.session_id}`, `- Changed component: ${report.changed_component_id}`, `- Oracle baseline failed: ${report.oracle?.baseline?.failed ? 'yes' : 'no'}`, `- Oracle patched passed: ${report.oracle?.patched?.passed ? 'yes' : 'no'}`, '', 'Criteria:', criteria, '', 'This report contains controller evidence and hashes only.', ''].join('\n');
}

function writeEvaluationArtifacts(outputDirectory: string, report: JsonRecord, completed: JsonRecord, graphSourceBytes: string): void {
  const staging = createEvaluationStagingDirectory(outputDirectory);
  const published: PublishedEvaluationArtifact[] = [];
  try {
    stageEvaluationArtifact(staging, GRAPH_SOURCE_FILE, graphSourceBytes);
    stageEvaluationArtifact(staging, EVALUATION_FILE, `${JSON.stringify(report, null, 2)}\n`);
    stageEvaluationArtifact(staging, LIVE_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    stageEvaluationArtifact(staging, LIVE_REPORT_MARKDOWN_FILE, evaluationMarkdownBytes(report));
    stageEvaluationArtifact(staging, EVALUATION_COMPLETED_FILE, `${JSON.stringify(completed, null, 2)}\n`);
    fsyncDirectory(staging);
    publishEvaluationArtifacts(outputDirectory, staging, published);
    cleanupEvaluationPublication(outputDirectory, staging, []);
  } catch (error) {
    try { cleanupEvaluationPublication(outputDirectory, staging, published); } catch { /* Preserve original publication error. */ }
    throw error;
  }
}

function trackedGraphSourceBytes(): Buffer {
  const relative = path.relative(REPO_ROOT, PROFILE_PATH).split(path.sep).join('/');
  const stat = fs.lstatSync(PROFILE_PATH);
  assertInvariant('graph source is a regular non-symlink file', stat.isFile() && !stat.isSymbolicLink());
  const tracked = requireCommand('git', ['ls-files', '--error-unmatch', '--', relative]).stdout.trim();
  assertInvariant('graph source is tracked at its expected path', tracked === relative);
  const status = requireCommand('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=no', '--', relative]).stdout;
  assertInvariant('graph source has no working-tree diff', status === '');
  const headBytes = execFileSync('git', ['show', `HEAD:${relative}`], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
  const currentBytes = fs.readFileSync(PROFILE_PATH);
  assertInvariant('graph source bytes match the current HEAD blob', Buffer.from(headBytes).equals(currentBytes));
  return currentBytes;
}

function runEvaluateOnly(args: ReturnType<typeof parseArgs>): boolean {
  const outputDirectory = args.outputDirectory;
  let started = false;
  try {
    assertNoPriorEvaluationArtifacts(outputDirectory);
    const artifact = acceptedEvaluationArtifact(outputDirectory, args.evaluatorDirectory);
    const inputPins = verifyResumePins(artifact, args.subjectDirectory, args.evaluatorDirectory);
    const baselineBytes = fs.readFileSync(path.join(outputDirectory, BASELINE_CHECKPOINT_FILE));
    const continuedBytes = fs.readFileSync(path.join(outputDirectory, RESUME_CHECKPOINT_FILE));
    const configBytes = fs.readFileSync(path.join(outputDirectory, EFFECTIVE_CONFIG_FILE));
    const graphSourceBytes = trackedGraphSourceBytes();
    const startedEvidence = {
      schema: 'urn:reqproof:agent-governance:exp-0209-evaluation-started:v1',
      status: 'started',
      output_directory: outputDirectory,
      controller_pid: process.pid,
      session_id: artifact.baselineGate.sessionId,
      graph_semantic_digest: artifact.baselineGate.graphSemanticDigest,
      baseline_checkpoint_sha256: createHash('sha256').update(baselineBytes).digest('hex'),
      continued_checkpoint_sha256: createHash('sha256').update(continuedBytes).digest('hex'),
      effective_config_sha256: createHash('sha256').update(configBytes).digest('hex'),
      manual_baseline_sha256: artifact.manualBaseline.sha256,
    };
    writeExclusiveJson(path.join(outputDirectory, EVALUATION_STARTED_FILE), startedEvidence);
    started = true;
    const oracle = runEvaluationOracle(artifact.workspace, args.subjectDirectory, args.evaluatorDirectory, outputDirectory);
    const baselineSourceFiles = Object.fromEntries(SUBJECT_FILES.map(file => [file, fs.readFileSync(path.join(args.subjectDirectory, file), 'utf8')]));
    const patchedSourceFiles = Object.fromEntries(SUBJECT_FILES.map(file => [file, fs.readFileSync(path.join(artifact.workspace, file), 'utf8')]));
    const quality = evaluateOnboardingQuality({ baselineCheckpoint: artifact.baselineCheckpoint, resumeCheckpoint: artifact.resumeCheckpoint, baselineWorkItems: artifact.baselineWorkItems, resumeWorkItems: artifact.resumeWorkItems, baselineSourceFiles, patchedSourceFiles, changedComponentId: artifact.resumeGate.changedComponentId, oracle });
    const graphSourceSha256 = createHash('sha256').update(graphSourceBytes).digest('hex');
    const baselineEvents = qualityEvents(artifact.baselineCheckpoint);
    const resumeEvents = qualityEvents(artifact.resumeCheckpoint);
    const baselineRuns = baselineEvents.filter(event => event.type === 'AttemptStarted' && event.checkId === 'inspect');
    const allRuns = resumeEvents.filter(event => event.type === 'AttemptStarted' && event.checkId === 'inspect');
    const acceptedPins = record(artifact.preflight.pins, 'accepted evaluation pins');
    const acceptedModules = record(artifact.preflight.modules, 'accepted evaluation modules');
    const prefixSha256 = createHash('sha256').update(canonicalValue(baselineEvents), 'utf8').digest('hex');
    const report: JsonRecord = {
      schema: 'urn:reqproof:agent-governance:exp-0209-evaluation:v1',
      status: quality.overall_pass ? 'passed' : 'failed',
      mode: 'evaluate-only',
      output_directory: outputDirectory,
      controller_pid: process.pid,
      session_id: artifact.resumeGate.sessionId,
      graph_semantic_digest: artifact.resumeGate.graphSemanticDigest,
      effective_config_graph_digest: artifact.resumeGate.graphSemanticDigest,
      score: quality.score,
      total: quality.total,
      gate_passed: quality.overall_pass,
      criteria: quality.criteria,
      role_runs: { baseline: 4, resume: 1, total: 5, exact: baselineRuns.length === 4 && allRuns.length === 5, baseline_sequence: baselineRuns.map(event => String(event.checkId)), resume_sequence: allRuns.slice(4).map(event => String(event.checkId)) },
      parallel_fanout: { max_parallelism: 3, baseline_component_inspects: 3, fanout_verified: true },
      session_prefix: { same_session: artifact.resumeGate.sessionId === artifact.baselineGate.sessionId, prefix_identical: true, prefix_events: baselineEvents.length, prefix_sha256: prefixSha256 },
      same_session: artifact.resumeGate.sessionId === artifact.baselineGate.sessionId,
      same_graph_digest: artifact.resumeGate.graphSemanticDigest === artifact.baselineGate.graphSemanticDigest,
      prefix_identical: true,
      changed_component_id: artifact.resumeGate.changedComponentId,
      changed_paths: artifact.resumeGate.changedPaths,
      changed_components: [artifact.resumeGate.changedComponentId],
      reused_components: artifact.baselineGate.componentIds.filter(id => id !== artifact.resumeGate.changedComponentId),
      receipts: { old: artifact.resumeGate.receiptIds.baseline, new: artifact.resumeGate.receiptIds.replacement },
      old_receipt_id: artifact.resumeGate.receiptIds.baseline,
      new_receipt_id: artifact.resumeGate.receiptIds.replacement,
      closure: { components: 3, work_items: artifact.resumeGate.counts.workItems, component_admissions: artifact.resumeGate.counts.componentAdmissions, project_reconciliations: artifact.resumeGate.counts.projectReconciliations },
      oracle,
      hashes: { baseline_checkpoint_sha256: startedEvidence.baseline_checkpoint_sha256, continued_checkpoint_sha256: startedEvidence.continued_checkpoint_sha256, effective_config_sha256: startedEvidence.effective_config_sha256, graph_source_sha256: graphSourceSha256, manual_baseline_sha256: artifact.manualBaseline.sha256, hidden_test_sha256: HIDDEN_TEST_SHA256, patch_sha256: PATCH_SHA256, diff_sha256: artifact.resumeMetadata.diff_sha256, revalidation_sha256: artifact.resumeMetadata.revalidation_sha256, work_items_sha256: artifact.resumeMetadata.work_items_sha256 },
      exact_pins: { visor_base: BASE_VISOR_COMMIT, proof_commit: PROOF_COMMIT, probe_version: PROBE_VERSION, ts_node_version: acceptedModules['ts-node/register/transpile-only']?.version, js_yaml_version: acceptedModules['js-yaml']?.version, codex_version: CODEX_VERSION, subject_files: acceptedPins.subject_files, subject_tree_sha256: inputPins.subject_tree_sha256, hidden_test_sha256: inputPins.hidden_test_sha256, patch_sha256: inputPins.patch_sha256, manual_baseline_sha256: MANUAL_BASELINE_SHA256 },
      quality,
    };
    const completed: JsonRecord = { schema: 'urn:reqproof:agent-governance:exp-0209-evaluation-completed:v1', status: quality.overall_pass ? 'completed' : 'failed', session_id: report.session_id, graph_semantic_digest: report.graph_semantic_digest, score: report.score, total: report.total, gate_passed: report.gate_passed, evaluation_sha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), controller_pid: process.pid };
    writeEvaluationArtifacts(outputDirectory, report, completed, graphSourceBytes.toString('utf8'));
    process.stdout.write(`EXP-0209 onboarding evaluation ${report.status}: ${outputDirectory}\n`);
    return quality.overall_pass;
  } catch (error) {
    if (started) {
      // The started marker is deliberately never replaced. An operational
      // error is distinct from a completed quality failure.
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (evaluationFinalArtifacts(outputDirectory).length === 0 && evaluationStagingEntries(outputDirectory).length === 0) {
          const marker = qualityRecord(JSON.parse(fs.readFileSync(path.join(outputDirectory, EVALUATION_STARTED_FILE), 'utf8'))) || {};
          const report: JsonRecord = {
            schema: 'urn:reqproof:agent-governance:exp-0209-evaluation:v1', status: 'error', mode: 'evaluate-only', output_directory: outputDirectory,
            controller_pid: process.pid, session_id: marker.session_id, graph_semantic_digest: marker.graph_semantic_digest,
            score: 0, total: ONBOARDING_QUALITY_CRITERIA.length, gate_passed: false, criteria: [],
            error: message.replace(args.evaluatorDirectory, '<evaluator>').replace(args.subjectDirectory, '<subject>'),
            hashes: { baseline_checkpoint_sha256: marker.baseline_checkpoint_sha256, continued_checkpoint_sha256: marker.continued_checkpoint_sha256, effective_config_sha256: marker.effective_config_sha256, manual_baseline_sha256: marker.manual_baseline_sha256 },
          };
          const completed: JsonRecord = { schema: 'urn:reqproof:agent-governance:exp-0209-evaluation-completed:v1', status: 'error', session_id: marker.session_id, graph_semantic_digest: marker.graph_semantic_digest, score: 0, total: ONBOARDING_QUALITY_CRITERIA.length, gate_passed: false, controller_pid: process.pid };
          writeEvaluationArtifacts(outputDirectory, report, completed, fs.readFileSync(PROFILE_PATH, 'utf8'));
        }
      } catch { /* Preserve the original operational diagnostic. */ }
      process.stderr.write(`EXP-0209 evaluation error: ${message}\n`);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let outputDirectory: string | undefined = outputHint(argv);
  const outputState: OutputState = { directory: outputDirectory || '', owned: false };
  try {
    const args = parseArgs(argv);
    outputDirectory = args.outputDirectory;
    outputState.directory = args.outputDirectory;
    if (args.mode === 'baseline-child') {
      await runBaselineChild(args.outputDirectory, args.controllerPid as number);
      return;
    }
    if (args.mode === 'baseline-only') {
      runBaselineOnly(args, outputState);
      return;
    }
    if (args.mode === 'resume-child') {
      await runResumeChild(args.outputDirectory, args.controllerPid as number);
      return;
    }
    if (args.mode === 'resume-only') {
      runResumeOnly(args);
      return;
    }
    if (args.mode === 'evaluate-only') {
      const passed = runEvaluateOnly(args);
      if (!passed) process.exitCode = 2;
      return;
    }
    const report = preflight(args.outputDirectory, args.subjectDirectory, args.evaluatorDirectory, outputState);
    writeJson(path.join(args.outputDirectory, PRECHECK_ARTIFACT), report);
    process.stdout.write(`EXP-0209 preflight passed: ${args.outputDirectory}\n`);
  } catch (error) {
    const failure = {
      schema: 'urn:reqproof:agent-governance:exp-0209-preflight:v1',
      status: 'failed',
      mode: argv.includes(RESUME_CHILD_FLAG) ? 'resume-child' : argv.includes('--evaluate-only') ? 'evaluate-only' : argv.includes('--resume-only') ? 'resume-only' : argv.includes(BASELINE_CHILD_FLAG) ? 'baseline-child' : argv.includes('--baseline-only') ? 'baseline-only' : 'preflight-only',
      governed_calls: 0,
      model_calls: 0,
      network_dispatches_requested: 0,
      offline_go: true,
      error: error instanceof Error ? error.message : String(error),
    };
    if (outputState.owned && outputDirectory && !fs.existsSync(path.join(outputDirectory, PRECHECK_ARTIFACT))) {
      try {
        writeJson(path.join(outputDirectory, 'preflight.json'), failure);
      } catch {
        // Preserve the original failure on stderr if the requested output is
        // not writable; no fallback output is silently selected.
      }
    }
    const mode = argv.includes(RESUME_CHILD_FLAG) ? 'resume child' : argv.includes('--evaluate-only') ? 'evaluate-only' : argv.includes('--resume-only') ? 'resume-only' : argv.includes(BASELINE_CHILD_FLAG) ? 'baseline child' : argv.includes('--baseline-only') ? 'baseline-only' : 'preflight';
    process.stderr.write(`EXP-0209 ${mode} failed: ${failure.error}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    process.exitCode = 1;
    // The mode-specific child path has already retained a structured failure
    // artifact; this line is the stable CLI diagnostic for operators.
    process.stderr.write(`EXP-0209 live demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}
