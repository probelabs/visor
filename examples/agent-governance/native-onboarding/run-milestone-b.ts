/**
 * Small Milestone B harness. `prepare` is zero-model and reads the current
 * Proof catalog. `pause` and `resume` use the existing Graph-v2 SDK journal;
 * review-record modes reuse that same journal and add only the native Proof
 * review-record persistence boundary.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig, StateMachineExecutionEngine } from '../../../src/sdk';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import { ExecutionJournal } from '../../../src/snapshot-store';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import { canonicalJson } from '../../../src/state-machine/graph/claim-kernel';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { GeneratedDispatchGate } from '../../../src/types/engine';
import { assertCodexHomeAbsent, pinNativeOnboardingTsProject, verifyCodexBinarySha256 } from './run-onboarding';

type Json = Record<string, unknown>;
type ProofRow = { id: string; component: string; file_path: string } & Json;
type CommandResult = { status: number; stdout: string; stderr: string };
type GovernedCodexExecution = {
  governedCodexTransport: 'exec-jsonl-default-auth-v1';
  codexBin: string;
  codexSha256: string;
};
type ReviewTuple = {
  kind: 'spec_conformance';
  subject: string;
  reviewer: string;
  decision: 'approved' | 'rejected' | 'needs_changes';
  comment: string;
  citations: string[];
};
type ReviewItem = Json & {
  id: string;
  packet: Json;
  current_context: Json;
  parent_bindings: Json[];
  lineage: Json;
  spec_review_role: string;
  reviewer: string;
};

const FOCUS_IDS_ENV = 'VISOR_NATIVE_B_FOCUS_IDS';
const REVIEWER_ENV = 'VISOR_NATIVE_B_REVIEWER';
const REVIEW_ITEMS_ENV = 'VISOR_NATIVE_B_REVIEW_ITEMS_FILE';
const REVIEW_OUTPUT_ENV = 'VISOR_NATIVE_B_REVIEW_OUTPUT';
const REVIEW_READER_OUTPUT_ENV = 'VISOR_NATIVE_B_READER_OUTPUT';
const CONTROLLER_REVIEWER = 'agent:luna-xhigh-native-spec-review';
const REVIEW_CONFIG_PATH = path.resolve(__dirname, 'visor-milestone-b-review-record.yaml');

const CONFIG_PATH = path.resolve(__dirname, 'visor-milestone-b.yaml');

const prInfo: PRInfo = {
  number: 0,
  title: 'native Proof Milestone B review slice',
  body: '',
  author: 'native-onboarding-runner',
  base: 'main',
  head: 'subject',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
};

function parseArgs(argv: string[]): { mode: string; values: Record<string, string> } {
  const mode = argv[0] || 'prepare';
  const values: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    values[key.slice(2)] = value;
    i += 1;
  }
  return { mode, values };
}

function isReviewLifecycleMode(mode: string): boolean {
  return new Set(['record-prepare', 'record-pause', 'record-resume', 'record-recover']).has(mode);
}

/**
 * Focus IDs are a transport-level selection, not a second catalog.  Keep the
 * input closed and deterministic so a generated scope can never be ambiguous.
 */
function parseFocusIds(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(',').map(item => item.trim());
  if (!ids.length || ids.some(id => !id || /\s/.test(id))) {
    throw new Error('--focus-ids must contain comma-separated non-empty requirement IDs');
  }
  const sorted = [...ids].sort();
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== sorted[index])) {
    throw new Error('--focus-ids must be sorted and unique');
  }
  return ids;
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function realDirectory(value: string, label: string): string {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertRoots(subjectArg: string, originalArg: string, outputArg: string): {
  subject: string;
  original: string;
  output: string;
} {
  const subject = realDirectory(subjectArg, 'subject root');
  const original = realDirectory(originalArg, 'original root');
  const gitRoot = (root: string): string => String(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).trim();
  const subjectGitRoot = realDirectory(gitRoot(subject), 'subject git root');
  const originalGitRoot = realDirectory(gitRoot(original), 'original git root');
  if (subject !== subjectGitRoot || original !== originalGitRoot) {
    throw new Error('subject-root and original-root must each be their checkout git root');
  }
  const outputPath = path.resolve(outputArg);
  const outputParent = fs.realpathSync(path.dirname(outputPath));
  const output = fs.existsSync(outputPath)
    ? fs.realpathSync(outputPath)
    : path.join(outputParent, path.basename(outputPath));
  if (subject === original || subjectGitRoot === originalGitRoot) throw new Error('subject root must differ from protected original root');
  if (inside(subject, original) || inside(original, subject) || inside(subjectGitRoot, originalGitRoot) || inside(originalGitRoot, subjectGitRoot)) {
    throw new Error('subject and protected original checkouts must be disjoint');
  }
  if (inside(output, subject) || inside(output, original)) {
    throw new Error('output must be outside both subject and protected original roots');
  }
  if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });
  return { subject, original, output };
}

