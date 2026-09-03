/*
 * EXP-0209 live-demo preflight.
 *
 * This file deliberately contains no live runner.  The preflight is useful on
 * its own: it proves the subject/evaluator boundary, the pinned local tool
 * chain, the Proof oracle, and the graph contract before a future live mode is
 * allowed to dispatch any governed/model work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';

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
const INVENTORY_VERSION = 'proof.structural-inventory/v1';
const INVENTORY_AUTHORITY_VERSION = 'proof.project-authority/v1';
const INVENTORY_INPUT_OWNER = 'onboarding_structural_inventory';
const LIVE_SCRIPT = 'examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts';
const LIVE_FILES = new Set([
  LIVE_SCRIPT,
  'examples/agent-governance/exp-0209-discovery-egress/README.md',
]);
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

function parseArgs(argv: readonly string[]): {
  outputDirectory: string;
  subjectDirectory: string;
  evaluatorDirectory: string;
} {
  let preflightOnly = false;
  let outputValue: string | undefined;
  let subjectValue: string | undefined;
  let evaluatorValue: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--preflight-only') {
      preflightOnly = true;
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
    throw new Error(`unsupported option ${flag}; live mode is not implemented`);
  }
  assertInvariant('--preflight-only is required', preflightOnly);
  const defaultSubject = '/Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/subject';
  const defaultEvaluator = '/Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/evaluator';
  return {
    outputDirectory: path.resolve(outputValue || path.join(os.tmpdir(), `visor-exp-0209-preflight-${process.pid}`)),
    subjectDirectory: path.resolve(subjectValue || defaultSubject),
    evaluatorDirectory: path.resolve(evaluatorValue || defaultEvaluator),
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
  assertInvariant('untracked files are limited to run-live-demo.ts', untracked.every(name => name === LIVE_SCRIPT));
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
    future_live_mode: 'not implemented',
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function main(): void {
  const argv = process.argv.slice(2);
  let outputDirectory: string | undefined = outputHint(argv);
  const outputState: OutputState = { directory: outputDirectory || '', owned: false };
  try {
    const args = parseArgs(argv);
    outputDirectory = args.outputDirectory;
    outputState.directory = args.outputDirectory;
    const report = preflight(args.outputDirectory, args.subjectDirectory, args.evaluatorDirectory, outputState);
    writeJson(path.join(args.outputDirectory, 'preflight.json'), report);
    process.stdout.write(`EXP-0209 preflight passed: ${args.outputDirectory}\n`);
  } catch (error) {
    const failure = {
      schema: 'urn:reqproof:agent-governance:exp-0209-preflight:v1',
      status: 'failed',
      mode: 'preflight-only',
      governed_calls: 0,
      model_calls: 0,
      network_dispatches_requested: 0,
      offline_go: true,
      error: error instanceof Error ? error.message : String(error),
    };
    if (outputState.owned && outputDirectory) {
      try {
        writeJson(path.join(outputDirectory, 'preflight.json'), failure);
      } catch {
        // Preserve the original failure on stderr if the requested output is
        // not writable; no fallback output is silently selected.
      }
    }
    process.stderr.write(`EXP-0209 preflight failed: ${failure.error}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
