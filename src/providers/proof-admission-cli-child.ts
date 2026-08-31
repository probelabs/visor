import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, realpathSync, statSync } from 'fs';
import { TextDecoder } from 'util';
import type {
  ManagedAgentRun,
  ManagedRunOutcomeV1,
} from './check-provider.interface';
import { canonicalJson } from '../state-machine/graph/claim-kernel';
import type { ManagedRunBindingV1 } from '../state-machine/graph/instance-kernel';

export const PROOF_ADMISSION_UNAVAILABLE = 'PROOF_ADMISSION_UNAVAILABLE';
const REQUEST_LIMIT = 2162688;
const STDOUT_LIMIT = 2097153;
const STDERR_LIMIT = 65536;
const DECISION_VERSION = 'proof.role-result-candidate-cli-decision/v1';
const RECEIPT_VERSION = 'proof.role-result-candidate-admission/v1';
const CANDIDATE_ID_DOMAIN = 'proof.role-result-candidate-envelope/id/v1';
const RECEIPT_ID_DOMAIN = 'proof.role-result-candidate-receipt/id/v1';
type ExecutableStat = Readonly<{
  realpath: string; dev: number; ino: number; mode: number; uid: number; gid: number; size: number;
  mtimeMs: number; ctimeMs: number; digest: string;
}>;
type ExecutableCapability = object;
type ProofAdmissionCliChildRequest = Readonly<{
  binding: ManagedRunBindingV1;
  workingDirectory: string;
  proofAdmissionRequest: string;
}>;
const executableCapabilities = new WeakMap<object, ExecutableStat>();