function executable(value: string, option: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${option} must be an absolute path`);
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error(`${option} is not executable`);
  return resolved;
}

function proofExecutable(value: string): string {
  return executable(value, '--proof-bin');
}

function resolveGovernedCodexExecution(
  values: Record<string, string>,
  subject: string,
  original: string,
  output: string,
  zeroModel: boolean,
): GovernedCodexExecution | undefined {
  const transport = values['governed-codex-transport'];
  const codexBinArg = values['codex-bin'];
  const codexSha256Arg = values['codex-sha256'];
  const anyPin = transport !== undefined || codexBinArg !== undefined || codexSha256Arg !== undefined;
  if (!anyPin && zeroModel) return undefined;
  if (transport !== 'exec-jsonl-default-auth-v1') {
    throw new Error('--governed-codex-transport must be exec-jsonl-default-auth-v1');
  }
  if (!codexBinArg || !codexSha256Arg) {
    throw new Error('--codex-bin and --codex-sha256 are required for exec-jsonl-default-auth-v1');
  }
  const codexBin = executable(codexBinArg, '--codex-bin');
  const codexSha256 = verifyCodexBinarySha256(codexBin, codexSha256Arg);
  assertCodexHomeAbsent(subject, original, output);
  return { governedCodexTransport: transport, codexBin, codexSha256 };
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commandName(args: string[]): string {
  return args.join('-').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
}

function runProof(
  proof: string,
  subject: string,
  output: string,
  phase: string,
  args: string[],
): CommandResult {
  const startedAt = new Date().toISOString();
  const result = spawnSync(proof, args, {
    cwd: subject,
    encoding: 'utf8',
    env: { ...process.env, PROOF_BIN: proof },
  });
  const status = typeof result.status === 'number' ? result.status : 1;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || result.error?.message || '');
  const base = path.join(output, 'commands', phase, commandName(args));
  writeText(`${base}.stdout`, stdout);
  writeText(`${base}.stderr`, stderr);
  writeJson(`${base}.meta.json`, {
    pid: process.pid,
    cwd: subject,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    args,
    status,
  });
  return { status, stdout, stderr };
}

function parseJson(result: CommandResult, description: string): Json | ProofRow[] {
  if (result.status !== 0) throw new Error(`${description} failed with exit ${result.status}`);
  try {
    return JSON.parse(result.stdout) as Json | ProofRow[];
  } catch (error) {
    throw new Error(`${description} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePreparedClaim(
  plan: ReturnType<typeof compileClaimPlan>,
  claim: string,
  payload: unknown,
  counts: Record<string, number>,
): void {
  const validator = plan.validatorsByClaim[claim];
  if (!validator) throw new Error(`prepared config has no validator for ${claim}`);
  try {
    validator(payload);
  } catch (error) {
    throw new Error(`prepared ${claim} failed validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  counts[claim] = (counts[claim] || 0) + 1;
}

function preparedIdentityDigest(identity: Json): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function nativeRows(value: Json | ProofRow[]): ProofRow[] {
  if (!Array.isArray(value)) throw new Error('Proof req list did not return an array');
  if (!value.length) throw new Error('Proof catalog has no native requirements');
  const seenIds = new Set<string>();
  const rows = value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.component !== 'string' || !row.component ||
      typeof row.id !== 'string' || !row.id || typeof row.file_path !== 'string' || !row.file_path) {
      throw new Error(`Proof catalog row ${index} is missing component, id, or file_path`);
    }
    const typed = row as ProofRow;
    if (seenIds.has(typed.id)) throw new Error(`Proof catalog contains duplicate requirement id ${typed.id}`);
    seenIds.add(typed.id);
    return typed;
  });
  return rows.sort((left, right) => left.component.localeCompare(right.component) || left.id.localeCompare(right.id));
}

function resolveFocusRows(rows: ProofRow[], focusIds: readonly string[] | undefined): ProofRow[] {
  if (focusIds === undefined) return rows;
  const byId = new Map<string, ProofRow>();
  for (const row of rows) {
    if (byId.has(row.id)) throw new Error(`Proof catalog contains ambiguous requirement identity ${row.id}`);
    byId.set(row.id, row);
  }
  const selected = focusIds.map(id => {
    const row = byId.get(id);
    if (!row) throw new Error(`--focus-ids requested requirement ${id}, but it is absent from the Proof catalog`);
    return row;
  });
  if (new Set(selected.map(row => row.id)).size !== selected.length) {
    throw new Error('--focus-ids resolved an ambiguous duplicate catalog identity');
  }
  return rows.filter(row => byId.has(row.id) && focusIds.includes(row.id));
}

function proofFileHash(value: Json, id: string): string {
  const hash = (value._computed as Json | undefined)?.file_hash;
  if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`Proof req show ${id} has no computed sha256 file hash`);
  }
  return hash;
}

function objectValue(value: unknown, description: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Json;
}

function normalizedContextPath(value: string, subject: string): string {
  const prefix = subject.endsWith(path.sep) ? subject : `${subject}${path.sep}`;
  if (value === subject) return '<subject-root>';
  if (value.startsWith(prefix)) return `<subject-root>${value.slice(subject.length)}`;
  return value;
}

function isNativeReviewArtifactPath(value: string, subject: string): boolean {
  const normalized = normalizedContextPath(value, subject);
  return normalized === '<subject-root>/proof/reviews' ||
    normalized.startsWith('<subject-root>/proof/reviews/') ||
    normalized === '<subject-root>/.proof/reviews' ||
    normalized.startsWith('<subject-root>/.proof/reviews/');
}

function contextWithoutNativeReviewArtifacts(context: Json, subject: string): Json {
  const sections = new Set(['implementation', 'tests', 'documentation']);
  return Object.fromEntries(Object.entries(context).map(([key, value]) => {
    if (!sections.has(key) || !Array.isArray(value)) return [key, value];
    return [key, value.filter(entry =>
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof (entry as Json).path !== 'string' ||
      !isNativeReviewArtifactPath(String((entry as Json).path), subject)
    )];
  }));
}

function normalizedContextValue(value: unknown, subject: string, key?: string): unknown {
  if (key === 'generated_at') return '<generated-at>';
  if (typeof value === 'string') {
    return normalizedContextPath(value, subject);
  }
  if (Array.isArray(value)) return value.map(item => normalizedContextValue(item, subject));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Json).map(([entryKey, entryValue]) => [
      entryKey,
      normalizedContextValue(entryValue, subject, entryKey),
    ]));
  }
  return value;
}

function normalizedContextBytes(context: Json, subject: string): string {
  return canonicalJson(normalizedContextValue(contextWithoutNativeReviewArtifacts(context, subject), subject));
}

function contextDigest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

/**
 * The prepared review envelope carries both the normalized context object and
 * its canonical bytes for command-boundary diagnostics.  Keep those two
 * representations bound: a caller must not be able to replace the object
 * used for citation grounding while retaining an old digest/byte payload.
 */
function assertReviewItemContextBinding(item: ReviewItem, phase: string): void {
  if (typeof item.current_context_bytes !== 'string' || typeof item.current_context_sha256 !== 'string') {
    throw new Error(`${phase} review item ${item.id} has detached context bytes`);
  }
  const expectedBytes = canonicalJson(item.current_context);
  if (item.current_context_bytes !== expectedBytes || contextDigest(expectedBytes) !== item.current_context_sha256) {
    throw new Error(`${phase} review item ${item.id} has detached normalized Proof context`);
  }
}

type ContextLocation = { path: string; start: number; end: number; symbol?: string };

function contextLocations(context: Json, subject: string): ContextLocation[] {
  const locations: ContextLocation[] = [];
  const filteredContext = contextWithoutNativeReviewArtifacts(context, subject);
  for (const section of ['implementation', 'tests', 'documentation']) {
    const entries = filteredContext[section];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Json;
      if (typeof row.path !== 'string' || !row.path) continue;
      const normalizedPath = String(normalizedContextValue(row.path, subject));
      const functions = Array.isArray(row.functions) ? row.functions : [];
      for (const fn of functions) {
        if (!fn || typeof fn !== 'object' || Array.isArray(fn)) continue;
        const value = fn as Json;
        if (!Number.isSafeInteger(value.line) || (value.line as number) <= 0) continue;
        const code = typeof value.code === 'string' ? value.code : '';
        locations.push({
          path: normalizedPath,
          start: value.line as number,
          end: (value.line as number) + Math.max(0, code.split('\n').length - 1),
          ...(typeof value.name === 'string' && value.name ? { symbol: value.name } : {}),
        });
      }
      if (Number.isSafeInteger(row.line) && (row.line as number) > 0) {
        const code = typeof row.code === 'string' ? row.code : '';
        locations.push({
          path: normalizedPath,
          start: row.line as number,
          end: (row.line as number) + Math.max(0, code.split('\n').length - 1),
        });
      }
    }
  }
  return locations;
}

function citationPathVariants(value: string, subject?: string): string[] {
  const trimmed = value.trim();
  const variants = [trimmed];
  if (trimmed.startsWith('<subject-root>/')) variants.push(trimmed.slice('<subject-root>/'.length));
  else if (!path.isAbsolute(trimmed)) variants.push(`<subject-root>/${trimmed}`);
  if (subject && path.isAbsolute(trimmed)) {
    const prefix = subject.endsWith(path.sep) ? subject : `${subject}${path.sep}`;
    if (trimmed.startsWith(prefix)) variants.push(`<subject-root>${trimmed.slice(subject.length)}`);
  }
  if (path.isAbsolute(trimmed)) variants.push(path.relative(process.cwd(), trimmed));
  return [...new Set(variants)];
}

function validateAdjudication(item: ReviewItem, adjudication: unknown): ReviewTuple {
  const value = objectValue(adjudication, `adjudication for ${item.id}`);
  // A provider may echo reviewer metadata, but that field is untrusted and
  // never participates in the native tuple. The controller item remains the
  // sole authority for the recorded reviewer.
  if (Object.prototype.hasOwnProperty.call(value, 'reviewer')) void value.reviewer;
  const decisions = new Set(['approved', 'rejected', 'needs_changes']);
  if (typeof value.decision !== 'string' || !decisions.has(value.decision)) {
    throw new Error(`adjudication for ${item.id} has an invalid decision`);
  }
  if (typeof value.comment !== 'string' || !value.comment.trim()) {
    throw new Error(`adjudication for ${item.id} requires a substantive comment`);
  }
  if (!Array.isArray(value.citations) || value.citations.length === 0 ||
      value.citations.some(citation => typeof citation !== 'string' || !citation.trim())) {
    throw new Error(`adjudication for ${item.id} requires one or more citations`);
  }
  const context = objectValue(item.current_context, `current Proof context for ${item.id}`);
  const locations = contextLocations(context, process.cwd());
  if (!locations.length) throw new Error(`current Proof context for ${item.id} has no citation locations`);
  const citations = value.citations.map(citation => citation.trim());
  if (new Set(citations).size !== citations.length) throw new Error(`adjudication for ${item.id} has duplicate citations`);
  for (const citation of citations) {
    const match = /^(.*):(\d+)(?:@(.+))?$/.exec(citation);
    if (!match || !match[1] || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) {
      throw new Error(`adjudication for ${item.id} has malformed citation ${citation}`);
    }
    const line = Number(match[2]);
    const symbol = match[3];
    const variants = citationPathVariants(match[1], process.cwd());
    const grounded = locations.some(location =>
      variants.includes(location.path) && line >= location.start && line <= location.end &&
      (!symbol || location.symbol === symbol));
    if (!grounded) throw new Error(`adjudication citation ${citation} is outside the supplied current Proof context for ${item.id}`);
  }
  return {
    kind: 'spec_conformance',
    subject: item.id,
    reviewer: item.reviewer,
    decision: value.decision as ReviewTuple['decision'],
    comment: value.comment.trim(),
    citations,
  };
}

function reviewTuple(value: unknown, description: string): ReviewTuple {
  const row = objectValue(value, description);
  if (typeof row.id !== 'string' || !row.id || row.kind !== 'spec_conformance' || typeof row.subject !== 'string' || !row.subject ||
      typeof row.reviewer !== 'string' || !row.reviewer ||
      !['approved', 'rejected', 'needs_changes'].includes(String(row.decision)) ||
      typeof row.comment !== 'string' || !row.comment.trim() || !Array.isArray(row.citations) ||
      row.citations.some(citation => typeof citation !== 'string' || !citation.trim())) {
    throw new Error(`${description} has an invalid closed review tuple`);
  }
  const citations = row.citations.map(citation => String(citation).trim());
  if (new Set(citations).size !== citations.length) throw new Error(`${description} has duplicate citations`);
  return {
    kind: 'spec_conformance',
    subject: row.subject,
    reviewer: row.reviewer,
    decision: row.decision as ReviewTuple['decision'],
    comment: row.comment.trim(),
    citations,
  };
}

function sameReviewTuple(left: ReviewTuple, right: ReviewTuple): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  });
}

function recordsFromList(value: unknown): Json[] {
  if (Array.isArray(value)) {
    if (value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('Proof review list contains a malformed record');
    }
    return value as Json[];
  }
  const object = objectValue(value, 'Proof review list');
  if (!Array.isArray(object.reviews)) throw new Error('Proof review list did not return an array');
  if (object.reviews.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Proof review list contains a malformed record');
  }
  return object.reviews as Json[];
}

function nestedOutput(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Json;
  if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  for (const nested of Object.values(object)) {
    const found = nestedOutput(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function ensureFreshPrepareOutput(output: string): void {
  if (fs.readdirSync(output).length > 0) {
    throw new Error('prepare requires a new empty run output; existing diagnostics are never overwritten');
  }
}

function verifyCurrentProofInputs(
  proof: string,
  subject: string,
  output: string,
  catalogRows: ProofRow[],
  selectedRows: ProofRow[],
  phase: string,
): Record<string, string> {
  const currentList = runProof(proof, subject, output, `${phase}-catalog`, ['req', 'list', '--format', 'json']);
  const currentRows = nativeRows(parseJson(currentList, 'Proof req list') as ProofRow[]);
  const expectedIds = catalogRows.map(row => row.id).sort();
  const currentIds = currentRows.map(row => row.id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(currentIds)) throw new Error(`Proof requirement ID set changed during ${phase}`);
  const hashes: Record<string, string> = {};
  for (const row of catalogRows) {
    const currentRow = currentRows.find(item => item.id === row.id);
    if (!currentRow || currentRow.component !== row.component || currentRow.file_path !== row.file_path) throw new Error(`Proof requirement component/path changed during ${phase} for ${row.id}`);
  }
  for (const row of selectedRows) {
    const shown = runProof(proof, subject, output, `${phase}-${row.id}`, ['req', 'show', row.id, '--with', 'file', '--format', 'json']);
    const value = parseJson(shown, `Proof req show ${row.id}`) as Json;
    const requirement = value.requirement as Json | undefined;
    if (!requirement || requirement.id !== row.id || requirement.component !== row.component || value.file_path !== row.file_path) throw new Error(`Proof req show ${row.id} does not match the ${phase} catalog row`);
    hashes[row.id] = proofFileHash(requirement, row.id);
  }
  return hashes;
}

function baselineCatalogRows(output: string): ProofRow[] {
  const file = path.join(output, 'prepare', 'catalog.json');
  if (!fs.existsSync(file)) throw new Error(`missing prepare catalog: ${file}`);
  return nativeRows(JSON.parse(fs.readFileSync(file, 'utf8')) as Json | ProofRow[]);
}

function baselineSelectedRows(output: string): ProofRow[] {
  const file = path.join(output, 'prepare', 'summary.json');
  if (!fs.existsSync(file)) throw new Error(`missing prepare summary: ${file}`);
  const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  if (!Array.isArray(summary.items)) throw new Error('prepare summary has no selected native item set');
  return nativeRows(summary.items as ProofRow[]);
}

function readerCheckpointPath(readerOutput: string): string {
  const candidates = [
    path.join(readerOutput, 'resumed', 'checkpoint.json'),
    path.join(readerOutput, 'paused', 'checkpoint.json'),
    path.join(readerOutput, 'checkpoint.json'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`reader output has no checkpoint: ${readerOutput}`);
  return found;
}

type ReaderPacket = {
  row: ProofRow;
  payload: Json;
  claimId: string;
  payloadFingerprint: string;
  candidateClaimId: string;
  candidatePayloadFingerprint: string;
};

async function readReaderPackets(
  subject: string,
  readerOutput: string,
): Promise<{ catalogRows: ProofRow[]; selectedRows: ProofRow[]; checkpoint: any; packets: ReaderPacket[] }> {
  const catalogRows = baselineCatalogRows(readerOutput);
  const selectedRows = baselineSelectedRows(readerOutput);
  const checkpointPath = readerCheckpointPath(readerOutput);
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as any;
  const readerConfig = await loadConfig(CONFIG_PATH, { strict: true });
  if (zeroModelTestEnabled()) {
    const review = (readerConfig as any).subgraphs?.['native-spec-item']?.checks?.['review-native-item'];
    if (!review) throw new Error('reader checkpoint mock configuration has no native review check');
    const mockAi = { ...(review.ai || {}) };
    delete mockAi.codex_execution_profile;
    review.ai = { ...mockAi, provider: 'mock', model: 'mock' };
  }
  const journal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(readerConfig), checkpoint);
  const claims = journal.getClaimProjection().claims as Record<string, any>;
  const instanceClaims = journal.getInstanceProjection().claimsById as Record<string, any>;
  const events = checkpointEvents(checkpoint);
  const packetEvents = events.filter(event =>
    event?.type === 'ClaimPublished' && event?.claim === 'native.review.candidate.packet@1',
  );
  const packets: ReaderPacket[] = [];
  for (const row of selectedRows) {
    const matches = packetEvents.filter(event => event?.payload?.id === row.id);
    if (matches.length !== 1) throw new Error(`reader checkpoint must contain exactly one completed candidate packet for ${row.id}`);
    const event = matches[0];
    if (typeof event.claimId !== 'string' || !/^[0-9a-f]{64}$/.test(event.claimId) ||
        typeof event.payloadFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(event.payloadFingerprint)) {
      throw new Error(`reader candidate packet ${row.id} has incomplete claim identity`);
    }
    const payload = objectValue(event.payload, `reader candidate packet ${row.id}`);
    const catalogEntry = objectValue(payload.catalog_entry, `reader candidate packet ${row.id} catalog_entry`);
    if (payload.id !== row.id || catalogEntry.id !== row.id ||
        catalogEntry.component !== row.component || catalogEntry.file_path !== row.file_path ||
        !payload.req_show || !payload.spec_graph || !Object.prototype.hasOwnProperty.call(payload, 'candidate')) {
      throw new Error(`reader candidate packet ${row.id} is detached from its prepared native item`);
    }
    const parentIds = Array.isArray(event.parentClaimIds) ? event.parentClaimIds : [];
    const parentClaims = parentIds.map(id => claims[id] || instanceClaims[id]).filter(Boolean);
    const candidateParents = parentClaims.filter(claim => claim.claim === 'native.review.candidate@1');
    const itemParents = parentClaims.filter(claim => claim.claim === 'native.spec.item@1');
    if (candidateParents.length !== 1 || itemParents.length !== 1 || parentClaims.length !== 2) {
      throw new Error(`reader candidate packet ${row.id} has detached candidate/item parents (parent_claims=${parentClaims.map(claim => `${claim.claim || '?'}:${claim.claimId || '?'}`).join(',')}; parent_ids=${parentIds.join(',')})`);
    }
    const candidate = candidateParents[0];
    if (canonicalJson(payload.candidate) !== canonicalJson(candidate.payload) ||
        candidate.payloadFingerprint !== createHash('sha256').update(canonicalJson(candidate.payload), 'utf8').digest('hex')) {
      throw new Error(`reader candidate packet ${row.id} candidate fingerprint is detached`);
    }
    packets.push({
      row,
      payload,
      claimId: event.claimId,
      payloadFingerprint: event.payloadFingerprint,
      candidateClaimId: candidate.claimId,
      candidatePayloadFingerprint: candidate.payloadFingerprint,
    });
  }
  if (packets.length !== selectedRows.length) throw new Error('reader checkpoint packet set does not match selected native rows');
  return { catalogRows, selectedRows, checkpoint, packets };
}

/**
 * Rebind every persisted adapter item to the immutable reader checkpoint on
 * each later lifecycle process.  The review output is an operational cache,
 * not a second source of candidate identity or lineage.
 */
async function assertReviewItemsReaderBindings(
  subject: string,
  readerOutput: string,
  items: readonly ReviewItem[],
  phase: string,
): Promise<void> {
  const reader = await readReaderPackets(subject, readerOutput);
  if (reader.packets.length !== items.length) {
    throw new Error(`${phase} review item set does not match the reader checkpoint`);
  }
  const packetsById = new Map(reader.packets.map(packet => [packet.row.id, packet]));
  const expectedCheckpointId = String(reader.checkpoint.sessionId);
  for (const item of items) {
    const packet = packetsById.get(item.id);
    if (!packet) throw new Error(`${phase} review item ${item.id} is absent from the reader checkpoint`);
    const expectedPacket = {
      ...packet.payload,
      claim_id: packet.claimId,
      payload_fingerprint: packet.payloadFingerprint,
      candidate_claim: {
        claim_id: packet.candidateClaimId,
        payload_fingerprint: packet.candidatePayloadFingerprint,
      },
    };
    if (canonicalJson(item.packet) !== canonicalJson(expectedPacket)) {
      throw new Error(`${phase} review item ${item.id} packet is detached from the reader checkpoint`);
    }
    const lineage = objectValue(item.lineage, `${phase} review item ${item.id} lineage`);
    const expectedLineage: Record<string, string> = {
      packet_id: packet.claimId,
      packet_fingerprint: packet.payloadFingerprint,
      candidate_claim_id: packet.candidateClaimId,
      candidate_payload_fingerprint: packet.candidatePayloadFingerprint,
      checkpoint_id: expectedCheckpointId,
    };
    for (const [key, expected] of Object.entries(expectedLineage)) {
      if (lineage[key] !== expected) {
        throw new Error(`${phase} review item ${item.id} lineage field ${key} is detached from the reader checkpoint`);
      }
    }
  }
}

function graphRequirementIds(graph: Json, itemId: string): string[] {
  if (!Array.isArray(graph.nodes)) throw new Error(`spec graph for ${itemId} has no nodes`);
  const ids = graph.nodes
    .filter(node => node && typeof node === 'object' && !Array.isArray(node) && node.type === 'requirement')
    .map(node => typeof node.id === 'string' ? node.id : typeof node.label === 'string' ? node.label : '')
    .filter(Boolean);
  if (!ids.includes(itemId)) ids.unshift(itemId);
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new Error(`spec graph for ${itemId} has duplicate requirement nodes`);
  return unique;
}

function reviewItemForPacket(
  proof: string,
  subject: string,
  output: string,
  packet: ReaderPacket,
  role: string,
  reviewer: string,
  phase: string,
  checkpointId: string,
): ReviewItem {
  const currentShow = runProof(proof, subject, output, `${phase}-${packet.row.id}-show`, [
    'req', 'show', packet.row.id, '--with', 'file', '--format', 'json',
  ]);
  const currentEnvelope = parseJson(currentShow, `Proof req show ${packet.row.id}`) as Json;
  const currentRequirement = objectValue(currentEnvelope.requirement, `Proof req show ${packet.row.id} requirement`);
  if (currentRequirement.id !== packet.row.id || currentRequirement.component !== packet.row.component ||
      currentEnvelope.file_path !== packet.row.file_path ||
      proofFileHash(currentRequirement, packet.row.id) !== proofFileHash(objectValue(packet.payload.req_show, `packet ${packet.row.id} req_show`).requirement as Json, packet.row.id)) {
    throw new Error(`current Proof requirement ${packet.row.id} is not the packet's exact input`);
  }
  const contextResult = runProof(proof, subject, output, `${phase}-${packet.row.id}-context`, [
    'req', 'context', packet.row.id, '--no-limit', '--format', 'json',
  ]);
  const context = parseJson(contextResult, `Proof req context ${packet.row.id}`) as Json;
  if (context.req_id !== packet.row.id) throw new Error(`Proof req context ${packet.row.id} has the wrong requirement identity`);
  const boundContext = contextWithoutNativeReviewArtifacts(context, subject);
  const contextBytes = normalizedContextBytes(boundContext, subject);
  const graph = objectValue(packet.payload.spec_graph, `packet ${packet.row.id} spec_graph`);
  const parentBindings: Json[] = [];
  for (const requirementId of graphRequirementIds(graph, packet.row.id)) {
    const shown = requirementId === packet.row.id
      ? currentEnvelope
      : parseJson(runProof(proof, subject, output, `${phase}-${packet.row.id}-parent-${requirementId}`, [
        'req', 'show', requirementId, '--with', 'file', '--format', 'json',
      ]), `Proof req show ${requirementId}`) as Json;
    const requirement = objectValue(shown.requirement, `Proof req show ${requirementId} requirement`);
    if (requirement.id !== requirementId || typeof shown.file_path !== 'string') {
      throw new Error(`Proof req show ${requirementId} is not a complete parent input for ${packet.row.id}`);
    }
    parentBindings.push({
      requirement_id: requirementId,
      file_path: shown.file_path,
      file_hash: proofFileHash(requirement, requirementId),
      req_show: shown,
    });
  }
  return {
    id: packet.row.id,
    packet: {
      ...packet.payload,
      claim_id: packet.claimId,
      payload_fingerprint: packet.payloadFingerprint,
      candidate_claim: {
        claim_id: packet.candidateClaimId,
        payload_fingerprint: packet.candidatePayloadFingerprint,
      },
    },
    current_context: normalizedContextValue(boundContext, subject) as Json,
    current_context_bytes: contextBytes,
    current_context_sha256: contextDigest(contextBytes),
    parent_bindings: parentBindings,
    lineage: {
      packet_id: packet.claimId,
      packet_fingerprint: packet.payloadFingerprint,
      candidate_claim_id: packet.candidateClaimId,
      candidate_payload_fingerprint: packet.candidatePayloadFingerprint,
      checkpoint_id: checkpointId,
    },
    spec_review_role: role,
    reviewer,
  };
}

function reviewItemsFile(output: string): string {
  const file = path.join(output, 'review', 'items.json');
  if (!fs.existsSync(file)) throw new Error(`missing review item input: ${file}`);
  return file;
}

function readReviewItems(output: string): ReviewItem[] {
  const parsed = JSON.parse(fs.readFileSync(reviewItemsFile(output), 'utf8')) as unknown;
  const values = Array.isArray(parsed) ? parsed : objectValue(parsed, 'review items').items;
  if (!Array.isArray(values) || !values.length) throw new Error('review item input has no items');
  const seen = new Set<string>();
  return values.map((value, index) => {
    const item = objectValue(value, `review item ${index}`) as ReviewItem;
    if (typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error(`review item ${index} has a duplicate or missing id`);
    seen.add(item.id);
    if (typeof item.reviewer !== 'string' || !item.reviewer || !item.reviewer.startsWith('agent:')) throw new Error(`review item ${item.id} has no explicit agent reviewer`);
    if (typeof item.spec_review_role !== 'string' || !item.spec_review_role) throw new Error(`review item ${item.id} has no built-in role claim`);
    if (!item.packet || typeof item.packet !== 'object' || Array.isArray(item.packet) ||
        !item.current_context || typeof item.current_context !== 'object' || Array.isArray(item.current_context) ||
        !Array.isArray(item.parent_bindings) || !item.lineage || typeof item.lineage !== 'object' || Array.isArray(item.lineage)) {
      throw new Error(`review item ${item.id} has an incomplete closed input envelope`);
    }
    assertReviewItemContextBinding(item, 'review item input');
    return item;
  });
}

function assertReviewItemsUnchanged(
  proof: string,
  subject: string,
  output: string,
  items: readonly ReviewItem[],
  phase: string,
): void {
  const roleResult = runProof(proof, subject, output, `${phase}-role`, [
    'role', 'show', 'spec-review', '--format', 'agent',
  ]);
  if (roleResult.status !== 0 || !roleResult.stdout.trim()) {
    throw new Error(`${phase} could not read the built-in spec-review role`);
  }
  const expectedRoles = new Set(items.map(item => item.spec_review_role));
  if (expectedRoles.size !== 1 || !expectedRoles.has(roleResult.stdout.trim())) {
    throw new Error(`${phase} built-in spec-review role changed from the prepared role claim`);
  }
  const currentIds = new Set<string>();
  for (const item of items) {
    assertReviewItemContextBinding(item, phase);
    const packet = objectValue(item.packet, `review item ${item.id} packet`);
    const currentShow = parseJson(runProof(proof, subject, output, `${phase}-${item.id}-show`, [
      'req', 'show', item.id, '--with', 'file', '--format', 'json',
    ]), `Proof req show ${item.id}`) as Json;
    const requirement = objectValue(currentShow.requirement, `Proof req show ${item.id} requirement`);
    const expectedShow = objectValue(packet.req_show, `review item ${item.id} packet req_show`);
    if (currentShow.file_path !== expectedShow.file_path ||
        proofFileHash(requirement, item.id) !== proofFileHash(objectValue(expectedShow.requirement, `review item ${item.id} expected requirement`), item.id)) {
      throw new Error(`Proof input changed for review item ${item.id}`);
    }
    for (const [index, bindingValue] of item.parent_bindings.entries()) {
      const binding = objectValue(bindingValue, `review item ${item.id} parent binding ${index}`);
      if (typeof binding.requirement_id !== 'string' || typeof binding.file_path !== 'string' || typeof binding.file_hash !== 'string') {
        throw new Error(`review item ${item.id} has an incomplete parent input binding`);
      }
      const parentShow = parseJson(runProof(proof, subject, output, `${phase}-${item.id}-parent-${binding.requirement_id}`, [
        'req', 'show', binding.requirement_id, '--with', 'file', '--format', 'json',
      ]), `Proof req show ${binding.requirement_id}`) as Json;
      const parentRequirement = objectValue(parentShow.requirement, `Proof req show ${binding.requirement_id} requirement`);
      if (parentShow.file_path !== binding.file_path || proofFileHash(parentRequirement, binding.requirement_id) !== binding.file_hash) {
        throw new Error(`Proof parent input changed for review item ${item.id}: ${binding.requirement_id}`);
      }
    }
    const context = parseJson(runProof(proof, subject, output, `${phase}-${item.id}-context`, [
      'req', 'context', item.id, '--no-limit', '--format', 'json',
    ]), `Proof req context ${item.id}`) as Json;
    const bytes = normalizedContextBytes(context, subject);
    if (context.req_id !== item.id || contextDigest(bytes) !== item.current_context_sha256 || bytes !== item.current_context_bytes) {
      throw new Error(`current Proof context changed for review item ${item.id}`);
    }
    currentIds.add(item.id);
  }
  if (currentIds.size !== items.length) throw new Error('review item identity set is not unique');
}

function reviewerFrom(values: Record<string, string>): string {
  const reviewer = (values.reviewer || process.env[REVIEWER_ENV] || '').trim();
  if (!reviewer || !reviewer.startsWith('agent:') || reviewer === 'agent:unknown') {
    throw new Error('--reviewer (or VISOR_NATIVE_B_REVIEWER) must provide an explicit governed agent identity');
  }
  if (reviewer !== CONTROLLER_REVIEWER) throw new Error(`reviewer must match the governed spec-review profile (${CONTROLLER_REVIEWER})`);
  return reviewer;
}

function setReviewEnvironment(output: string, readerOutput: string, reviewer: string): void {
  pinNativeOnboardingTsProject();
  process.env[REVIEW_ITEMS_ENV] = reviewItemsFile(output);
  process.env[REVIEW_OUTPUT_ENV] = output;
  process.env[REVIEW_READER_OUTPUT_ENV] = readerOutput;
  process.env[REVIEWER_ENV] = reviewer;
  process.env.NATIVE_ONBOARDING_TS_NODE ||= require.resolve('ts-node/register/transpile-only');
  process.env.NATIVE_ONBOARDING_REPO_ROOT ||= path.resolve(__dirname, '../../..');
}

function extractRecordInputs(value: unknown): { item: ReviewItem; adjudication: Json } {
  const item = nestedOutput(value, 'item');
  const adjudication = nestedOutput(value, 'adjudication');
  if (!item || !adjudication) throw new Error('record-native-review stdin must contain item and adjudication outputs');
  return {
    item: objectValue(item, 'record item') as ReviewItem,
    adjudication: objectValue(adjudication, 'record adjudication'),
  };
}

function validateRecordItem(item: ReviewItem): void {
  if (typeof item.id !== 'string' || !item.id || typeof item.reviewer !== 'string' || !item.reviewer.startsWith('agent:')) {
    throw new Error('record item has no explicit governed reviewer identity');
  }
  const expectedReviewer = (process.env[REVIEWER_ENV] || '').trim();
  if (!expectedReviewer || item.reviewer !== expectedReviewer) {
    throw new Error(`record item ${item.id} reviewer is not the controller-selected reviewer`);
  }
  if (item.reviewer !== CONTROLLER_REVIEWER) throw new Error(`record item ${item.id} reviewer does not match the governed spec-review profile`);
  if (!item.lineage || typeof item.lineage.checkpoint_id !== 'string' || !item.lineage.checkpoint_id ||
      typeof item.lineage.packet_id !== 'string' || !item.lineage.packet_id) {
    throw new Error(`record item ${item.id} has no completed checkpoint/packet lineage`);
  }
  assertReviewItemContextBinding(item, 'record item');
}

function reviewRecordList(proof: string, subject: string, output: string, phase: string): Json[] {
  const listed = runProof(proof, subject, output, phase, [
    'review', 'list', '--kind', 'spec_conformance', '--format', 'json',
  ]);
  return recordsFromList(parseJson(listed, 'Proof review record list'));
}

function gitDirtyPaths(subject: string): string[] {
  const output = String(execFileSync('git', [
    '-C', subject, 'status', '--porcelain=v1', '--untracked-files=all',
  ], { encoding: 'utf8' }));
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const value = line.slice(3).trim();
    const rename = value.lastIndexOf(' -> ');
    return (rename >= 0 ? value.slice(rename + 4) : value).replace(/^"|"$/g, '');
  });
}

function nativeReviewPath(value: string): boolean {
  return value.startsWith('proof/reviews/') && value.endsWith('.yaml') &&
    value.slice('proof/reviews/'.length, -'.yaml'.length).length > 0 &&
    !value.includes('..');
}

function assertReviewWorkspaceDirt(
  subject: string,
  items: readonly ReviewItem[],
  records: readonly Json[],
  phase: string,
): Set<string> {
  const selected = new Set(items.map(item => item.id));
  const recordById = new Map<string, Json>();
  for (const record of records) {
    const tuple = reviewTuple(record, `${phase} persisted review record`);
    const id = typeof record.id === 'string' ? record.id : '';
    if (!id || recordById.has(id)) throw new Error(`${phase} has duplicate or malformed review record IDs`);
    recordById.set(id, record);
  }
  const dirty = new Set<string>();
  for (const file of gitDirtyPaths(subject)) {
    if (!nativeReviewPath(file)) throw new Error(`${phase} found unrelated subject dirt: ${file}`);
    const id = path.basename(file, '.yaml');
    if (!recordById.has(id)) throw new Error(`${phase} found an unlisted native review file: ${file}`);
    const tuple = reviewTuple(recordById.get(id), `${phase} dirty native review record`);
    if (!selected.has(tuple.subject) || tuple.reviewer !== CONTROLLER_REVIEWER) {
      throw new Error(`${phase} found dirty review data outside the prepared native item/reviewer set`);
    }
    dirty.add(file);
  }
  return dirty;
}

function assertReviewWriteDelta(
  subject: string,
  before: ReadonlySet<string>,
  records: readonly Json[],
  tuple: ReviewTuple,
  phase: string,
): string {
  const after = new Set(gitDirtyPaths(subject));
  for (const file of after) {
    if (!nativeReviewPath(file)) throw new Error(`${phase} found unrelated subject dirt: ${file}`);
  }
  const added = [...after].filter(file => !before.has(file));
  if (added.length !== 1) throw new Error(`${phase} expected exactly one newly dirty native review file, found ${added.length}`);
  const recordId = path.basename(added[0], '.yaml');
  const record = records.find(value => value.id === recordId);
  if (!record) throw new Error(`${phase} newly dirty native review file ${added[0]} has no Proof readback`);
  const readback = reviewTuple(record, `${phase} native review readback`);
  if (!sameReviewTuple(readback, tuple)) throw new Error(`${phase} newly dirty native review file does not match the requested tuple`);
  return added[0];
}

function exactRecordMatches(records: readonly Json[], tuple: ReviewTuple): { exact: Json[]; conflicts: Json[] } {
  const exact: Json[] = [];
  const conflicts: Json[] = [];
  for (const record of records) {
    const normalized = reviewTuple(record, 'persisted review record');
    if (normalized.kind === tuple.kind && normalized.subject === tuple.subject && normalized.reviewer === tuple.reviewer) {
      if (sameReviewTuple(normalized, tuple)) exact.push(record);
      else conflicts.push(record);
    }
  }
  return { exact, conflicts };
}

function reviewReceipt(
  status: 'recorded' | 'reused',
  record: Json,
  tuple: ReviewTuple,
  item: ReviewItem,
  recoveredWithoutReceipt = false,
): Json {
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) throw new Error(`Proof review record for ${item.id} has no id`);
  return {
    status,
    review_id: id,
    ...tuple,
    review: record,
    lineage: {
      item_id: item.id,
      packet_id: item.lineage.packet_id,
      checkpoint_id: item.lineage.checkpoint_id,
    },
    ...(recoveredWithoutReceipt ? { recovery: 'native-write-readback-without-command-receipt' } : {}),
  };
}

