/**
 * One-component author diagnostic.
 *
 * This is deliberately not a graph runner or checkpoint resumer.  It reads
 * one already-produced component WorkItem pair, checks the current claim
 * authority, creates one fresh checkout, resolves the built-in onboard role,
 * and makes one author-provider call.  Promotion, review, validation, and
 * admission are intentionally outside this diagnostic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import { ExecutionJournal, canonicalGraphCheckpointJson } from '../../../src/snapshot-store';
import { compileClaimPlan, type ClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import type { CheckProviderConfig, ExecutionContext } from '../../../src/providers/check-provider.interface';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { ReviewSummary } from '../../../src/reviewer';
import { loadOnboardingConfig } from './run-onboarding';

type JsonRecord = Record<string, unknown>;
type ClaimEvent = JsonRecord & { payload?: unknown; scope?: unknown; claim?: unknown };

const CLAIM_WORK_ITEM = 'component.work_item@1';
const CLAIM_PREPARED_WORK_ITEM = 'component.prepared_work_item@1';
const RESULT_FILE = 'component-author-diagnostic.json';

const PR_INFO: PRInfo = {
  number: 0,
  title: 'native Proof component author diagnostic',
  body: '',
  author: 'native-onboarding-diagnostic',
  base: 'main',
  head: 'diagnostic',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
};

export interface ComponentDiagnosticOptions {
  checkpoint: string;
  component: string;
  subjectRoot: string;
  originalRoot: string;
  output: string;
  proofBin: string;
}

export interface ComponentDiagnosticResult extends JsonRecord {
  version: 1;
  kind: 'native-component-author-diagnostic';
  status: 'author_completed' | 'author_failed';
  attempt_count: 1;
  component_id: string;
  baseline_commit?: string;
  promotion: 'not_run';
  review: 'not_run';
  admission: 'not_run';
}

interface PreparedClaims {
  controller: ClaimEvent;
  prepared: ClaimEvent;
  controllerPayload: JsonRecord;
  preparedPayload: JsonRecord;
  graphSemanticDigest: string;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function scalarString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function safeComponent(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('component must be a bounded identifier');
  }
  return value;
}

function safePath(value: unknown, label: string): string {
  const candidate = scalarString(value, label);
  if (
    path.isAbsolute(candidate) ||
    candidate.includes('\0') ||
    candidate.includes('\\') ||
    candidate.split('/').some(part => part === '..' || part === '')
  ) {
    throw new Error(`${label} must be a project-relative path`);
  }
  return candidate;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalGraphCheckpointJson(left) === canonicalGraphCheckpointJson(right);
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`));
}

function gitScalar(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitRoot(candidate: string, label: string): string {
  const root = fs.realpathSync(gitScalar(candidate, ['rev-parse', '--show-toplevel']));
  if (root !== candidate) throw new Error(`${label} must be the checkout git root`);
  return root;
}

function assertCleanAtCommit(root: string, commit: string, label: string): void {
  if (gitScalar(root, ['rev-parse', 'HEAD']) !== commit) {
    throw new Error(`${label} HEAD does not match the prepared baseline`);
  }
  if (gitScalar(root, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new Error(`${label} must have a clean Git tree`);
  }
  try {
    execFileSync('git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    throw new Error(`${label} baseline commit is not present`);
  }
}

function validateExecutable(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('--proof-bin must be an absolute executable path');
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('--proof-bin is not executable');
  return resolved;
}

function prepareOutputRoot(value: string, subject: string, original: string): string {
  if (!path.isAbsolute(value)) throw new Error('--output must be an absolute path');
  const requested = path.resolve(value);
  if (fs.existsSync(requested)) throw new Error('--output must not already exist');
  const parent = fs.realpathSync(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  if (inside(output, subject) || inside(subject, output) || inside(output, original) || inside(original, output)) {
    throw new Error('--output must be disjoint from the subject and protected original roots');
  }
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  return fs.realpathSync(output);
}

function loadCheckpoint(checkpointPath: string): { checkpoint: JsonRecord; events: ClaimEvent[] } {
  const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as unknown;
  const checkpoint = ExecutionJournal.validateGraphCheckpointIntegrity(parsed) as unknown as JsonRecord;
  const events = checkpoint.events;
  if (!Array.isArray(events)) throw new Error('checkpoint has no event stream');
  return { checkpoint, events: events as ClaimEvent[] };
}

function validateClaim(plan: ClaimPlan, claim: string, payload: unknown): unknown {
  const validator = plan.validatorsByClaim[claim];
  if (!validator) throw new Error(`shipped claim plan has no validator for ${claim}`);
  validator(payload);
  return payload;
}

function validateWorkItem(plan: ClaimPlan, claim: string, payload: unknown): JsonRecord {
  return asRecord(validateClaim(plan, claim, payload), claim);
}

function extractPreparedClaims(
  checkpoint: JsonRecord,
  events: ClaimEvent[],
  plan: ClaimPlan,
  component: string
): PreparedClaims {
  const controllers = events.filter(
    event =>
      event.type === 'ControllerItemClaimPublished' &&
      event.claim === CLAIM_WORK_ITEM &&
      event.itemKey === component &&
      asRecord(event.payload, 'controller payload').component_id === component
  );
  const prepared = events.filter(
    event =>
      event.type === 'ClaimPublished' &&
      event.claim === CLAIM_PREPARED_WORK_ITEM &&
      event.checkId === 'prepare-work-item' &&
      event.producerCheckId === 'prepare-work-item' &&
      asRecord(event.payload, 'prepared payload').component_id === component
  );
  if (controllers.length !== 1 || prepared.length !== 1) {
    throw new Error('checkpoint must contain exactly one matching WorkItem pair');
  }
  const controller = controllers[0];
  const preparedClaim = prepared[0];
  if (
    typeof controller.claimId !== 'string' ||
    typeof controller.payloadFingerprint !== 'string' ||
    typeof controller.catalogClaimId !== 'string' ||
    typeof controller.itemKey !== 'string' ||
    !Number.isSafeInteger(controller.incarnation) ||
    typeof preparedClaim.claimId !== 'string' ||
    typeof preparedClaim.payloadFingerprint !== 'string'
  ) {
    throw new Error('WorkItem claims have incomplete native provenance');
  }
  if (
    !Array.isArray(preparedClaim.parentClaimIds) ||
    preparedClaim.parentClaimIds.length !== 1 ||
    preparedClaim.parentClaimIds[0] !== controller.claimId
  ) {
    throw new Error('prepared WorkItem parent claim is not the matching controller claim');
  }
  if (!sameJson(controller.scope, preparedClaim.scope)) {
    throw new Error('prepared WorkItem scope differs from the controller claim');
  }
  const controllerPayload = validateWorkItem(plan, CLAIM_WORK_ITEM, controller.payload);
  const preparedPayload = validateWorkItem(plan, CLAIM_PREPARED_WORK_ITEM, preparedClaim.payload);
  const preparedWithoutBaseline = { ...preparedPayload };
  delete preparedWithoutBaseline.baseline_commit;
  if (!sameJson(preparedWithoutBaseline, controllerPayload)) {
    throw new Error('prepared WorkItem changes the controller-owned scope');
  }
  const baseline = scalarString(preparedPayload.baseline_commit, 'baseline_commit');
  if (!/^[0-9a-f]{40,64}$/.test(baseline)) throw new Error('baseline_commit is not a Git object ID');
  const owned = preparedPayload.sorted_owned_paths;
  if (!Array.isArray(owned) || owned.length === 0) throw new Error('WorkItem has no owned paths');
  const checked = owned.map((entry, index) => safePath(entry, `sorted_owned_paths[${index}]`));
  if (new Set(checked).size !== checked.length || checked.join('\0') !== [...checked].sort().join('\0')) {
    throw new Error('WorkItem paths must be unique and sorted');
  }
  if (preparedPayload.component_id !== component) throw new Error('prepared WorkItem component mismatch');
  const subject = preparedPayload.proof_component_subject;
  if (subject !== undefined) {
    const subjectRecord = asRecord(subject, 'proof_component_subject');
    if (subjectRecord.component_id !== component) throw new Error('Proof component subject mismatch');
    const subjectPaths = subjectRecord.sorted_owned_paths;
    if (!sameJson(subjectPaths, checked)) throw new Error('Proof component subject scope mismatch');
  }
  const graphDigest = scalarString(checkpoint.graphSemanticDigest, 'checkpoint graphSemanticDigest');
  return { controller, prepared: preparedClaim, controllerPayload, preparedPayload, graphSemanticDigest: graphDigest };
}

function wrapper(output: unknown): ReviewSummary {
  return { issues: [], output };
}

function summary(value: ReviewSummary): JsonRecord {
  const content = typeof value.content === 'string' ? value.content : '';
  let outputDigest: string | undefined;
  let outputKeys: string[] | undefined;
  if (value.output !== undefined) {
    try {
      outputDigest = createHash('sha256').update(JSON.stringify(value.output), 'utf8').digest('hex');
    } catch {
      outputDigest = undefined;
    }
    if (value.output && typeof value.output === 'object' && !Array.isArray(value.output)) {
      outputKeys = Object.keys(value.output as Record<string, unknown>)
        .filter(key => /^[A-Za-z0-9_.-]{1,80}$/.test(key))
        .sort();
    }
  }
  return {
    issue_count: Array.isArray(value.issues) ? value.issues.length : 0,
    output_kind: value.output === null ? 'null' : Array.isArray(value.output) ? 'array' : typeof value.output,
    content_length: content.length,
    ...(outputDigest ? { output_sha256: outputDigest } : {}),
    ...(outputKeys ? { output_keys: outputKeys } : {}),
  };
}

function authorFinalText(value: ReviewSummary): string {
  const output = value.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('author output is not a plain result object');
  }
  const result = output as JsonRecord;
  if (
    typeof result.text !== 'string' ||
    result.text.length === 0 ||
    typeof result.content !== 'string' ||
    result.content.length === 0 ||
    result.text !== result.content
  ) {
    throw new Error('author output text/content are not identical nonempty strings');
  }
  return result.text;
}

function safeFailure(stage: string): JsonRecord {
  return { stage, reason: `${stage}_provider_failed` };
}

function writeResult(outputRoot: string, result: ComponentDiagnosticResult): void {
  const target = path.join(outputRoot, RESULT_FILE);
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function relativeOutputPath(outputRoot: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const relative = path.relative(outputRoot, filePath);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === '..') {
    return undefined;
  }
  return relative;
}

function providerContext(workingDirectory: string, workspaceEnabled: boolean): ExecutionContext {
  return {
    _parentContext: {
      workingDirectory,
      workspace: { isEnabled: () => workspaceEnabled },
    },
  } as ExecutionContext;
}

function parseShippedChecks(config: JsonRecord): {
  checkoutTarget: CheckProviderConfig;
  checkoutWorktree: CheckProviderConfig;
  role: CheckProviderConfig;
  author: CheckProviderConfig;
} {
  const subgraph = asRecord(asRecord(config.subgraphs, 'subgraphs')['onboard-component'], 'onboard-component subgraph');
  const checks = asRecord(subgraph.checks, 'onboard-component checks');
  const get = (name: string): CheckProviderConfig => asRecord(checks[name], name) as CheckProviderConfig;
  const result = {
    checkoutTarget: get('checkout-target'),
    checkoutWorktree: get('checkout-worktree'),
    role: get('role-onboard-component'),
    author: get('author-native-component'),
  };
  const authorAi = asRecord(result.author.ai, 'author ai');
  if (
    authorAi.codex_execution_profile !== 'luna-xhigh-isolated-writer-v1' ||
    authorAi.codex_working_directory_from !== 'checkout-worktree' ||
    authorAi.allowEdit !== true ||
    !sameJson(authorAi.allowedTools, ['search', 'extract', 'listFiles'])
  ) {
    throw new Error('shipped author-native-component is not the isolated writer configuration');
  }
  return result;
}

export async function runComponentDiagnostic(options: ComponentDiagnosticOptions): Promise<ComponentDiagnosticResult> {
  const started = Date.now();
  const component = safeComponent(options.component);
  const checkpointPath = fs.realpathSync(options.checkpoint);
  const proofBin = validateExecutable(options.proofBin);
  const subject = gitRoot(fs.realpathSync(options.subjectRoot), 'subject root');
  const original = gitRoot(fs.realpathSync(options.originalRoot), 'original root');
  if (subject === original || inside(subject, original) || inside(original, subject)) {
    throw new Error('subject and protected original roots must be disjoint');
  }
  const { checkpoint, events } = loadCheckpoint(checkpointPath);
  const outputRoot = prepareOutputRoot(options.output, subject, original);
  const aiArtifacts = path.join(outputRoot, 'ai');
  fs.mkdirSync(aiArtifacts, { recursive: false, mode: 0o700 });
  const worktreeParent = path.join(outputRoot, 'worktrees');
  fs.mkdirSync(worktreeParent, { mode: 0o700 });
  const previousCwd = process.cwd();
  const previousEnv: Record<string, string | undefined> = {};
  const scopedEnv: Record<string, string> = {
    PROOF_BIN: proofBin,
    VISOR_WORKSPACE_MAIN_PROJECT: subject,
    NATIVE_ONBOARDING_OUTPUT_DIR: outputRoot,
    NATIVE_ONBOARDING_WORKTREE_ROOT: worktreeParent,
    VISOR_DEBUG_ARTIFACTS: aiArtifacts,
  };
  for (const key of Object.keys(scopedEnv)) previousEnv[key] = process.env[key];
  process.chdir(subject);
  Object.assign(process.env, scopedEnv);

  let stage = 'config';
  let baseline: string | undefined;
  let claims: PreparedClaims | undefined;
  let checkoutPath: string | undefined;
  const diagnosticNodeGenerationId = `diagnostic-${randomUUID()}`;
  try {
    // This helper performs the same existing in-memory invocation binding and
    // read-only Proof inventory/role-resolution preflight as the main runner,
    // then invokes strict ConfigManager validation. It does not dispatch an AI
    // discovery step or mutate the checkpoint.
    const config = (await loadOnboardingConfig(proofBin, subject, outputRoot, 900000)) as unknown as JsonRecord;
    const plan = compileClaimPlan(config as any);
    claims = extractPreparedClaims(checkpoint, events, plan, component);
    baseline = scalarString(claims.preparedPayload.baseline_commit, 'baseline_commit');
    assertCleanAtCommit(subject, baseline, 'subject root');
    const registry = CheckProviderRegistry.getInstance();
    const checkoutProvider = registry.getProviderOrThrow('git-checkout');
    const commandProvider = registry.getProviderOrThrow('command');
    const aiProvider = registry.getProviderOrThrow('ai');
    const checks = parseShippedChecks(config);

    stage = 'checkout-target';
    const targetConfig = {
      ...checks.checkoutTarget,
      checkName: 'component-diagnostic-checkout-target',
      env: { ...((checks.checkoutTarget as any).env || {}), NATIVE_ONBOARDING_WORKTREE_ROOT: worktreeParent },
    } as CheckProviderConfig;
    const target = await commandProvider.execute(
      PR_INFO,
      targetConfig,
      new Map([['work_item', wrapper(claims.preparedPayload)]]),
      providerContext(subject, false)
    );
    if ((target.issues || []).length > 0 || !target.output) throw new Error('checkout-target provider returned failure');
    const targetOutput = asRecord(target.output, 'checkout target output');
    validateClaim(plan, 'component.checkout_target@1', targetOutput);
    if (targetOutput.component_id !== component || targetOutput.baseline_commit !== baseline) {
      throw new Error('checkout-target changed the prepared WorkItem identity');
    }
    const targetPath = scalarString(targetOutput.worktree_root, 'checkout target worktree_root');
    if (!path.isAbsolute(targetPath) || !inside(path.resolve(targetPath), path.resolve(worktreeParent)) || fs.existsSync(targetPath)) {
      throw new Error('checkout target is not a fresh output-local worktree path');
    }

    stage = 'checkout-worktree';
    const checkoutConfig = {
      ...checks.checkoutWorktree,
      checkName: 'component-diagnostic-checkout-worktree',
    } as CheckProviderConfig;
    const checkout = await checkoutProvider.execute(
      PR_INFO,
      checkoutConfig,
      new Map([['target', wrapper(targetOutput)]]),
      { ...providerContext(subject, false), sessionId: `component-diagnostic-${randomUUID()}` } as any
    );
    if ((checkout.issues || []).length > 0 || !checkout.output) throw new Error('checkout-worktree provider returned failure');
    const checkoutOutput = asRecord(checkout.output, 'checkout output');
    validateClaim(plan, 'component.checkout@1', checkoutOutput);
    if (
      checkoutOutput.success !== true ||
      checkoutOutput.is_worktree !== true ||
      checkoutOutput.commit !== baseline ||
      typeof checkoutOutput.path !== 'string' ||
      !path.isAbsolute(checkoutOutput.path)
    ) {
      throw new Error('checkout output failed the component checkout contract');
    }
    checkoutPath = fs.realpathSync(checkoutOutput.path);
    if (!inside(checkoutPath, path.resolve(worktreeParent)) || checkoutPath === subject) {
      throw new Error('checkout output escaped the diagnostic worktree root');
    }

    stage = 'role-onboard-component';
    const roleConfig = {
      ...checks.role,
      checkName: 'component-diagnostic-role-onboard',
      env: { ...((checks.role as any).env || {}), PROOF_BIN: proofBin },
    } as CheckProviderConfig;
    const role = await commandProvider.execute(
      PR_INFO,
      roleConfig,
      new Map([['component', wrapper(claims.controllerPayload)]]),
      providerContext(subject, false)
    );
    if ((role.issues || []).length > 0 || typeof role.output !== 'string' || role.output.length === 0) {
      throw new Error('built-in onboard role provider returned failure');
    }
    validateClaim(plan, 'native.role.onboard@1', role.output);

    stage = 'author-native-component';
    const authorConfig = {
      ...checks.author,
      checkName: `component-diagnostic-author-${component}`,
      env: {
        ...((checks.author as any).env || {}),
        PROOF_BIN: proofBin,
        NATIVE_ONBOARDING_OUTPUT_DIR: outputRoot,
      },
    } as CheckProviderConfig;
    const authorDeps = new Map<string, ReviewSummary>([
      ['work_item', wrapper(claims.preparedPayload)],
      ['checkout', wrapper(checkoutOutput)],
      ['role', wrapper(role.output)],
      ['checkout-worktree', wrapper(checkoutOutput)],
    ]);
    const author = await aiProvider.execute(
      PR_INFO,
      authorConfig,
      authorDeps,
      {
        ...providerContext(subject, false),
        reuseSession: false,
        nodeGenerationId: diagnosticNodeGenerationId,
      }
    );
    if ((author.issues || []).length > 0) throw new Error('author returned review issues');
    const finalText = authorFinalText(author);
    const finalPath = path.join(outputRoot, 'author-final.txt');
    fs.writeFileSync(finalPath, finalText, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(finalPath, 0o600);
    const finalBytes = Buffer.byteLength(finalText, 'utf8');
    const finalDigest = createHash('sha256').update(finalText, 'utf8').digest('hex');
    const result: ComponentDiagnosticResult = {
      version: 1,
      kind: 'native-component-author-diagnostic',
      status: (author.issues || []).length === 0 ? 'author_completed' : 'author_failed',
      attempt_count: 1,
      component_id: component,
      baseline_commit: baseline,
      config_authority: 'fresh-native-proof-role-binding',
      provider_node_generation_id: diagnosticNodeGenerationId,
      provenance: 'standalone-diagnostic-not-graph-journal',
      checkpoint: {
        graph_semantic_digest: claims.graphSemanticDigest,
        controller_claim_id: claims.controller.claimId,
        prepared_claim_id: claims.prepared.claimId,
        controller_fingerprint: claims.controller.payloadFingerprint,
        prepared_fingerprint: claims.prepared.payloadFingerprint,
        scope: claims.controller.scope,
      },
      checkout: {
        success: true,
        is_worktree: true,
        commit: baseline,
        path: relativeOutputPath(outputRoot, checkoutPath),
        worktree_id: checkoutOutput.worktree_id,
      },
      role: { resolved: true, output_length: (role.output as string).length },
      author: summary(author),
      author_final: { path: 'author-final.txt', bytes: finalBytes, sha256: finalDigest },
      promotion: 'not_run',
      review: 'not_run',
      admission: 'not_run',
      timing: { started_at: new Date(started).toISOString(), duration_ms: Date.now() - started },
    };
    writeResult(outputRoot, result);
    return result;
  } catch (_error) {
    const result: ComponentDiagnosticResult = {
      version: 1,
      kind: 'native-component-author-diagnostic',
      status: 'author_failed',
      attempt_count: 1,
      component_id: component,
      baseline_commit: baseline,
      config_authority: 'fresh-native-proof-role-binding-or-preflight-failed',
      provider_node_generation_id: diagnosticNodeGenerationId,
      provenance: 'standalone-diagnostic-not-graph-journal',
      ...(claims
        ? {
            checkpoint: {
              graph_semantic_digest: claims.graphSemanticDigest,
              controller_claim_id: claims.controller.claimId,
              prepared_claim_id: claims.prepared.claimId,
              controller_fingerprint: claims.controller.payloadFingerprint,
              prepared_fingerprint: claims.prepared.payloadFingerprint,
              scope: claims.controller.scope,
            },
          }
        : {}),
      failure: safeFailure(stage),
      checkout: checkoutPath
        ? { success: true, path: relativeOutputPath(outputRoot, checkoutPath) }
        : { success: false },
      promotion: 'not_run',
      review: 'not_run',
      admission: 'not_run',
      timing: { started_at: new Date(started).toISOString(), duration_ms: Date.now() - started },
    };
    writeResult(outputRoot, result);
    return result;
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function parseArgs(argv: string[]): ComponentDiagnosticOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    values[key.slice(2)] = value;
  }
  const required = (key: string): string => scalarString(values[key], `--${key}`);
  return {
    checkpoint: required('checkpoint'),
    component: required('component'),
    subjectRoot: required('subject-root'),
    originalRoot: required('original-root'),
    output: required('output'),
    proofBin: required('proof-bin'),
  };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    runComponentDiagnostic(options)
      .then(result => {
        process.stdout.write(`${JSON.stringify({ status: result.status, component_id: result.component_id, result: RESULT_FILE })}\n`);
        if (result.status !== 'author_completed') process.exitCode = 1;
      })
      .catch(() => {
        process.stderr.write('component author diagnostic failed before provider execution\n');
        process.exitCode = 1;
      });
  } catch {
    process.stderr.write('component author diagnostic arguments are invalid\n');
    process.exitCode = 1;
  }
}