function fail(detail: string): never { throw new Error(`PROOF_ADMISSION_INVALID: ${detail}`); }
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every((key, index) => typeof key === 'string' && key === keys[index]);
}
function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('value is not JSON');
  return encoded.replace(/[<>&\u2028\u2029]/g, char => {
    const code = char.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}
function validUnicode(value: unknown): boolean {
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(i + 1); if (next < 0xdc00 || next > 0xdfff) return false; i++; }
      else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  }
  if (Array.isArray(value)) return value.every(validUnicode);
  if (plain(value)) return Object.values(value).every(validUnicode);
  return value === null || typeof value === 'boolean' || typeof value === 'number';
}
function digest(domain: string, bytes: Buffer): string {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
function parseRequest(request: string): { raw: Buffer; candidate: Record<string, unknown>; candidateRaw: Buffer } {
  const raw = Buffer.from(request, 'utf8');
  if (raw.length > REQUEST_LIMIT) fail('request exceeds bounded wire limit');
  try { new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail('request UTF-8 is invalid'); }
  let outer: unknown;
  try { outer = JSON.parse(request); } catch { fail('request is not JSON'); }
  if (!exact(outer, ['version', 'candidate']) || outer.version !== 'proof.role-result-candidate-cli-request/v1') fail('request envelope is invalid');
  if (typeof outer.candidate !== 'object' || outer.candidate === null) fail('candidate is not an object');
  const candidate = outer.candidate as Record<string, unknown>;
  const candidateKeys = ['Version', 'Invocation', 'InvocationDigest', 'RoleID', 'Stance', 'Subject', 'AttestationVersion', 'ExecutionSource', 'ProbeInvocationDigest', 'IdentityVersion', 'IdentitySource', 'ResultDigest', 'CanonicalBytes', 'ProbeResultBytes', 'VisorPayloadBytes', 'Publication', 'Binding', 'Termination'];
  if (!exact(candidate, candidateKeys) || !validUnicode(candidate)) fail('candidate wire keys or Unicode are invalid');
  validateCandidateShape(candidate);
  const marker = request.indexOf('"candidate":');
  const start = marker + '"candidate":'.length;
  const encoded = json(candidate);
  if (marker < 0 || request.slice(start, start + encoded.length) !== encoded || request.slice(start + encoded.length) !== '}') fail('candidate wire is not canonical');
  return { raw, candidate, candidateRaw: Buffer.from(encoded, 'utf8') };
}
function b64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || Buffer.from(value, 'base64').toString('base64') !== value) fail('wire bytes are invalid');
  return Buffer.from(value, 'base64');
}
function validateCandidateShape(candidate: Record<string, unknown>): void {
  const invocation = candidate.Invocation as Record<string, unknown>;
  if (!exact(invocation, ['role_id', 'stance', 'subject', 'output_schema_id', 'output_schema']) || !exact(invocation.subject, ['kind', 'id', 'fingerprint']) || !exact(candidate.Subject, ['kind', 'id', 'fingerprint'])) fail('invocation wire shape is invalid');
  const scope = (value: unknown): void => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(part => !exact(part, ['Kind', 'ExpansionOwnerCheck', 'Key', 'SubgraphInstanceID']))) fail('scope wire shape is invalid');
  };
  const publication = candidate.Publication as Record<string, unknown>;
  if (!exact(publication, ['Version', 'Type', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence', 'ClaimID', 'Claim', 'PayloadFingerprint', 'ProducerCheckID', 'Payload', 'ParentClaimIDs'])) fail('publication wire shape is invalid');
  scope(publication.Scope);
  const binding = candidate.Binding as Record<string, unknown>;
  if (!exact(binding, ['ManagedRunID', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence'])) fail('binding wire shape is invalid');
  scope(binding.Scope);
  const termination = candidate.Termination as Record<string, unknown>;
  if (!exact(termination, ['Version', 'Type', 'SessionID', 'Scope', 'Binding', 'CleanupStatus', 'ControllerDecision', 'FailureCode']) || termination.FailureCode !== null) fail('termination wire shape is invalid');
  scope(termination.Scope);
  const terminationBinding = termination.Binding as Record<string, unknown>;
  if (!exact(terminationBinding, ['ManagedRunID', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence'])) fail('termination binding wire shape is invalid');
  scope(terminationBinding.Scope);
  const probe = b64(candidate.ProbeResultBytes);
  if (candidate.CanonicalBytes !== probe.length || candidate.ProbeResultBytes !== candidate.VisorPayloadBytes || candidate.ProbeResultBytes !== publication.Payload) fail('candidate bytes are not bound');
  try {
    const payloadText = new TextDecoder('utf-8', { fatal: true }).decode(probe);
    const payload = JSON.parse(payloadText);
    if (!validUnicode(payload) || canonicalJson(payload) !== payloadText) fail('candidate payload is not canonical');
  } catch { fail('candidate payload is not valid UTF-8 JSON'); }
}
function equalJson(left: unknown, right: unknown): boolean { return json(left) === json(right); }
function freeze(value: unknown): unknown {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validateReceipt(decision: unknown, candidate: Record<string, unknown>, rawCandidate: Buffer): void {
  if (!exact(decision, ['version', 'status', 'receipt', 'reject_code']) || decision.version !== DECISION_VERSION) fail('decision envelope is invalid');
  const publication = candidate.Publication as Record<string, unknown>;
  const binding = candidate.Binding;
  const termination = candidate.Termination;
  if (decision.status === 'REJECTED') {
    if (decision.receipt !== null || decision.reject_code !== 'CANDIDATE_INVALID') fail('rejection decision is invalid');
    return;
  }
  if (decision.status !== 'ADMITTED' || decision.reject_code !== null || !exact(decision.receipt, ['Version', 'Status', 'CandidateID', 'ProbeResultDigest', 'ProbeCanonicalBytes', 'ClaimID', 'Claim', 'PayloadFingerprint', 'InvocationDigest', 'RoleID', 'Stance', 'Subject', 'ProducerCheckID', 'ParentClaimIDs', 'Binding', 'Termination', 'receipt_id'])) fail('admission decision is invalid');
  const receipt = decision.receipt as Record<string, unknown>;
  if (receipt.Version !== RECEIPT_VERSION || receipt.Status !== 'ADMITTED' || receipt.CandidateID !== digest(CANDIDATE_ID_DOMAIN, rawCandidate) || receipt.ProbeResultDigest !== candidate.ResultDigest || receipt.ProbeCanonicalBytes !== candidate.CanonicalBytes || receipt.ClaimID !== publication.ClaimID || receipt.Claim !== publication.Claim || receipt.PayloadFingerprint !== publication.PayloadFingerprint || receipt.InvocationDigest !== candidate.InvocationDigest || receipt.RoleID !== candidate.RoleID || receipt.Stance !== candidate.Stance || !equalJson(receipt.Subject, candidate.Subject) || receipt.ProducerCheckID !== publication.ProducerCheckID || !equalJson(receipt.ParentClaimIDs, publication.ParentClaimIDs) || !equalJson(receipt.Binding, binding) || !equalJson(receipt.Termination, termination) || typeof receipt.receipt_id !== 'string') fail('admission receipt identity is invalid');
  const unsigned: Record<string, unknown> = {};
  for (const key of Object.keys(receipt)) if (key !== 'receipt_id') unsigned[key] = receipt[key];
  if (receipt.receipt_id !== digest(RECEIPT_ID_DOMAIN, Buffer.from(json(unsigned), 'utf8'))) fail('admission receipt ID is invalid');
}

function executableStat(path: string): ExecutableStat | undefined {
  try {
    if (!path.startsWith('/')) return undefined;
    const realpath = realpathSync(path);
    const stat = statSync(realpath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return undefined;
    const bytes = readFileSync(realpath);
    return Object.freeze({ realpath, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, digest: createHash('sha256').update(bytes).digest('hex') });
  } catch { return undefined; }
}
function sameExecutable(left: ExecutableStat, right: ExecutableStat | undefined): boolean {
  return !!right && left.realpath === right.realpath && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.digest === right.digest;
}
function executableCapability(path: string): ExecutableCapability | undefined {
  const identity = executableStat(path);
  if (!identity) return undefined;
  const capability = Object.freeze({});
  executableCapabilities.set(capability, identity);
  return capability;
}
function capabilityIdentity(value: unknown): ExecutableStat | undefined {
  return value && typeof value === 'object' ? executableCapabilities.get(value) : undefined;
}
function groupAbsent(pid: number): boolean {
  try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export function goCompatibleProofJson(value: unknown): string { return json(value); }
export function proofExecutableAvailable(path: string | undefined): boolean {
  return process.platform !== 'win32' && typeof path === 'string' && executableStat(path) !== undefined;
}
export function createProofAdmissionCliChildForFocusedTest(path: string): object {
  const capability = executableCapability(path);
  if (!capability) fail(PROOF_ADMISSION_UNAVAILABLE);
  return capability;
}

export function startProofAdmissionCliChild(request: ProofAdmissionCliChildRequest, executablePath: unknown): ManagedAgentRun {
  if (process.platform === 'win32' || !request.workingDirectory || !request.proofAdmissionRequest) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const binding = request.binding;
  const executable = capabilityIdentity(executablePath);
  if (!executable) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const parsed = parseRequest(request.proofAdmissionRequest);
  let child: ChildProcess | undefined;
  let pid: number | undefined;
  let exitCode: number | null | undefined;
  let signal: NodeJS.Signals | null | undefined;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  let stdoutEnd = false, stderrEnd = false, closeSeen = false, writeDone = false;
  let cleaned = false;
  let failed: string | undefined;
  let decision: unknown;
  let admitted = false;
  let terminationRequested = false;
  let termSent = false, killSent = false, timer: ReturnType<typeof setTimeout> | undefined, reapTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveStarted!: (value: { version: 1; kind: 'started'; binding: ManagedRunBindingV1 }) => void;
  let rejectStarted!: (reason: unknown) => void;
  const started = new Promise<any>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  let resolveOutcome!: (value: ManagedRunOutcomeV1) => void;
  let rejectCleanup!: (reason: unknown) => void;
  let resolveCleanup!: (value: { version: 1; kind: 'cleanup'; binding: ManagedRunBindingV1; status: 'clean'; activeChildren: 0; activeResources: 0 }) => void;
  const outcome = new Promise<ManagedRunOutcomeV1>(resolve => { resolveOutcome = resolve; });
  const cleanup = new Promise<any>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject; });
  const failOnce = (reason: string) => { if (!failed) failed = reason; };
  const killIfNeeded = () => {
    if (!pid || groupAbsent(pid)) return;
    if (!termSent) { termSent = true; try { signalGroup(pid, 'SIGTERM'); } catch { failOnce('termination failed'); } }
    if (!timer) timer = setTimeout(() => { if (pid && !groupAbsent(pid) && !killSent) { killSent = true; try { signalGroup(pid, 'SIGKILL'); } catch { failOnce('termination failed'); } } }, 250);
    if (!reapTimer) reapTimer = setTimeout(() => { reapTimer = undefined; if (pid && !groupAbsent(pid)) { failOnce('process group reap timed out'); if (timer) { clearTimeout(timer); timer = undefined; } child?.removeAllListeners(); child?.stdin?.removeAllListeners(); child?.stdout?.removeAllListeners(); child?.stderr?.removeAllListeners(); resolveOutcome(Object.freeze({ version: 1, kind: 'failed', binding })); rejectCleanup(new Error('process group reap timed out')); } }, 2000);
  };
  const settle = () => {
    if (!closeSeen || !stdoutEnd || !stderrEnd || !pid || !groupAbsent(pid)) return;
    if (cleaned) return;
    cleaned = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (reapTimer) { clearTimeout(reapTimer); reapTimer = undefined; }
    child?.removeAllListeners(); child?.stdin?.removeAllListeners(); child?.stdout?.removeAllListeners(); child?.stderr?.removeAllListeners();
    if (!failed && admitted && writeDone && exitCode === 0 && signal === null && stderr.length === 0 && decision !== undefined) {
      resolveOutcome(Object.freeze({ version: 1, kind: 'succeeded', binding, summary: Object.freeze({ issues: [], output: decision }) }));
    } else {
      resolveOutcome(Object.freeze({ version: 1, kind: 'failed', binding }));
    }
    resolveCleanup(Object.freeze({ version: 1, kind: 'cleanup', binding, status: 'clean', activeChildren: 0, activeResources: 0 }));
  };
  const inspectStdout = () => {
    if (failed || stdout.length > STDOUT_LIMIT || stdout.length < 2 || stdout[stdout.length - 1] !== 10) return;
    const raw = stdout.subarray(0, stdout.length - 1);
    if (raw.includes(10)) { failOnce('decision framing invalid'); return; }
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { failOnce('decision UTF-8 invalid'); return; }
    try {
      const parsedDecision = JSON.parse(decoded);
      validateReceipt(parsedDecision, parsed.candidate, parsed.candidateRaw);
      if (json(parsedDecision) !== decoded) failOnce('decision is not canonical');
      else {
        admitted = (parsedDecision as Record<string, unknown>).status === 'ADMITTED';
        decision = freeze((parsedDecision as Record<string, unknown>).receipt || parsedDecision);
      }
    } catch { failOnce('decision protocol invalid'); }
  };
  const attach = (proc: ChildProcess) => {
    proc.stdout?.on('data', (chunk: Buffer) => { const remaining = STDOUT_LIMIT - stdout.length; const append = Math.min(chunk.length, remaining); if (append > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, append)]); if (chunk.length > remaining) { failOnce('stdout limit exceeded'); killIfNeeded(); } });
    proc.stderr?.on('data', (chunk: Buffer) => { const remaining = STDERR_LIMIT - stderr.length; const append = Math.min(chunk.length, remaining); if (append > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, append)]); if (chunk.length > remaining) { failOnce('stderr limit exceeded'); killIfNeeded(); } });
    proc.stdout?.on('end', () => { stdoutEnd = true; inspectStdout(); settle(); });
    proc.stderr?.on('end', () => { stderrEnd = true; settle(); });
    proc.on('error', error => { failOnce('child process failed'); rejectStarted(error); closeSeen = true; stdoutEnd = true; stderrEnd = true; if (!pid) rejectCleanup(error); else settle(); });
    proc.on('exit', (code, exitedSignal) => { exitCode = code; signal = exitedSignal; if (pid && !groupAbsent(pid)) killIfNeeded(); settle(); });
    proc.on('close', () => { closeSeen = true; settle(); });
  };
  if (!sameExecutable(executable, executableStat(executable.realpath))) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  try {
    child = spawn(executable.realpath, ['admit-candidate'], { cwd: request.workingDirectory, env: {}, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    attach(child);
    child.once('spawn', () => {
      pid = child?.pid;
      if (!pid) { failOnce('child process did not expose a pid'); rejectStarted(new Error('child process did not expose a pid')); return; }
      resolveStarted(Object.freeze({ version: 1 as const, kind: 'started' as const, binding }));
      if (terminationRequested) { killIfNeeded(); return; }
      if (!sameExecutable(executable, executableStat(executable.realpath))) { failOnce('executable changed before write'); killIfNeeded(); return; }
      child?.stdin?.once('error', () => { failOnce('request write failed'); killIfNeeded(); });
      child?.stdin?.end(request.proofAdmissionRequest, 'utf8', () => { writeDone = true; settle(); });
    });
  } catch (error) {
    failOnce('child acquisition failed'); rejectStarted(error); if (pid) killIfNeeded(); else { closeSeen = true; stdoutEnd = true; stderrEnd = true; rejectCleanup(error); }
  }
  const terminate = async () => { terminationRequested = true; if (pid) killIfNeeded(); await cleanup; return { version: 1 as const, kind: 'cancelled' as const, binding, reason: 'deadline' as const }; };
  return Object.freeze({
    binding,
    started,
    outcome,
    cancel: async (reason: 'deadline', fence: number) => { if (fence !== binding.fence) throw new Error('stale cancellation fence'); return terminate(); },
    close: async () => { terminationRequested = true; if (pid && !closeSeen) killIfNeeded(); return cleanup; },
  });
}