async function recordNativeReview(): Promise<void> {
  const output = process.env[REVIEW_OUTPUT_ENV];
  if (!output || !path.isAbsolute(output) || !fs.existsSync(output)) {
    throw new Error(`record-native-review requires ${REVIEW_OUTPUT_ENV} to name an existing absolute output directory`);
  }
  const subject = realDirectory(process.cwd(), 'record subject root');
  const gitRoot = String(execFileSync('git', ['-C', subject, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).trim();
  if (realDirectory(gitRoot, 'record subject git root') !== subject) throw new Error('record-native-review cwd must be the subject checkout root');
  const proof = proofExecutable(process.env.PROOF_BIN || '');
  const parsed = extractRecordInputs(JSON.parse((await readStdin()).trim()));
  validateRecordItem(parsed.item);
  const preparedItems = readReviewItems(output);
  const prepared = preparedItems.filter(item => item.id === parsed.item.id);
  if (prepared.length !== 1 || canonicalJson(prepared[0]) !== canonicalJson(parsed.item)) {
    throw new Error(`record item ${parsed.item.id} is not the exact controller-prepared checkpoint item`);
  }
  const tuple = validateAdjudication(parsed.item, parsed.adjudication);
  const records = reviewRecordList(proof, subject, output, `record-list-before-${parsed.item.id}`);
  const dirtBefore = assertReviewWorkspaceDirt(subject, preparedItems, records, `review record ${parsed.item.id} before write`);
  const initial = exactRecordMatches(records, tuple);
  if (initial.exact.length > 1) throw new Error(`multiple exact Proof review records already exist for ${tuple.subject}`);
  if (initial.exact.length === 1) {
    const existing = initial.exact[0];
    const id = typeof existing.id === 'string' ? existing.id : '';
    if (!id) throw new Error(`existing Proof review record for ${tuple.subject} has no id`);
    const shown = parseJson(runProof(proof, subject, output, `record-show-reused-${parsed.item.id}`, [
      'review', 'show', id, '--format', 'json',
    ]), `Proof review record show ${id}`) as Json;
    if (!sameReviewTuple(reviewTuple(shown, `Proof review record ${id}`), tuple)) throw new Error(`Proof review record ${id} readback conflicts with its list entry`);
    process.stdout.write(`${JSON.stringify(reviewReceipt('reused', shown, tuple, parsed.item))}\n`);
    return;
  }

  const args = [
    'review', 'record', '--kind', tuple.kind, '--reviewer', tuple.reviewer,
    '--subject', tuple.subject, '--decision', tuple.decision, '--comment', tuple.comment,
    ...tuple.citations.flatMap(citation => ['--citation', citation]), '--format', 'json',
  ];
  const recorded = runProof(proof, subject, output, `record-write-${parsed.item.id}`, args);
  if (recorded.status !== 0) {
    // A native writer can commit its YAML atomically and die before its
    // stdout/meta receipt is observed.  Only an exact post-failure readback
    // permits reuse; a missing or conflicting record remains a hard failure.
    const recovered = reviewRecordList(proof, subject, output, `record-list-recovery-${parsed.item.id}`);
    assertReviewWriteDelta(subject, dirtBefore, recovered, tuple, `review record ${parsed.item.id} recovery`);
    const afterFailure = exactRecordMatches(recovered, tuple);
    if (afterFailure.exact.length === 1) {
      const id = typeof afterFailure.exact[0].id === 'string' ? afterFailure.exact[0].id : '';
      if (!id) throw new Error(`recovered Proof review record for ${tuple.subject} has no id`);
      const shown = parseJson(runProof(proof, subject, output, `record-show-recovered-${parsed.item.id}`, [
        'review', 'show', id, '--format', 'json',
      ]), `Proof review record show ${id}`) as Json;
      if (!sameReviewTuple(reviewTuple(shown, `Proof review record ${id}`), tuple)) throw new Error(`recovered Proof review record ${id} readback conflicts with its list entry`);
      process.stdout.write(`${JSON.stringify(reviewReceipt('reused', shown, tuple, parsed.item, true))}\n`);
      return;
    }
    throw new Error(`Proof review record write failed with exit ${recorded.status}: ${recorded.stderr || recorded.stdout}`);
  }
  const written = parseJson(recorded, 'Proof review record write') as Json;
  const writtenTuple = reviewTuple(written, 'Proof review record write result');
  if (!sameReviewTuple(writtenTuple, tuple)) throw new Error('Proof review record write returned a different tuple');
  const id = typeof written.id === 'string' ? written.id : '';
  if (!id) throw new Error('Proof review record write returned no id');
  if (process.env.NODE_ENV === 'test' && process.env.VISOR_NATIVE_B_CRASH_AFTER_NATIVE_WRITE === 'true') {
    // This test-only switch models a process dying after Proof atomically
    // writes its native record but before the command receipt is emitted.
    // Recovery must use the native list/show readback, never a side ledger.
    process.kill(process.pid, 'SIGKILL');
  }
  const finalRecordsBeforeShow = reviewRecordList(proof, subject, output, `record-list-written-${parsed.item.id}`);
  assertReviewWriteDelta(subject, dirtBefore, finalRecordsBeforeShow, tuple, `review record ${parsed.item.id} write`);
  const shown = parseJson(runProof(proof, subject, output, `record-show-written-${parsed.item.id}`, [
    'review', 'show', id, '--format', 'json',
  ]), `Proof review record show ${id}`) as Json;
  if (!sameReviewTuple(reviewTuple(shown, `Proof review record ${id}`), tuple)) throw new Error(`Proof review record ${id} readback differs from the requested tuple`);
  const finalRecords = reviewRecordList(proof, subject, output, `record-list-after-${parsed.item.id}`);
  const final = exactRecordMatches(finalRecords, tuple);
  if (final.exact.length !== 1) throw new Error(`Proof review record ${id} did not have one exact final readback`);
  process.stdout.write(`${JSON.stringify(reviewReceipt('recorded', shown, tuple, parsed.item))}\n`);
}

function setFocusIdsTransport(focusIds: readonly string[] | undefined): void {
  if (focusIds === undefined) {
    delete process.env[FOCUS_IDS_ENV];
  } else {
    process.env[FOCUS_IDS_ENV] = focusIds.join(',');
  }
}

function preparedFocusIds(output: string, selectedRows: readonly ProofRow[]): string[] | undefined {
  const file = path.join(output, 'prepare', 'summary.json');
  if (!fs.existsSync(file)) throw new Error(`missing prepare summary: ${file}`);
  const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  if (summary.focus_ids === null || summary.focus_ids === undefined) return undefined;
  if (!Array.isArray(summary.focus_ids) || summary.focus_ids.some(id => typeof id !== 'string')) {
    throw new Error('prepare summary has malformed focus_ids');
  }
  const ids = parseFocusIds(summary.focus_ids.join(','));
  const selectedIds = selectedRows.map(row => row.id).sort();
  if (!ids || JSON.stringify(ids) !== JSON.stringify(selectedIds)) {
    throw new Error('prepare summary focus_ids do not match its selected native items');
  }
  return ids;
}

function zeroModelTestEnabled(): boolean {
  const enabled = process.env.VISOR_NATIVE_B_ZERO_MODEL_TEST === 'true';
  if (enabled && process.env.NODE_ENV !== 'test') {
    throw new Error('VISOR_NATIVE_B_ZERO_MODEL_TEST requires NODE_ENV=test');
  }
  return enabled;
}

function nativeReviewItem(value: unknown): Json | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Json;
  if (
    typeof candidate.id === 'string' &&
    typeof candidate.spec_review_role === 'string' &&
    ((candidate.proof_snapshot && typeof candidate.proof_file_hash === 'string') ||
      (candidate.packet && candidate.current_context && candidate.lineage))
  ) {
    return candidate;
  }
  for (const key of ['output', 'payload', 'value']) {
    const nested = nativeReviewItem(candidate[key]);
    if (nested) return nested;
  }
  return undefined;
}

function installZeroModelPromptWitness(output: string): void {
  const provider = CheckProviderRegistry.getInstance().getProviderOrThrow('ai') as any;
  const original = provider.renderPromptTemplate;
  if (typeof original !== 'function') throw new Error('zero-model prompt witness requires AICheckProvider.renderPromptTemplate');
  if (provider.__nativeBPromptWitnessInstalled) return;
  provider.__nativeBPromptWitnessInstalled = true;
  provider.renderPromptTemplate = async function (...args: any[]): Promise<string> {
    const rendered = String(await original.apply(this, args));
    const dependencyResults = args[3];
    let item: Json | undefined;
    if (dependencyResults instanceof Map) {
      for (const value of dependencyResults.values()) {
        item = nativeReviewItem(value);
        if (item) break;
      }
    }
    if (!item) throw new Error('zero-model prompt witness found no native item in actual dependencyResults');
    const id = String(item.id);
    const role = String(item.spec_review_role);
    const serializedRole = JSON.stringify(role);
    if (!rendered.includes(id)) throw new Error(`zero-model rendered prompt omitted native requirement ${id}`);
    if (!rendered.includes(role) && !rendered.includes(serializedRole)) {
      throw new Error(`zero-model rendered prompt omitted built-in spec-review role for ${id}`);
    }
    writeText(path.join(output, 'diagnostic', 'zero-model-prompts', `${id}.txt`), rendered);
    return rendered;
  };
}

function installZeroModelReviewAdjudicationMock(): void {
  const serviceClass = require('../../../src/ai-review-service').AIReviewService as any;
  if (!serviceClass?.prototype || serviceClass.prototype.__nativeBReviewMockInstalled) return;
  const original = serviceClass.prototype.generateMockResponse;
  if (typeof original !== 'function') throw new Error('zero-model review mock requires AIReviewService.generateMockResponse');
  serviceClass.prototype.__nativeBReviewMockInstalled = true;
  serviceClass.prototype.generateMockResponse = async function (prompt: string, checkName?: string, schema?: unknown): Promise<string> {
    const marker = '--- controller item ---';
    const markerIndex = prompt.indexOf(marker);
    const jsonStart = markerIndex >= 0 ? prompt.indexOf('{', markerIndex + marker.length) : -1;
    let item: any;
    if (jsonStart >= 0) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = jsonStart; index < prompt.length; index += 1) {
        const character = prompt[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) {
          item = JSON.parse(prompt.slice(jsonStart, index + 1));
          break;
        }
      }
    }
    const firstPathLine = (value: unknown, inheritedPath?: string): string | undefined => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          const found = firstPathLine(entry, inheritedPath);
          if (found) return found;
        }
        return undefined;
      }
      if (!value || typeof value !== 'object') return undefined;
      const object = value as Record<string, unknown>;
      const currentPath = typeof object.path === 'string' ? object.path : inheritedPath;
      const line = typeof object.line === 'number' ? object.line : undefined;
      if (currentPath && line !== undefined && Number.isInteger(line) && line > 0) {
        return `${currentPath}:${line}`;
      }
      for (const child of Object.values(object)) {
        const found = firstPathLine(child, currentPath);
        if (found) return found;
      }
      return undefined;
    };
    const currentContext = item?.current_context;
    const citation = firstPathLine(currentContext?.implementation) ||
      firstPathLine(currentContext?.documentation) ||
      firstPathLine(currentContext);
    if (!citation) throw new Error('zero-model review mock found no path/line citation in serialized current_context');
    const response: Record<string, unknown> = {
      decision: 'needs_changes',
      comment: 'The bounded native fixture requires follow-up evidence before conformance can be accepted.',
      citations: [citation],
      reviewer: 'agent:model-echo',
    };
    if (process.env.VISOR_NATIVE_B_MISSING_CITATIONS_FOR === item?.id) delete response.citations;
    return JSON.stringify(response);
  };
}

async function configForSubject(
  subject: string,
  output: string,
  governedCodex?: GovernedCodexExecution,
  configPath: string = CONFIG_PATH,
) {
  const config = await loadConfig(configPath, { strict: true });
  if (zeroModelTestEnabled()) {
    const subgraphs = (config as any).subgraphs || {};
    const review = subgraphs?.['native-spec-item']?.checks?.['review-native-item'] ||
      subgraphs?.['native-review-item']?.checks?.['adjudicate-native-review'];
    if (!review) throw new Error('zero-model test could not find native review check');
    const mockAi = { ...(review.ai || {}) };
    delete mockAi.codex_execution_profile;
    review.ai = { ...mockAi, provider: 'mock', model: 'mock' };
    installZeroModelPromptWitness(output);
    if (configPath === REVIEW_CONFIG_PATH) {
      // The integration launches this child from Jest, whose inherited
      // JEST_WORKER_ID intentionally forces ProbeAgent in ordinary tests.
      // This bounded review fixture is explicitly zero-model, so use the
      // existing AIReviewService mock fast path for its adjudication only.
      delete process.env.JEST_WORKER_ID;
      installZeroModelReviewAdjudicationMock();
    }
  }
  const engine = new StateMachineExecutionEngine(subject);
  // Zero-model fixtures intentionally replace the governed reviewer with the
  // existing mock provider.  Keep their private-config path isolated from a
  // governed transport context; production reviewers receive the exact pins.
  if (governedCodex && !zeroModelTestEnabled()) {
    engine.setExecutionContext(governedCodex);
    writeJson(path.join(output, 'diagnostic', 'execution-context.json'), governedCodex);
  }
  return { config, engine };
}

async function prepare(subject: string, proof: string, output: string, focusIds?: readonly string[]): Promise<void> {
  const config = await loadConfig(CONFIG_PATH, { strict: true });
  const claimPlan = compileClaimPlan(config);
  const validatedClaimCounts: Record<string, number> = {};
  const role = runProof(proof, subject, output, 'prepare', ['role', 'show', 'spec-review', '--format', 'agent']);
  if (role.status !== 0) throw new Error(`built-in spec-review role failed with exit ${role.status}`);
  validatePreparedClaim(claimPlan, 'native.role.spec-review@1', role.stdout, validatedClaimCounts);
  writeText(path.join(output, 'prepare', 'role-spec-review.txt'), role.stdout);

  const list = runProof(proof, subject, output, 'prepare', ['req', 'list', '--format', 'json']);
  const catalogRows = nativeRows(parseJson(list, 'Proof req list') as ProofRow[]);
  // Keep the full current Proof catalog on disk, even for a focused run.  The
  // focused set is resolved only after every catalog identity has been checked.
  const rows = resolveFocusRows(catalogRows, focusIds);
  writeJson(path.join(output, 'prepare', 'catalog.json'), catalogRows);
  const componentIds = [...new Set(rows.map(row => row.component))].sort((left, right) => left.localeCompare(right));
  if (!componentIds.length) throw new Error('focus selection resolved no native components');
  const componentClaims = componentIds.map(id => ({ id, spec_review_role: role.stdout }));
  validatePreparedClaim(claimPlan, 'native.component.catalog@1', { components: componentClaims }, validatedClaimCounts);
  for (const component of componentClaims) {
    validatePreparedClaim(claimPlan, 'native.component.item@1', component, validatedClaimCounts);
  }
  const itemSummaries: Json[] = [];
  const nativeItems: Json[] = [];
  for (const row of rows) {
    const show = runProof(proof, subject, output, `prepare-${row.id}`, ['req', 'show', row.id, '--with', 'file', '--format', 'json']);
    const graph = runProof(proof, subject, output, `prepare-${row.id}`, ['spec', 'graph', '--focus', row.id, '--format', 'json']);
    const reqEnvelope = parseJson(show, `Proof req show ${row.id}`) as Json;
    const req = reqEnvelope.requirement as Json | undefined;
    if (!req || req.id !== row.id || req.component !== row.component || reqEnvelope.file_path !== row.file_path) throw new Error(`Proof req show ${row.id} does not match the catalog row`);
    const hash = proofFileHash(req, row.id);
    if (graph.status !== 0) throw new Error(`Proof spec graph ${row.id} failed with exit ${graph.status}`);
    const graphValue = parseJson(graph, `Proof spec graph ${row.id}`);
    if (!graphValue || Array.isArray(graphValue) || typeof graphValue !== 'object') throw new Error(`Proof spec graph ${row.id} is not an object`);
    writeJson(path.join(output, 'prepare', 'items', row.id, 'req-show.json'), reqEnvelope);
    writeJson(path.join(output, 'prepare', 'items', row.id, 'spec-graph.json'), graphValue);
    nativeItems.push({
      id: row.id,
      component: row.component,
      file_path: row.file_path,
      proof_file_hash: hash,
      spec_review_role: role.stdout,
      proof_snapshot: {
        catalog_entry: row,
        req_show: reqEnvelope,
        spec_graph: graphValue,
      },
    });
    itemSummaries.push({ id: row.id, component: row.component, file_path: row.file_path, file_hash: hash, graph_exit: graph.status });
  }
  const components = componentIds.map(id => ({ id, items: itemSummaries.filter(item => item.component === id) }));
  for (const component of componentIds) {
    const items = nativeItems.filter(item => item.component === component);
    validatePreparedClaim(claimPlan, 'native.spec.catalog@1', { items }, validatedClaimCounts);
    for (const item of items) {
      validatePreparedClaim(claimPlan, 'native.spec.item@1', item, validatedClaimCounts);
    }
  }
  const identity = {
    component_ids: componentIds,
    item_ids: nativeItems.map(item => item.id),
    items: itemSummaries.map(item => ({
      id: item.id,
      component: item.component,
      file_path: item.file_path,
      file_hash: item.file_hash,
    })),
  };
  writeJson(path.join(output, 'prepare', 'summary.json'), {
    phase: 'prepare',
    status: 'ready-for-review',
    components,
    component_count: components.length,
    item_count: rows.length,
    items: itemSummaries,
    role_exit: role.status,
    catalog_exit: list.status,
    proof_bin: proof,
    catalog_item_count: catalogRows.length,
    catalog_item_ids: catalogRows.map(item => item.id),
    focus_ids: focusIds === undefined ? null : [...focusIds],
    preflight: {
      status: 'validated',
      claim_types: Object.keys(validatedClaimCounts).sort(),
      validator_counts: validatedClaimCounts,
      component_ids: identity.component_ids,
      item_ids: identity.item_ids,
      catalog_item_ids: catalogRows.map(item => item.id),
      focus_ids: focusIds === undefined ? null : [...focusIds],
      graph_semantic_digest: claimPlan.expansionPlan.graphSemanticDigest,
      digest: preparedIdentityDigest(identity),
    },
    note: 'Native state is collected from Proof; this is not an admission receipt.',
  });
  console.log(JSON.stringify({ mode: 'prepare', status: 'ready-for-review', item_count: rows.length, catalog_item_count: catalogRows.length, focus_ids: focusIds || null, output }, null, 2));
}

async function recordPrepare(
  subject: string,
  proof: string,
  output: string,
  readerOutputArg: string,
  reviewer: string,
): Promise<void> {
  process.env.PROOF_BIN = proof;
  ensureFreshPrepareOutput(output);
  const readerOutput = fs.realpathSync(path.resolve(readerOutputArg));
  if (!fs.statSync(readerOutput).isDirectory()) throw new Error('--reader-output must be a directory');
  const reader = await readReaderPackets(subject, readerOutput);
  const roleResult = runProof(proof, subject, output, 'record-prepare-role', [
    'role', 'show', 'spec-review', '--format', 'agent',
  ]);
  if (roleResult.status !== 0 || !roleResult.stdout.trim()) throw new Error(`built-in spec-review role failed with exit ${roleResult.status}`);
  const role = roleResult.stdout.trim();
  const hashes = verifyCurrentProofInputs(proof, subject, output, reader.catalogRows, reader.selectedRows, 'record-prepare');
  for (const row of reader.selectedRows) {
    const baseline = JSON.parse(fs.readFileSync(path.join(readerOutput, 'prepare', 'items', row.id, 'req-show.json'), 'utf8')) as Json;
    if (hashes[row.id] !== proofFileHash(objectValue(baseline.requirement, `reader ${row.id} req_show requirement`), row.id)) {
      throw new Error(`Proof input changed before review-record prepare for ${row.id}`);
    }
  }
  const items = reader.packets.map(packet => reviewItemForPacket(
    proof,
    subject,
    output,
    packet,
    role,
    reviewer,
    'record-prepare',
    String(reader.checkpoint.sessionId),
  ));
  for (const item of items) assertReviewItemContextBinding(item, 'record-prepare output');
  writeJson(path.join(output, 'review', 'items.json'), { items });
  writeJson(path.join(output, 'review', 'summary.json'), {
    phase: 'record-prepare',
    status: 'validated-current-native-review-inputs',
    reviewer,
    kind: 'spec_conformance',
    reader_output: readerOutput,
    reader_checkpoint_id: reader.checkpoint.sessionId,
    reader_checkpoint_integrity_digest: reader.checkpoint.integrity?.digest,
    item_count: items.length,
    item_ids: items.map(item => item.id),
    current_context_sha256: Object.fromEntries(items.map(item => [item.id, item.current_context_sha256])),
    note: 'Proof hashes requirement files natively; normalized req context bytes are Visor-bound adapter evidence, not a repo-wide freshness claim.',
  });
  console.log(JSON.stringify({ mode: 'record-prepare', status: 'validated-current-native-review-inputs', item_count: items.length, reviewer, output }, null, 2));
}

function recordCheckpointEvents(output: string, phase: 'paused' | 'resumed'): any {
  const file = path.join(output, phase, 'checkpoint.json');
  if (!fs.existsSync(file)) throw new Error(`missing review-record ${phase} checkpoint: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as any;
}

function assertRecordCheckpointProjection(config: any, checkpoint: any, label: string): void {
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
  const canonical = restored.exportGraphCheckpoint(checkpoint.sessionId);
  if (JSON.stringify(canonical) !== JSON.stringify(checkpoint)) throw new Error(`${label} checkpoint canonical re-export changed its bytes`);
}

function validateReadyRecordPauseCheckpoint(
  config: any,
  checkpoint: any,
  items: readonly ReviewItem[],
  observations: readonly Json[],
  label: string,
  historicalFailureGenerationIds: ReadonlySet<string> = new Set(),
): { events: any[]; heldGenerationIds: Set<string> } {
  const events = checkpointEvents(checkpoint);
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
  const projection = restored.getInstanceProjection();
  const generations = Object.values(projection.generationsById) as any[];
  const recorderGenerations = generations.filter(generation => generation.checkId === 'record-native-review');
  const adjudicationGenerations = generations.filter(generation => generation.checkId === 'adjudicate-native-review');
  if (recorderGenerations.length !== items.length) {
    throw new Error(`${label} expected one recorder generation per item, found ${recorderGenerations.length} for ${items.length} items`);
  }
  if (adjudicationGenerations.filter(generation => generation.status === 'completed').length !== items.length) {
    throw new Error(`${label} did not complete every per-item adjudication before the recorder frontier`);
  }
  const generationForItem = (item: ReviewItem): any[] => recorderGenerations.filter(generation =>
    (Array.isArray(generation.scope) && generation.scope.some((part: any) => part?.key === item.id)) ||
    (Array.isArray(generation.activeInputClaimIds) && generation.activeInputClaimIds.some((claimId: string) => {
      const claim = (projection as any).claimsById?.[claimId];
      return nativeReviewItem(claim?.payload)?.id === item.id;
    }))
  );
  for (const item of items) {
    const matches = generationForItem(item);
    if (matches.length !== 1 || matches[0].status !== 'ready') {
      throw new Error(`${label} did not leave exactly one ready recorder for ${item.id}`);
    }
  }
  if (recorderGenerations.some(generation => generation.status !== 'ready')) {
    throw new Error(`${label} left a per-item recorder outside the ready frontier`);
  }
  const heldGenerationIds = new Set(recorderGenerations.map(generation => generation.nodeGenerationId));
  if (events.some(event => heldGenerationIds.has(event.nodeGenerationId) && /^Attempt/.test(String(event.type)))) {
    throw new Error(`${label} held review-record scope already has an attempt event`);
  }
  const observedRows = observations.filter(observation => observation.check_id === 'record-native-review');
  if (observedRows.some(observation => observation.status !== 'ready')) {
    throw new Error(`${label} observed a recorder outside the ready frontier`);
  }
  const unexpectedFailures = events.filter(event =>
    (event?.type === 'AttemptFailed' || event?.type === 'CheckErrored') &&
    !historicalFailureGenerationIds.has(event.nodeGenerationId),
  );
  if (unexpectedFailures.length) throw new Error(`${label} checkpoint contains ${unexpectedFailures.length} failed generated attempt(s)`);
  if (generations.some(generation => generation.status === 'failed')) {
    throw new Error(`${label} checkpoint has an unresolved failed generation`);
  }
  assertRecordCheckpointProjection(config, checkpoint, label);
  return { events, heldGenerationIds };
}

function persistRecordPauseFailure(
  config: any,
  output: string,
  checkpoint: any,
  observations: readonly Json[],
  result: unknown,
  items: readonly ReviewItem[],
  reviewer: string,
  error: unknown,
): void {
  const failureCheckpointPath = path.join(output, 'paused', 'failure-checkpoint.json');
  if (fs.existsSync(failureCheckpointPath)) throw new Error(`review-record pause failure output already exists; refusing to overwrite ${failureCheckpointPath}`);
  const events = checkpointEvents(checkpoint);
  const message = error instanceof Error ? error.message : String(error);
  const generations = Object.values(ExecutionJournal.restoreGraphCheckpoint(
    compileClaimPlan(config),
    checkpoint,
  ).getInstanceProjection().generationsById) as any[];
  const failed = generations.filter(generation => generation.status === 'failed');
  writeJson(failureCheckpointPath, checkpoint);
  writeJson(path.join(output, 'paused', 'failure-observations.json'), observations);
  writeJson(path.join(output, 'paused', 'failure-summary.json'), {
    phase: 'record-pause',
    status: 'partial-review-record-adjudication-failed',
    pid: process.pid,
    reviewer,
    item_count: items.length,
    item_ids: items.map(item => item.id),
    checkpoint_session_id: checkpoint.sessionId,
    graph_semantic_digest: checkpoint.graphSemanticDigest,
    checkpoint_integrity_digest: checkpoint.integrity?.digest,
    checkpoint_event_count: events.length,
    failed_generation_ids: failed.map(generation => generation.nodeGenerationId),
    failed_check_ids: failed.map(generation => generation.checkId),
    result,
    error: message,
    note: 'The immutable Graph-v2 checkpoint preserves completed sibling adjudications for explicit failed-generation recovery; no recorder was dispatched.',
  });
}

function persistRecordPauseSuccess(
  output: string,
  checkpoint: any,
  observations: readonly Json[],
  result: unknown,
  items: readonly ReviewItem[],
  reviewer: string,
  heldGenerationIds: Set<string>,
  phase: string,
  status: string,
  diagnosticPrefix: string,
): void {
  const events = checkpointEvents(checkpoint);
  writeJson(path.join(output, 'diagnostic', `${diagnosticPrefix}-checkpoint.json`), checkpoint);
  writeJson(path.join(output, 'diagnostic', `${diagnosticPrefix}-observations.json`), observations);
  writeJson(path.join(output, 'diagnostic', `${diagnosticPrefix}-result.json`), result);
  writeJson(path.join(output, 'paused', 'checkpoint.json'), checkpoint);
  writeJson(path.join(output, 'paused', 'observations.json'), observations);
  writeJson(path.join(output, 'paused', 'summary.json'), {
    phase,
    status,
    held_scope: 'all-record-native-review',
    held_item_ids: items.map(item => item.id),
    held_generation_ids: [...heldGenerationIds],
    checkpoint_session_id: checkpoint.sessionId,
    graph_semantic_digest: checkpoint.graphSemanticDigest,
    checkpoint_integrity_digest: checkpoint.integrity?.digest,
    checkpoint_event_count: events.length,
    pid: process.pid,
    reviewer,
    result,
    note: 'The held scope is a ready per-item native recorder; no review record is implied until its exact Proof readback succeeds.',
  });
}

async function recordPause(
  subject: string,
  proof: string,
  output: string,
  governedCodex: GovernedCodexExecution | undefined,
  configPath: string,
  readerOutput: string,
  reviewer: string,
  holdId?: string,
): Promise<void> {
  process.env.PROOF_BIN = proof;
  const items = readReviewItems(output);
  await assertReviewItemsReaderBindings(subject, readerOutput, items, 'record-pause-input');
  const held = holdId || items[0].id;
  if (!items.some(item => item.id === held)) throw new Error(`--hold-id ${held} is not a prepared review item`);
  if (fs.existsSync(path.join(output, 'paused', 'checkpoint.json')) || fs.existsSync(path.join(output, 'paused', 'failure-checkpoint.json'))) {
    throw new Error('review-record pause output already exists; use a fresh output');
  }
  assertReviewItemsUnchanged(proof, subject, output, items, 'record-pause-input');
  setReviewEnvironment(output, readerOutput, reviewer);
  const { config, engine } = await configForSubject(subject, output, governedCodex, configPath);
  const observations: Json[] = [];
  const result = await engine.executeGroupedChecks(
    prInfo,
    ['materialize-retained-native-review-items'],
    undefined,
    config,
    undefined,
    false,
    config.max_parallelism,
    false,
    undefined,
    dispatchGate('pause', held, observations, 'record-native-review'),
  );
  const context = (engine as any)._lastContext;
  if (!context) throw new Error('Graph-v2 review-record engine did not expose a journal context');
  const checkpoint = JSON.parse(JSON.stringify(context.journal.exportGraphCheckpoint(context.sessionId)));
  // Persist the exact engine checkpoint before validating the expected ready
  // frontier.  A failed adjudication must leave a recoverable public prefix.
  writeJson(path.join(output, 'diagnostic', 'record-pause-checkpoint.json'), checkpoint);
  writeJson(path.join(output, 'diagnostic', 'record-pause-observations.json'), observations);
  writeJson(path.join(output, 'diagnostic', 'record-pause-result.json'), result);
  try {
    const { heldGenerationIds } = validateReadyRecordPauseCheckpoint(
      config,
      checkpoint,
      items,
      observations,
      'review-record pause',
    );
    const dirtAtPause = gitDirtyPaths(subject);
    if (dirtAtPause.length !== 0) throw new Error(`review-record pause found subject dirt despite deferring every recorder: ${dirtAtPause.join(', ')}`);
    persistRecordPauseSuccess(
      output,
      checkpoint,
      observations,
      result,
      items,
      reviewer,
      heldGenerationIds,
      'record-pause',
      'quiescent-ready-review-record-frontier',
      'record-pause',
    );
  } catch (error) {
    persistRecordPauseFailure(config, output, checkpoint, observations, result, items, reviewer, error);
    throw error;
  }
  console.log(JSON.stringify({ mode: 'record-pause', status: 'quiescent-ready-review-record-frontier', held_scope: 'all-record-native-review', held_item_ids: items.map(item => item.id), output }, null, 2));
}

async function recordResume(
  subject: string,
  proof: string,
  output: string,
  governedCodex: GovernedCodexExecution | undefined,
  configPath: string,
  readerOutput: string,
  reviewer: string,
): Promise<void> {
  process.env.PROOF_BIN = proof;
  const checkpoint = recordCheckpointEvents(output, 'paused');
  const pausedSummary = JSON.parse(fs.readFileSync(path.join(output, 'paused', 'summary.json'), 'utf8')) as Json;
  if (pausedSummary.pid === process.pid) throw new Error('review-record resume must run in a fresh OS process');
  if (fs.existsSync(path.join(output, 'resumed', 'checkpoint.json'))) throw new Error('review-record resume output already exists; refusing to overwrite evidence');
  const items = readReviewItems(output);
  const held = String((Array.isArray(pausedSummary.held_item_ids) && pausedSummary.held_item_ids[0]) || items[0].id);
  if (!items.some(item => item.id === held)) throw new Error('paused review-record scope is not present in the prepared item set');
  await assertReviewItemsReaderBindings(subject, readerOutput, items, 'record-resume-input');
  assertReviewItemsUnchanged(proof, subject, output, items, 'record-resume-input');
  setReviewEnvironment(output, readerOutput, reviewer);
  const { config, engine } = await configForSubject(subject, output, governedCodex, configPath);
  const observations: Json[] = [];
  const resumed = await engine.resumeGraphCheckpoint({
    checkpoint,
    config,
    prInfo,
    maxParallelism: config.max_parallelism,
    generatedDispatchGate: dispatchGate('resume', held, observations),
  });
  const returned = JSON.parse(JSON.stringify(resumed.checkpoint));
  const beforeEvents = checkpointEvents(checkpoint);
  const afterEvents = checkpointEvents(returned);
  if (returned.sessionId !== checkpoint.sessionId || returned.graphSemanticDigest !== checkpoint.graphSemanticDigest) {
    throw new Error('review-record resume changed checkpoint session or graph semantic digest');
  }
  if (JSON.stringify(afterEvents.slice(0, beforeEvents.length)) !== JSON.stringify(beforeEvents)) throw new Error('review-record resume did not preserve the exact paused event prefix');
  const suffix = afterEvents.slice(beforeEvents.length);
  const unexpected = suffix.filter(event => event?.type === 'AttemptStarted' && event?.checkId !== 'record-native-review');
  if (unexpected.length || suffix.some(event => event?.checkId === 'adjudicate-native-review' && event?.type === 'AttemptStarted')) {
    throw new Error('review-record resume replayed reader/model work instead of only the held recorder');
  }
  const started = new Set(suffix.filter(event => event?.type === 'AttemptStarted').map(event => event.nodeGenerationId));
  const completed = new Set(suffix.filter(event => event?.type === 'AttemptCompleted').map(event => event.nodeGenerationId));
  const failed = afterEvents.filter(event => event?.type === 'AttemptFailed' || event?.type === 'CheckErrored');
  if (failed.length) {
    writeJson(path.join(output, 'resumed', 'failure-checkpoint.json'), returned);
    writeJson(path.join(output, 'resumed', 'failure-summary.json'), {
      phase: 'record-resume',
      status: 'record-native-review-failed-before-receipt',
      pid: process.pid,
      checkpoint_session_id: returned.sessionId,
      graph_semantic_digest: returned.graphSemanticDigest,
      checkpoint_event_prefix_count: beforeEvents.length,
      resumed_event_count: afterEvents.length,
      failed_record_generation_ids: [...new Set(failed.map(event => event.nodeGenerationId).filter(Boolean))],
    });
    throw new Error(`review-record resume had ${failed.length} failed generated attempt(s); recover explicitly with record-recover`);
  }
  if (suffix.filter(event => event?.type === 'AttemptCompleted' && event?.checkId === 'record-native-review').length !== items.length) throw new Error('review-record resume did not complete every held recorder');
  for (const id of started) if (!completed.has(id)) throw new Error(`review-record resume left generated attempt ${id} incomplete`);
  assertRecordCheckpointProjection(config, returned, 'review-record resumed');
  writeJson(path.join(output, 'diagnostic', 'record-resume-checkpoint.json'), returned);
  writeJson(path.join(output, 'diagnostic', 'record-resume-observations.json'), observations);
  writeJson(path.join(output, 'diagnostic', 'record-resume-result.json'), resumed.result);
  writeJson(path.join(output, 'resumed', 'checkpoint.json'), returned);
  writeJson(path.join(output, 'resumed', 'observations.json'), observations);
  writeJson(path.join(output, 'resumed', 'summary.json'), {
    phase: 'record-resume',
    status: 'recorded-or-reused-exact-native-review-tuples',
    held_scope: 'all-record-native-review',
    held_item_ids: items.map(item => item.id),
    reviewer,
    checkpoint_session_id: returned.sessionId,
    checkpoint_event_prefix_count: beforeEvents.length,
    resumed_event_count: afterEvents.length,
    resume_pid_differs: pausedSummary.pid !== process.pid,
    result: resumed.result,
    note: 'Only the selected per-item recorder resumed; this is review evidence, not Proof approval, admission, or checklist confirmation.',
  });
  console.log(JSON.stringify({ mode: 'record-resume', status: 'recorded-or-reused-exact-native-review-tuples', held_scope: 'all-record-native-review', held_item_ids: items.map(item => item.id), output }, null, 2));
}

async function recoverFailedReviewAdjudications(
  subject: string,
  proof: string,
  output: string,
  governedCodex: GovernedCodexExecution | undefined,
  configPath: string,
  readerOutput: string,
  reviewer: string,
  checkpointPath: string,
  failureSummaryPath: string,
): Promise<void> {
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as any;
  const failureSummary = JSON.parse(fs.readFileSync(failureSummaryPath, 'utf8')) as Json;
  if (failureSummary.pid === process.pid) throw new Error('review-record recovery must run in a fresh OS process');
  if (fs.existsSync(path.join(output, 'paused', 'checkpoint.json'))) throw new Error('review-record recovery already has a normal paused checkpoint');
  if (fs.existsSync(path.join(output, 'recovered', 'checkpoint.json'))) throw new Error('review-record recovery output already exists; refusing to overwrite evidence');

  const items = readReviewItems(output);
  await assertReviewItemsReaderBindings(subject, readerOutput, items, 'record-recover-adjudication-input');
  assertReviewItemsUnchanged(proof, subject, output, items, 'record-recover-adjudication-input');
  setReviewEnvironment(output, readerOutput, reviewer);
  const { config, engine } = await configForSubject(subject, output, governedCodex, configPath);
  const plan = compileClaimPlan(config);
  const failedJournal = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  const beforeProjection = failedJournal.getInstanceProjection();
  const itemById = new Map(items.map(item => [item.id, item]));
  const generations = Object.values(beforeProjection.generationsById) as any[];
  const failed = generations.filter(generation =>
    generation.status === 'failed' && generation.checkId === 'adjudicate-native-review',
  );
  if (!failed.length) throw new Error('failed review-record checkpoint has no failed adjudicate-native-review generation');
  const failedIds = failed.map(generation => generation.nodeGenerationId).sort();
  const failedItemIds = new Set<string>();
  for (const generation of failed) {
    const claims = generation.activeInputClaimIds.map((id: string) => beforeProjection.claimsById[id]).filter(Boolean);
    const itemClaims = claims.filter((claim: any) => claim.claim === 'native.review.controller.item@1');
    if (itemClaims.length !== 1) throw new Error(`failed adjudicator ${generation.nodeGenerationId} has detached item intent`);
    const checkpointItem = objectValue(itemClaims[0].payload, `failed adjudicator ${generation.nodeGenerationId} item`);
    const itemId = checkpointItem.id;
    if (typeof itemId !== 'string' || !itemById.has(itemId)) {
      throw new Error(`failed adjudicator ${generation.nodeGenerationId} is outside the prepared review item set`);
    }
    const item = itemById.get(itemId)!;
    if (canonicalJson(checkpointItem) !== canonicalJson(item)) {
      throw new Error(`failed adjudicator ${generation.nodeGenerationId} item claim is not the exact prepared review item`);
    }
    failedItemIds.add(item.id);
  }
  if (failedItemIds.size !== failed.length) throw new Error('failed review-record checkpoint contains duplicate adjudication item intents');
  const successfulSiblingIds = new Set(
    generations
      .filter(generation => generation.status === 'completed' && generation.checkId === 'adjudicate-native-review')
      .map(generation => generation.nodeGenerationId),
  );
  const recordsBefore = reviewRecordList(proof, subject, output, 'record-recover-adjudication-list-before');
  const beforeIds = recordsBefore.map(record => record.id).sort();
  const observations: Json[] = [];
  let retryPrefix: any;
  let retried: { result: unknown; checkpoint: any; retryCheckpoint: any } | undefined;
  const persistRetryFailure = (failedCheckpoint: any, error: unknown): void => {
    const failurePath = path.join(output, 'recovered', 'failure-checkpoint.json');
    if (fs.existsSync(failurePath)) return;
    const message = error instanceof Error ? error.message : String(error);
    const events = checkpointEvents(failedCheckpoint);
    writeJson(failurePath, failedCheckpoint);
    writeJson(path.join(output, 'recovered', 'failure-summary.json'), {
      phase: 'record-recover',
      status: 'partial-review-record-adjudication-retry-failed',
      pid: process.pid,
      prior_failure_pid: failureSummary.pid,
      reviewer,
      checkpoint_session_id: failedCheckpoint.sessionId,
      graph_semantic_digest: failedCheckpoint.graphSemanticDigest,
      checkpoint_integrity_digest: failedCheckpoint.integrity?.digest,
      checkpoint_event_count: events.length,
      failed_generation_ids: failedIds,
      retry_prefix_event_count: retryPrefix ? checkpointEvents(retryPrefix).length : 0,
      error: message,
      note: 'The retry failure checkpoint and its durable prefix are retained; no recorder was dispatched.',
    });
  };

  try {
    retried = await engine.retryGraphCheckpoint({
      checkpoint,
      config,
      prInfo,
      retryGenerationIds: failedIds,
      externalSideEffects: 'absent',
      maxParallelism: config.max_parallelism,
      onRetryCheckpoint: prefix => {
        retryPrefix = JSON.parse(JSON.stringify(prefix));
        writeJson(path.join(output, 'diagnostic', 'record-recover-retry-prefix.json'), retryPrefix);
      },
      generatedDispatchGate: generation => {
        const observation = {
          pid: process.pid,
          mode: 'recover',
          recorded_at: new Date().toISOString(),
          generation_id: generation.nodeGenerationId,
          check_id: generation.checkId,
          template_node_key: generation.templateNodeKey,
          scope: generation.scope,
          status: generation.status,
        };
        observations.push(observation);
        if (failedIds.includes(generation.nodeGenerationId) && generation.checkId === 'adjudicate-native-review') return 'dispatch';
        if (generation.checkId === 'record-native-review') return 'defer';
        throw new Error(`review-record recovery attempted to dispatch unselected ${generation.checkId}`);
      },
    });
  } catch (error) {
    persistRetryFailure(retryPrefix || checkpoint, error);
    throw error;
  }
  if (!retried || !retryPrefix) {
    const error = new Error('review-record recovery did not persist a retry prefix');
    persistRetryFailure(retried?.checkpoint || checkpoint, error);
    throw error;
  }

  const returned = JSON.parse(JSON.stringify(retried.checkpoint));
  try {
    const prefixEvents = checkpointEvents(retryPrefix);
    const beforeEvents = checkpointEvents(checkpoint);
    if (returned.sessionId !== checkpoint.sessionId || returned.graphSemanticDigest !== checkpoint.graphSemanticDigest) {
      throw new Error('review-record recovery changed checkpoint session or graph semantic digest');
    }
    if (JSON.stringify(prefixEvents.slice(0, beforeEvents.length)) !== JSON.stringify(beforeEvents)) {
      throw new Error('review-record recovery did not preserve the failed checkpoint event prefix');
    }
    const returnedEvents = checkpointEvents(returned);
    const suffix = returnedEvents.slice(prefixEvents.length);
    const retryStarts = suffix.filter(event => event?.type === 'AttemptStarted');
    if (retryStarts.some(event => event?.checkId !== 'adjudicate-native-review' || !failedIds.includes(event.nodeGenerationId))) {
      throw new Error('review-record recovery dispatched work outside the failed adjudication set');
    }
    if (retryStarts.some(event => event?.checkId === 'record-native-review')) {
      throw new Error('review-record recovery dispatched a recorder before the recovered pause frontier');
    }
    if (suffix.some(event => successfulSiblingIds.has(event?.nodeGenerationId))) {
      throw new Error('review-record recovery changed a completed sibling adjudication attempt');
    }
    const returnedJournal = ExecutionJournal.restoreGraphCheckpoint(plan, returned);
    const afterProjection = returnedJournal.getInstanceProjection();
    for (const generationId of successfulSiblingIds) {
      if (JSON.stringify(afterProjection.generationsById[generationId]) !== JSON.stringify(beforeProjection.generationsById[generationId])) {
        throw new Error(`review-record recovery changed completed sibling generation ${generationId}`);
      }
    }
    const completedRetries = suffix.filter(event => event?.type === 'AttemptCompleted' && event?.checkId === 'adjudicate-native-review');
    if (completedRetries.length !== failed.length || completedRetries.some(event => !failedIds.includes(event.nodeGenerationId))) {
      throw new Error('review-record recovery did not complete every failed adjudication retry');
    }
    const recordsAfter = reviewRecordList(proof, subject, output, 'record-recover-adjudication-list-after');
    if (recordsAfter.map(record => record.id).sort().join(',') !== beforeIds.join(',')) {
      throw new Error('review-record recovery wrote native records before the paused recorder frontier');
    }
    const { heldGenerationIds } = validateReadyRecordPauseCheckpoint(
      config,
      returned,
      items,
      observations,
      'review-record recovery',
      new Set(failedIds),
    );
    persistRecordPauseSuccess(
      output,
      returned,
      observations,
      retried.result,
      items,
      reviewer,
      heldGenerationIds,
      'record-recover',
      'quiescent-ready-review-record-frontier-after-adjudication-recovery',
      'record-recover',
    );
    writeJson(path.join(output, 'recovered', 'checkpoint.json'), returned);
    writeJson(path.join(output, 'recovered', 'observations.json'), observations);
    writeJson(path.join(output, 'recovered', 'summary.json'), {
      phase: 'record-recover',
      status: 'quiescent-ready-review-record-frontier-after-adjudication-recovery',
      pid: process.pid,
      prior_failure_pid: failureSummary.pid,
      checkpoint_session_id: returned.sessionId,
      graph_semantic_digest: returned.graphSemanticDigest,
      checkpoint_integrity_digest: returned.integrity?.digest,
      failed_generation_ids: failedIds,
      failed_item_ids: [...failedItemIds],
      completed_sibling_generation_ids: [...successfulSiblingIds],
      retry_prefix_event_count: prefixEvents.length,
      recovered_event_count: returnedEvents.length,
      held_generation_ids: [...heldGenerationIds],
      external_side_effects: 'absent',
      note: 'Only failed adjudication generations were retried; completed sibling adjudications were preserved and every native recorder remained deferred.',
    });
  } catch (error) {
    persistRetryFailure(returned, error);
    throw error;
  }
  console.log(JSON.stringify({ mode: 'record-recover', status: 'quiescent-ready-review-record-frontier-after-adjudication-recovery', output }, null, 2));
}

async function recordRecover(
  subject: string,
  proof: string,
  output: string,
  governedCodex: GovernedCodexExecution | undefined,
  configPath: string,
  readerOutput: string,
  reviewer: string,
): Promise<void> {
  process.env.PROOF_BIN = proof;
  // A failed pause adjudication is recovered from the paused failure
  // checkpoint.  If a later record-resume also failed, prefer that newer
  // resumed checkpoint so the existing native-writer recovery remains intact.
  const pausedFailureCheckpointPath = path.join(output, 'paused', 'failure-checkpoint.json');
  const resumedFailureCheckpointPath = path.join(output, 'resumed', 'failure-checkpoint.json');
  const checkpointPath = fs.existsSync(resumedFailureCheckpointPath)
    ? resumedFailureCheckpointPath
    : pausedFailureCheckpointPath;
  if (!fs.existsSync(checkpointPath)) throw new Error(`missing failed review-record checkpoint: ${checkpointPath}`);
  if (fs.existsSync(path.join(output, 'recovered', 'checkpoint.json'))) throw new Error('review-record recovery output already exists; refusing to overwrite evidence');
  const failureSummaryPath = checkpointPath === resumedFailureCheckpointPath
    ? path.join(output, 'resumed', 'failure-summary.json')
    : path.join(output, 'paused', 'failure-summary.json');
  if (!fs.existsSync(failureSummaryPath)) throw new Error(`missing failed review-record summary: ${failureSummaryPath}`);
  const failureSummary = JSON.parse(fs.readFileSync(failureSummaryPath, 'utf8')) as Json;
  if (failureSummary.pid === process.pid) throw new Error('review-record recovery must run in a fresh OS process');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as any;
  const failedAdjudication = checkpointEvents(checkpoint).some(event =>
    event?.type === 'AttemptFailed' && event?.checkId === 'adjudicate-native-review',
  );
  if (failedAdjudication && checkpointPath === pausedFailureCheckpointPath) {
    return recoverFailedReviewAdjudications(
      subject,
      proof,
      output,
      governedCodex,
      configPath,
      readerOutput,
      reviewer,
      checkpointPath,
      failureSummaryPath,
    );
  }
  const items = readReviewItems(output);
  await assertReviewItemsReaderBindings(subject, readerOutput, items, 'record-recover-input');
  assertReviewItemsUnchanged(proof, subject, output, items, 'record-recover-input');
  setReviewEnvironment(output, readerOutput, reviewer);
  const { config, engine } = await configForSubject(subject, output, governedCodex, configPath);
  const plan = compileClaimPlan(config);
  const failedJournal = ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint);
  const projection = failedJournal.getInstanceProjection();
  const itemById = new Map(items.map(item => [item.id, item]));
  const failed = Object.values(projection.generationsById).filter((generation: any) =>
    generation.status === 'failed' && generation.checkId === 'record-native-review',
  ) as any[];
  if (!failed.length) throw new Error('failed review-record checkpoint has no failed record-native-review generation');
  const failedIds = failed.map(generation => generation.nodeGenerationId).sort();
  const intents: Array<{ item: ReviewItem; tuple: ReviewTuple }> = [];
  for (const generation of failed) {
    const claims = generation.activeInputClaimIds.map((id: string) => projection.claimsById[id]).filter(Boolean);
    const itemClaims = claims.filter((claim: any) => claim.claim === 'native.review.controller.item@1');
    const adjudications = claims.filter((claim: any) => claim.claim === 'native.review.adjudication@1');
    if (itemClaims.length !== 1 || adjudications.length !== 1) {
      throw new Error(`failed recorder ${generation.nodeGenerationId} has detached item/adjudication intent`);
    }
    const checkpointItem = objectValue(itemClaims[0].payload, `failed recorder ${generation.nodeGenerationId} item`);
    const itemId = checkpointItem.id;
    if (typeof itemId !== 'string' || !itemById.has(itemId)) {
      throw new Error(`failed recorder ${generation.nodeGenerationId} is outside the prepared review item set`);
    }
    const item = itemById.get(itemId)!;
    if (canonicalJson(checkpointItem) !== canonicalJson(item)) {
      throw new Error(`failed recorder ${generation.nodeGenerationId} item claim is not the exact prepared review item`);
    }
    const tuple = validateAdjudication(item, adjudications[0].payload);
    intents.push({ item, tuple });
  }
  if (new Set(intents.map(intent => intent.item.id)).size !== intents.length) {
    throw new Error('failed review-record checkpoint contains duplicate item intents');
  }
  const recordsBefore = reviewRecordList(proof, subject, output, 'record-recover-list-before');
  const dirtBefore = assertReviewWorkspaceDirt(subject, items, recordsBefore, 'review-record recovery before retry');
  const beforeIds = recordsBefore.map(record => record.id).sort();
  const preexistingExactIds = new Set<string>();
  const absentIntentIds = new Set<string>();
  const failedRecordIds = new Set<string>();
  for (const intent of intents) {
    const matches = exactRecordMatches(recordsBefore, intent.tuple);
    if (matches.exact.length > 1) {
      throw new Error(`failed recorder ${intent.item.id} has duplicate exact native tuples for safely-idempotent recovery`);
    }
    if (matches.exact.length === 0) {
      absentIntentIds.add(intent.item.id);
      continue;
    }
    const id = typeof matches.exact[0].id === 'string' ? matches.exact[0].id : '';
    if (!id || !dirtBefore.has(`proof/reviews/${id}.yaml`)) {
      throw new Error(`failed recorder ${intent.item.id} has an exact native tuple without its matching dirty review file`);
    }
    failedRecordIds.add(id);
    preexistingExactIds.add(id);
    const shown = parseJson(runProof(proof, subject, output, `record-recover-show-before-${intent.item.id}`, [
      'review', 'show', id, '--format', 'json',
    ]), `Proof review record show ${id}`) as Json;
    if (!sameReviewTuple(reviewTuple(shown, `Proof review record ${id}`), intent.tuple)) {
      throw new Error(`failed recorder ${intent.item.id} native tuple readback conflicts before recovery`);
    }
  }
  const completedReceiptIds = new Set<string>();
  for (const generation of Object.values(projection.generationsById) as any[]) {
    if (generation.status !== 'completed' || generation.checkId !== 'record-native-review') continue;
    for (const claimId of generation.completedOutputClaimIds || []) {
      const claim = projection.claimsById[claimId];
      const receipt = claim?.claim === 'native.review.record.receipt@1' ? claim.payload as Json : undefined;
      if (receipt && typeof receipt.review_id === 'string' && receipt.review_id) completedReceiptIds.add(receipt.review_id);
    }
  }
  const allowedRecoveryDirt = new Set<string>([...failedRecordIds, ...completedReceiptIds].map(id => `proof/reviews/${id}.yaml`));
  for (const file of dirtBefore) {
    if (!allowedRecoveryDirt.has(file)) throw new Error(`review-record recovery found dirty native review data not backed by this checkpoint: ${file}`);
  }
  const observations: Json[] = [];
  let retryPrefix: any;
  const retried = await engine.retryGraphCheckpoint({
    checkpoint,
    config,
    prInfo,
    retryGenerationIds: failedIds,
    externalSideEffects: 'safely_idempotent',
    maxParallelism: config.max_parallelism,
    onRetryCheckpoint: prefix => {
      retryPrefix = JSON.parse(JSON.stringify(prefix));
      writeJson(path.join(output, 'diagnostic', 'record-recover-retry-prefix.json'), retryPrefix);
    },
    generatedDispatchGate: generation => {
      observations.push({
        pid: process.pid,
        mode: 'recover',
        recorded_at: new Date().toISOString(),
        generation_id: generation.nodeGenerationId,
        check_id: generation.checkId,
        scope: generation.scope,
        status: generation.status,
      });
      if (generation.checkId !== 'record-native-review') {
        throw new Error(`review-record recovery attempted to dispatch ${generation.checkId}`);
      }
      return 'dispatch';
    },
  });
  const returned = JSON.parse(JSON.stringify(retried.checkpoint));
  if (!retryPrefix) throw new Error('review-record recovery did not persist a retry prefix');
  const prefixEvents = checkpointEvents(retryPrefix);
  const beforeEvents = checkpointEvents(checkpoint);
  if (returned.sessionId !== checkpoint.sessionId || returned.graphSemanticDigest !== checkpoint.graphSemanticDigest) {
    throw new Error('review-record recovery changed checkpoint session or graph semantic digest');
  }
  if (JSON.stringify(prefixEvents.slice(0, beforeEvents.length)) !== JSON.stringify(beforeEvents)) {
    throw new Error('review-record recovery did not preserve the failed checkpoint event prefix');
  }
  const returnedEvents = checkpointEvents(returned);
  const suffix = returnedEvents.slice(prefixEvents.length);
  const unexpected = suffix.filter(event => event?.type === 'AttemptStarted' && event?.checkId !== 'record-native-review');
  if (unexpected.length || suffix.some(event => event?.checkId === 'adjudicate-native-review' && event?.type === 'AttemptStarted')) {
    throw new Error('review-record recovery dispatched work outside the failed recorder set');
  }
  if (suffix.filter(event => event?.type === 'AttemptCompleted' && event?.checkId === 'record-native-review').length !== failed.length) {
    throw new Error('review-record recovery did not complete every failed recorder');
  }
  assertNoAttemptFailures(suffix, 'review-record recovery suffix');
  const recordsAfter = reviewRecordList(proof, subject, output, 'record-recover-list-after');
  const dirtAfter = assertReviewWorkspaceDirt(subject, items, recordsAfter, 'review-record recovery after retry');
  const afterIds = recordsAfter.map(record => record.id).sort();
  const beforeIdSet = new Set(beforeIds);
  const afterIdSet = new Set(afterIds);
  const newIds = afterIds.filter(id => !beforeIdSet.has(id));
  const addedDirt = [...dirtAfter].filter(file => !dirtBefore.has(file));
  if (beforeIds.some(id => !afterIdSet.has(id)) || newIds.length !== absentIntentIds.size ||
      addedDirt.length !== absentIntentIds.size) {
    throw new Error('review-record recovery changed native record IDs or dirt beyond absent failed writes');
  }
  for (const file of addedDirt) {
    const id = path.basename(file, '.yaml');
    if (!newIds.includes(id)) throw new Error(`review-record recovery created an unexpected native review file: ${file}`);
  }
  for (const intent of intents) {
    const matches = exactRecordMatches(recordsAfter, intent.tuple);
    if (matches.exact.length !== 1) throw new Error(`review-record recovery did not preserve exactly one tuple for ${intent.item.id}`);
    const id = typeof matches.exact[0].id === 'string' ? matches.exact[0].id : '';
    if (!id) throw new Error(`review-record recovery exact tuple for ${intent.item.id} has no record ID`);
    if (absentIntentIds.has(intent.item.id)) {
      if (!newIds.includes(id) || !addedDirt.includes(`proof/reviews/${id}.yaml`)) {
        throw new Error(`review-record recovery did not account for the newly written native tuple for ${intent.item.id}`);
      }
    } else if (!preexistingExactIds.has(id)) {
      throw new Error(`review-record recovery changed the native record ID for ${intent.item.id}`);
    }
  }
  assertRecordCheckpointProjection(config, returned, 'review-record recovered');
  writeJson(path.join(output, 'diagnostic', 'record-recover-checkpoint.json'), returned);
  writeJson(path.join(output, 'diagnostic', 'record-recover-observations.json'), observations);
  writeJson(path.join(output, 'diagnostic', 'record-recover-result.json'), retried.result);
  writeJson(path.join(output, 'recovered', 'checkpoint.json'), returned);
  writeJson(path.join(output, 'recovered', 'observations.json'), observations);
  writeJson(path.join(output, 'recovered', 'summary.json'), {
    phase: 'record-recover',
    status: 'reused-native-review-records-after-failed-receipt',
    pid: process.pid,
    prior_failure_pid: failureSummary.pid,
    checkpoint_session_id: returned.sessionId,
    graph_semantic_digest: returned.graphSemanticDigest,
    failed_generation_ids: failedIds,
    retry_prefix_event_count: prefixEvents.length,
    recovered_event_count: returnedEvents.length,
    external_side_effects: 'safely_idempotent',
    note: 'Native Proof records were reconciled by exact tuple readback; no model/adjudication work was replayed.',
  });
  console.log(JSON.stringify({ mode: 'record-recover', status: 'reused-native-review-records-after-failed-receipt', output }, null, 2));
}

function dispatchGate(mode: 'pause' | 'resume', holdId: string, observations: Json[], pauseOnlyCheck?: string): GeneratedDispatchGate {
  return generation => {
    const observation = {
      pid: process.pid,
      mode,
      recorded_at: new Date().toISOString(),
      generation_id: generation.nodeGenerationId,
      check_id: generation.checkId,
      template_node_key: generation.templateNodeKey,
      scope: generation.scope,
      status: generation.status,
      held_scope: generation.scope.some(part => part.key === holdId),
    };
    observations.push(observation);
    if (mode === 'pause' && (
      (pauseOnlyCheck && observation.check_id === pauseOnlyCheck) ||
      (!pauseOnlyCheck && observation.held_scope)
    )) return 'defer';
    return 'dispatch';
  };
}

function checkpointEvents(checkpoint: any): any[] {
  return Array.isArray(checkpoint?.events) ? checkpoint.events : [];
}

function assertNoAttemptFailures(events: any[], label: string): void {
  const failures = events.filter(event => event?.type === 'AttemptFailed' || event?.type === 'CheckErrored');
  if (failures.length) throw new Error(`${label} contains ${failures.length} failed generated attempt(s)`);
}

function assertUnchangedSiblingGenerations(before: any, after: any, heldId: string, completedGenerationIds: Set<string>): void {
  const beforeGenerations = before?.generationsById || {};
  const afterGenerations = after?.generationsById || {};
  for (const [id, generation] of Object.entries(beforeGenerations) as Array<[string, any]>) {
    if (!completedGenerationIds.has(id)) continue;
    if (Array.isArray(generation.scope) && generation.scope.some((part: any) => part.key === heldId)) continue;
    if (JSON.stringify(generation) !== JSON.stringify(afterGenerations[id])) {
      throw new Error(`resume changed completed sibling generation ${id}`);
    }
  }
}

async function pause(
  subject: string,
  proof: string,
  output: string,
  governedCodex: GovernedCodexExecution | undefined,
  holdId?: string,
): Promise<void> {
  const catalogRows = baselineCatalogRows(output);
  const rows = baselineSelectedRows(output);
  const held = holdId || rows[0].id;
  if (!rows.some(row => row.id === held)) throw new Error(`--hold-id ${held} is not a prepared native requirement`);
  if (fs.existsSync(path.join(output, 'paused', 'checkpoint.json')) || fs.existsSync(path.join(output, 'commands', 'pause-catalog'))) {
    throw new Error('pause output already exists; use a fresh run output');
  }
  const pauseHashes = verifyCurrentProofInputs(proof, subject, output, catalogRows, rows, 'pause');
  for (const row of rows) {
    const baseline = JSON.parse(fs.readFileSync(path.join(output, 'prepare', 'items', row.id, 'req-show.json'), 'utf8')) as Json;
    if (pauseHashes[row.id] !== proofFileHash(baseline.requirement as Json, row.id)) throw new Error(`Proof input changed before pause for ${row.id}`);
  }
  process.env.PROOF_BIN = proof;
  const { config, engine } = await configForSubject(subject, output, governedCodex);
  const observations: Json[] = [];
  const result = await engine.executeGroupedChecks(
    prInfo,
    ['discover-native-components'],
    undefined,
    config,
    undefined,
    false,
    config.max_parallelism,
    false,
    undefined,
    dispatchGate('pause', held, observations),
  );
  const context = (engine as any)._lastContext;
  if (!context) throw new Error('Graph-v2 engine did not expose a journal context');
  const checkpoint = JSON.parse(JSON.stringify(context.journal.exportGraphCheckpoint(context.sessionId)));
  const events = checkpointEvents(checkpoint);
  writeJson(path.join(output, 'diagnostic', 'pause-checkpoint.json'), checkpoint);
  writeJson(path.join(output, 'diagnostic', 'pause-observations.json'), observations);
  writeJson(path.join(output, 'diagnostic', 'pause-result.json'), result);
  const heldObservations = observations.filter(observation => observation.held_scope);
  const siblingObservations = observations.filter(observation => !observation.held_scope && observation.status === 'ready');
  if (!heldObservations.some(observation => observation.status === 'ready')) throw new Error('pause did not hold a ready generated scope');
  const siblingPacketCompleted = events.some(event => event?.type === 'AttemptCompleted' && event?.checkId === 'collect-proof-evidence' && !event.scope?.some((part: any) => part.key === held));
  if (rows.length > 1 && (!siblingObservations.length || !siblingPacketCompleted)) throw new Error('pause did not observe sibling candidate-packet progression');
  const heldGenerationIds = new Set(heldObservations.map(observation => observation.generation_id));
  const heldAttemptEvents = events.filter(event => heldGenerationIds.has(event.nodeGenerationId) && /^Attempt/.test(String(event.type)));
  if (heldAttemptEvents.length) throw new Error('held ready scope already has an attempt event');
  assertNoAttemptFailures(events, 'paused checkpoint');
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
  const projection = context.journal.getInstanceProjection();
  if (JSON.stringify(projection) !== JSON.stringify(restored.getInstanceProjection())) {
    throw new Error('paused checkpoint projection does not match its restored projection');
  }
  const canonical = restored.exportGraphCheckpoint(checkpoint.sessionId);
  if (JSON.stringify(canonical) !== JSON.stringify(checkpoint)) throw new Error('paused checkpoint canonical re-export changed its bytes');
  writeJson(path.join(output, 'paused', 'checkpoint.json'), checkpoint);
  writeJson(path.join(output, 'paused', 'observations.json'), observations);
  writeJson(path.join(output, 'paused', 'summary.json'), {
    phase: 'pause',
    status: 'quiescent-ready-frontier',
    held_scope: held,
    pid: process.pid,
    result,
    checkpoint_session_id: checkpoint.sessionId,
    graph_semantic_digest: checkpoint.graphSemanticDigest,
    checkpoint_integrity_digest: checkpoint.integrity?.digest,
    checkpoint_event_count: events.length,
    held_generation_ids: [...heldGenerationIds],
    sibling_progressed: siblingObservations.length,
    sibling_packet_completed: siblingPacketCompleted,
    zero_model_test: zeroModelTestEnabled(),
    note: 'This holds a ready generated scope; it is not evidence of in-flight overlap or recovery.',
  });
  console.log(JSON.stringify({ mode: 'pause', status: 'quiescent-ready-frontier', held_scope: held, output }, null, 2));
}

async function resume(
  subject: string,
  proof: string,
  output: string,
  governedCodex: GovernedCodexExecution | undefined,
): Promise<void> {
  const checkpointPath = path.join(output, 'paused', 'checkpoint.json');
  if (!fs.existsSync(checkpointPath)) throw new Error(`missing paused checkpoint: ${checkpointPath}`);
  if (fs.existsSync(path.join(output, 'resumed', 'checkpoint.json')) || fs.existsSync(path.join(output, 'commands', 'resume-catalog'))) {
    throw new Error('resume output already exists; refusing to overwrite evidence');
  }
  const pausedSummaryPath = path.join(output, 'paused', 'summary.json');
  if (!fs.existsSync(pausedSummaryPath)) throw new Error(`missing paused summary: ${pausedSummaryPath}`);
  const pausedSummary = JSON.parse(fs.readFileSync(pausedSummaryPath, 'utf8')) as Json;
  if (pausedSummary.pid === process.pid) throw new Error('resume must run in a fresh OS process');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const catalogRows = baselineCatalogRows(output);
  const rows = baselineSelectedRows(output);
  const heldId = String(pausedSummary.held_scope || '');
  if (!rows.some(row => row.id === heldId)) throw new Error('paused held scope is not present in the prepared catalog');
  const currentHashes = verifyCurrentProofInputs(proof, subject, output, catalogRows, rows, 'resume');
  const stale: Json[] = [];
  for (const row of rows) {
    const baseline = JSON.parse(fs.readFileSync(path.join(output, 'prepare', 'items', row.id, 'req-show.json'), 'utf8')) as Json;
    const before = proofFileHash(baseline.requirement as Json, row.id);
    const after = currentHashes[row.id];
    if (before !== after) stale.push({ id: row.id, baseline_hash: before, current_hash: after });
  }
  if (stale.length) {
    writeJson(path.join(output, 'resume', 'stale-inputs.json'), stale);
    throw new Error(`Proof inputs changed since prepare (${stale.map(item => String(item.id)).join(', ')})`);
  }

  process.env.PROOF_BIN = proof;
  const { config, engine } = await configForSubject(subject, output, governedCodex);
  const observations: Json[] = [];
  const resumed = await engine.resumeGraphCheckpoint({
    checkpoint,
    config,
    prInfo,
    maxParallelism: config.max_parallelism,
    generatedDispatchGate: dispatchGate('resume', heldId, observations),
  });
  const returned = JSON.parse(JSON.stringify(resumed.checkpoint));
  const oldEvents = checkpointEvents(checkpoint);
  const newEvents = checkpointEvents(returned);
  writeJson(path.join(output, 'diagnostic', 'resume-checkpoint.json'), returned);
  writeJson(path.join(output, 'diagnostic', 'resume-observations.json'), observations);
  writeJson(path.join(output, 'diagnostic', 'resume-result.json'), resumed.result);
  if (returned.sessionId !== checkpoint.sessionId || returned.graphSemanticDigest !== checkpoint.graphSemanticDigest) {
    throw new Error('resume changed checkpoint session or graph semantic digest');
  }
  if (JSON.stringify(newEvents.slice(0, oldEvents.length)) !== JSON.stringify(oldEvents)) {
    throw new Error('resume did not preserve the exact paused event prefix');
  }
  const parentFanIn = observations.filter(observation => observation.check_id === 'wait-for-native-items');
  const unexpectedDispatch = observations.filter(observation => !observation.held_scope && observation.check_id !== 'wait-for-native-items');
  if (!observations.length || unexpectedDispatch.length || parentFanIn.length !== 1) {
    throw new Error('resume dispatched work outside the unfinished held scope and its single parent fan-in');
  }
  const newlyCompleted = newEvents.slice(oldEvents.length).filter(event => event?.type === 'AttemptCompleted');
  if (!newlyCompleted.length) throw new Error('resume did not complete any held generated attempt');
  if (!newEvents.some(event => event?.type === 'AttemptCompleted' && event?.checkId === 'wait-for-native-items')) {
    throw new Error('resume did not complete the parent fan-in');
  }
  const startedIds = new Set(newEvents.slice(oldEvents.length).filter(event => event?.type === 'AttemptStarted' && event.nodeGenerationId).map(event => event.nodeGenerationId));
  const completedIds = new Set(newEvents.slice(oldEvents.length).filter(event => event?.type === 'AttemptCompleted' && event.nodeGenerationId).map(event => event.nodeGenerationId));
  for (const id of startedIds) if (!completedIds.has(id)) throw new Error(`resume left generated attempt ${id} incomplete`);
  assertNoAttemptFailures(newEvents, 'resumed checkpoint');
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), returned);
  const before = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection();
  const completedBeforeResume = new Set(
    oldEvents
      .filter(event => event?.type === 'AttemptCompleted' && typeof event.nodeGenerationId === 'string')
      .map(event => event.nodeGenerationId as string),
  );
  assertUnchangedSiblingGenerations(before, restored.getInstanceProjection(), heldId, completedBeforeResume);
  if (JSON.stringify(engine.getInstanceProjection()) !== JSON.stringify(restored.getInstanceProjection())) {
    throw new Error('resumed checkpoint projection does not match its restored projection');
  }
  const canonical = restored.exportGraphCheckpoint(returned.sessionId);
  if (JSON.stringify(canonical) !== JSON.stringify(returned)) throw new Error('resumed checkpoint canonical re-export changed its bytes');
  writeJson(path.join(output, 'resumed', 'checkpoint.json'), returned);
  writeJson(path.join(output, 'resumed', 'observations.json'), observations);
  writeJson(path.join(output, 'resumed', 'summary.json'), {
    phase: 'resume',
    status: 'completed-or-reviewed-state-recorded',
    pid: process.pid,
    result: resumed.result,
    checkpoint_session_id: returned.sessionId,
    checkpoint_event_prefix_count: oldEvents.length,
    resumed_event_count: newEvents.length,
    resume_pid_differs: pausedSummary.pid !== process.pid,
    held_scope: heldId,
    stale_inputs: false,
    zero_model_test: zeroModelTestEnabled(),
    note: 'Execution completion does not imply Proof validation, review, or admission.',
  });
  console.log(JSON.stringify({ mode: 'resume', status: 'completed-or-reviewed-state-recorded', output }, null, 2));
}

async function main(): Promise<void> {
  const { mode, values } = parseArgs(process.argv.slice(2));
  if (mode === 'record-native-review') {
    diagnosticOutput = process.env[REVIEW_OUTPUT_ENV];
    return recordNativeReview();
  }
  const requestedFocusIds = parseFocusIds(values['focus-ids']);
  const roots = assertRoots(required(values, 'subject-root'), required(values, 'original-root'), required(values, 'output'));
  diagnosticOutput = roots.output;
  const proof = proofExecutable(required(values, 'proof-bin'));
  const zeroModel = zeroModelTestEnabled();
  // workspace:false is intentional for this prototype.  Ordinary command
  // providers inherit process.cwd(), so make the validated subject the process
  // cwd before loading or executing any Graph-v2 mode.
  process.chdir(roots.subject);
  if (fs.realpathSync(process.cwd()) !== roots.subject) throw new Error('runner cwd did not resolve to the validated subject root');
  process.env.VISOR_NATIVE_B_PREPARE_SUMMARY = path.join(roots.output, 'prepare', 'summary.json');
  process.env.USE_CODEX = zeroModel ? 'false' : 'true';
  process.env.DISABLE_FALLBACK = '1';
  process.env.AUTO_FALLBACK = '0';
  process.env.VISOR_DEBUG_AI_SESSIONS = zeroModel ? 'true' : 'false';
  process.env.VISOR_TRACE_DIR = process.env.VISOR_TRACE_DIR || path.join(roots.output, 'traces');
  if (mode === 'prepare') {
    const hasGovernedArgs = values['governed-codex-transport'] !== undefined ||
      values['codex-bin'] !== undefined || values['codex-sha256'] !== undefined;
    // Prepare is zero-model, but validate explicit transport pins when the
    // caller supplies them so the same invocation can be copied to pause and
    // resume without silently accepting an unverified identity.
    if (hasGovernedArgs) {
      resolveGovernedCodexExecution(values, roots.subject, roots.original, roots.output, zeroModel);
    }
    ensureFreshPrepareOutput(roots.output);
    setFocusIdsTransport(requestedFocusIds);
    return prepare(roots.subject, proof, roots.output, requestedFocusIds);
  }
  if (isReviewLifecycleMode(mode)) {
    const configPath = REVIEW_CONFIG_PATH;
    if (!fs.existsSync(configPath)) throw new Error(`review-record config does not exist: ${configPath}`);
    const reviewer = reviewerFrom(values);
    process.env[REVIEWER_ENV] = reviewer;
    const summaryPath = path.join(roots.output, 'review', 'summary.json');
    let readerOutput = values['reader-output'] || process.env[REVIEW_READER_OUTPUT_ENV] || '';
    if (!readerOutput && fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Json;
      if (typeof summary.reader_output === 'string') readerOutput = summary.reader_output;
    }
    if (!readerOutput) throw new Error('--reader-output is required for review-record pause/resume');
    if (mode === 'record-prepare') {
      return recordPrepare(roots.subject, proof, roots.output, readerOutput, reviewer);
    }
    const governedCodex = resolveGovernedCodexExecution(values, roots.subject, roots.original, roots.output, zeroModel);
    if (mode === 'record-pause') {
      return recordPause(roots.subject, proof, roots.output, governedCodex, configPath, readerOutput, reviewer, values['hold-id']);
    }
    if (mode === 'record-resume') {
      return recordResume(roots.subject, proof, roots.output, governedCodex, configPath, readerOutput, reviewer);
    }
    return recordRecover(roots.subject, proof, roots.output, governedCodex, configPath, readerOutput, reviewer);
  }
  const governedCodex = resolveGovernedCodexExecution(
    values,
    roots.subject,
    roots.original,
    roots.output,
    zeroModel,
  );
  const selectedRows = baselineSelectedRows(roots.output);
  const persistedFocusIds = preparedFocusIds(roots.output, selectedRows);
  if (requestedFocusIds !== undefined) {
    const expectedIds = selectedRows.map(row => row.id).sort();
    if (JSON.stringify(requestedFocusIds) !== JSON.stringify(expectedIds)) {
      throw new Error('--focus-ids does not match the prepared native selection');
    }
  }
  // Pause/resume must replay the same focused graph that prepare resolved;
  // callers cannot broaden or replace it between checkpoint processes.
  setFocusIdsTransport(persistedFocusIds);
  const aiArtifacts = path.join(roots.output, 'ai');
  fs.mkdirSync(aiArtifacts, { recursive: true });
  process.env.VISOR_DEBUG_ARTIFACTS = aiArtifacts;
  if (mode === 'pause') return pause(roots.subject, proof, roots.output, governedCodex, values['hold-id']);
  if (mode === 'resume') return resume(roots.subject, proof, roots.output, governedCodex);
  throw new Error(`unknown mode ${mode}; expected prepare, pause, or resume`);
}

let diagnosticOutput: string | undefined;

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    if (diagnosticOutput) writeText(path.join(diagnosticOutput, 'failure.stderr'), `${message}\n`);
  } catch {
    // Preserve the original failure on stderr if the output path is unusable.
  }
  console.error(message);
  process.exitCode = 1;
});
