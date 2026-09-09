import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {
  activeChecklistNameFromProofShow,
  classifyNonAuthoritativeChecklistRefresh,
  promoteNativeDelta,
  type NativeChecklistRefreshFile,
  type NativePromotionInput,
} from '../../examples/agent-governance/native-onboarding/native-promotion';

const PROOF_BIN = process.env.PROOF_BIN ?? '';
if (process.env.PROOF_BIN && (!path.isAbsolute(PROOF_BIN) || !fs.existsSync(PROOF_BIN) || (fs.statSync(PROOF_BIN).mode & 0o111) === 0)) {
  throw new Error(`configured PROOF_BIN is not an executable: ${PROOF_BIN}`);
}
const describeNative = PROOF_BIN ? describe : describe.skip;

function git(root: string, args: string[]): string {
  return String(execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'})).trim();
}

function proof(root: string, args: string[]): string {
  const verifiedRoot = fs.realpathSync(root);
  if (git(verifiedRoot, ['rev-parse', '--show-toplevel']) !== verifiedRoot) {
    throw new Error(`test fixture is not a Git root: ${verifiedRoot}`);
  }
  return String(
    execFileSync(PROOF_BIN, args, {
      cwd: verifiedRoot,
      encoding: 'utf8',
      env: {...process.env, PROOF_BIN},
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
}

function createFixture(options: {seedComponentBAliases?: boolean} = {}): {
  canonicalRoot: string;
  writerRoot: string;
  baselineCommit: string;
  workItem: NativePromotionInput['workItem'];
  componentBRequirementPath: string;
  checklistStatePath: string;
  untouchedNativePaths: string[];
  cleanup: () => void;
} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-promotion-fixture-'));
  const canonicalRoot = path.join(parent, 'canonical');
  const writerRoot = path.join(parent, 'writer');
  fs.mkdirSync(canonicalRoot);
  fs.writeFileSync(path.join(canonicalRoot, 'go.mod'), 'module example.test/native\n\ngo 1.25\n');
  fs.writeFileSync(path.join(canonicalRoot, 'a.go'), 'package native\nfunc A() int { return 1 }\n');
  fs.writeFileSync(path.join(canonicalRoot, 'b.go'), 'package native\nfunc B() int { return 2 }\n');
  git(canonicalRoot, ['init', '--quiet']);
  git(canonicalRoot, ['config', 'user.email', 'native-promotion@example.invalid']);
  git(canonicalRoot, ['config', 'user.name', 'Native promotion test']);
  proof(canonicalRoot, ['init', '--name', 'native', '--template', 'go-package', '--scope', '.', '--strict']);
  const componentBRequirement = JSON.parse(proof(canonicalRoot, [
    'req',
    'new',
    'specs/system',
    '--component',
    'component_b',
    '--fretish',
    'the component_b shall always satisfy state < max_state',
    '--variables',
    'state,max_state',
    '--format',
    'json',
  ])) as {file: string};
  const componentARequirement = JSON.parse(proof(canonicalRoot, [
    'req',
    'new',
    'specs/system',
    '--component',
    'component_a',
    '--fretish',
    'the component_a shall always satisfy a_state > 0',
    '--variables',
    'a_state',
    '--format',
    'json',
  ])) as {file: string};
  proof(canonicalRoot, [
    'var',
    'add',
    'component_b',
    'state',
    '--type',
    'int',
    '--direction',
    'input',
    '--description',
    'Current state',
  ]);
  proof(canonicalRoot, [
    'var',
    'add',
    'component_b',
    'max_state',
    '--type',
    'int',
    '--direction',
    'input',
    '--description',
    'Maximum state',
  ]);
  proof(canonicalRoot, [
    'var',
    'add',
    'component_a',
    'a_state',
    '--type',
    'int',
    '--direction',
    'input',
    '--description',
    'Component A state',
  ]);
  if (options.seedComponentBAliases) {
    for (const alias of [
      'specs/stakeholder/variables/component_b.vars.yaml',
      'specs/software/variables/component_b.vars.yaml',
      'specs/integration/variables/component_b.vars.yaml',
    ]) {
      fs.mkdirSync(path.dirname(path.join(canonicalRoot, alias)), {recursive: true});
      fs.symlinkSync('../../system/variables/component_b.vars.yaml', path.join(canonicalRoot, alias));
    }
  }
  const checklistPath = '.proof/onboard-checklist-state.json';
  const checklistStatePath = 'proof/checklists/onboard_v1.state.yaml';
  fs.mkdirSync(path.join(canonicalRoot, '.proof'), {recursive: true});
  fs.mkdirSync(path.dirname(path.join(canonicalRoot, checklistStatePath)), {recursive: true});
  fs.writeFileSync(path.join(canonicalRoot, checklistStatePath), [
    'checklist: onboard_v1',
    'updated_at: "2026-09-08T20:09:27Z"',
    'steps:',
    '    init:',
    '        status: pending',
    '        check_results: []',
    '    research:',
    '        status: pending',
    '        check_results: []',
  ].join('\n') + '\n', 'utf8');
  const checklistState = proof(canonicalRoot, ['checklist', 'show', 'onboard_v1', '--format', 'json']);
  JSON.parse(checklistState);
  fs.writeFileSync(path.join(canonicalRoot, checklistPath), checklistState);
  JSON.parse(proof(canonicalRoot, ['status', '--format', 'json']));
  git(canonicalRoot, ['add', '-f', '--', checklistPath]);
  git(canonicalRoot, ['add', '.']);
  git(canonicalRoot, ['commit', '--quiet', '-m', 'native baseline']);
  const baselineCommit = git(canonicalRoot, ['rev-parse', 'HEAD']);
  execFileSync('git', ['-C', canonicalRoot, 'worktree', 'add', '--detach', writerRoot, baselineCommit], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    canonicalRoot,
    writerRoot: fs.realpathSync(writerRoot),
    baselineCommit,
    componentBRequirementPath: componentBRequirement.file,
    checklistStatePath,
    untouchedNativePaths: [
      componentARequirement.file,
      'specs/system/variables/component_a.vars.yaml',
      checklistPath,
      checklistStatePath,
    ],
    workItem: {
      component_id: 'component_b',
      sorted_owned_paths: ['b.go'],
      proof_component_subject: {
        fingerprint: `sha256:${crypto.createHash('sha256').update('component-b-baseline').digest('hex')}`,
      },
    },
    cleanup: () => {
      try {
        execFileSync('git', ['-C', canonicalRoot, 'worktree', 'remove', '--force', writerRoot], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // The test may have rejected before creating a valid worktree entry.
      }
      fs.rmSync(parent, {recursive: true, force: true});
    },
  };
}

function promotionInput(fixture: ReturnType<typeof createFixture>): NativePromotionInput {
  return {
    canonicalRoot: fixture.canonicalRoot,
    baselineCommit: fixture.baselineCommit,
    writerCheckout: {
      path: fixture.writerRoot,
      is_worktree: true,
      commit: fixture.baselineCommit,
      worktree_id: 'native-promotion-writer',
    },
    workItem: fixture.workItem,
    proofBin: PROOF_BIN,
    timeoutMs: 120_000,
  };
}

function canonicalBytes(root: string, relativePaths: string[]): Map<string, Buffer | undefined> {
  return new Map(
    relativePaths.map(relativePath => {
      const file = path.join(root, relativePath);
      return [relativePath, fs.existsSync(file) ? fs.readFileSync(file) : undefined];
    })
  );
}

function refreshFile(value: string): NativeChecklistRefreshFile {
  return {kind: 'file', bytes: Buffer.from(value, 'utf8')};
}

function checklistState(updatedAt: string, resultAt: string, semantic = 'confirmed'): string {
  return [
    'checklist: onboard_v1',
    'campaign_new_project: true',
    `updated_at: "${updatedAt}"`,
    'steps:',
    '  init:',
    `    status: ${semantic}`,
    '    check_results:',
    '      - id: validate_passes',
    '        status: pass',
    `        at: "${resultAt}"`,
    '      - id: role_prompt_hygiene',
    '        status: pass',
    `        at: "${resultAt}"`,
    '  research:',
    '    status: pending',
    '    check_results: []',
  ].join('\n') + '\n';
}

const TRACE_SCANNER = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/trace-annotation-scanner.go');
const GO_AVAILABLE = spawnSync('go', ['version'], {stdio: 'ignore'}).status === 0;
const describeTraceScanner = GO_AVAILABLE ? describe : describe.skip;

describeTraceScanner('bounded Go trace annotation scanner', () => {
  let cacheRoot: string;

  beforeAll(() => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-trace-annotation-scanner-test-'));
  });

  afterAll(() => {
    fs.rmSync(cacheRoot, {recursive: true, force: true});
  });

  function scan(baseline: string, current: string, requirementIds = ['SYS-REQ-1']): {allowed?: boolean; reason?: string} {
    const result = spawnSync('go', ['run', TRACE_SCANNER], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        PATH: process.env.PATH || '',
        HOME: cacheRoot,
        TMPDIR: cacheRoot,
        GOPATH: cacheRoot,
        GOCACHE: path.join(cacheRoot, 'cache'),
        GOMODCACHE: path.join(cacheRoot, 'mod'),
        GO111MODULE: 'off',
        GOTOOLCHAIN: 'local',
        GOPROXY: 'off',
        GOSUMDB: 'off',
        CGO_ENABLED: '0',
      },
      input: JSON.stringify({
        requirement_ids: requirementIds,
        files: [{
          path: 'b.go',
          baseline: Buffer.from(baseline, 'utf8').toString('base64'),
          current: Buffer.from(current, 'utf8').toString('base64'),
        }],
      }),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(String(result.stderr || result.error?.message || 'Go scanner failed'));
    return JSON.parse(String(result.stdout)) as {allowed?: boolean; reason?: string};
  }

  it('permits adding and removing grounded full-line annotations', () => {
    const baseline = 'package native\nfunc B() int { return 2 }\n';
    const annotated = 'package native\n// Implements: SYS-REQ-1\nfunc B() int { return 2 }\n';
    expect(scan(baseline, annotated)).toMatchObject({allowed: true});
    expect(scan(annotated, baseline)).toMatchObject({allowed: true});
  });

  it.each([
    ['executable return change', 'package native\n// Implements: SYS-REQ-1\nfunc B() int { return 3 }\n'],
    ['raw-string pseudo annotation', 'package native\nconst marker = "// Implements: SYS-REQ-1"\nfunc B() int { return 2 }\n'],
    ['build tag', '//go:build native\n\npackage native\nfunc B() int { return 2 }\n'],
    ['cgo directive', 'package native\n// #cgo CFLAGS: -Dchanged\nfunc B() int { return 2 }\n'],
    ['arbitrary comment', 'package native\n// ordinary comment\nfunc B() int { return 2 }\n'],
    ['inline annotation', 'package native\nfunc B() int { return 2 } // Implements: SYS-REQ-1\n'],
    ['wrong requirement ID', 'package native\n// Implements: SYS-REQ-2\nfunc B() int { return 2 }\n'],
  ])('rejects %s', (_label, current) => {
    const baseline = 'package native\nfunc B() int { return 2 }\n';
    expect(scan(baseline, current)).toMatchObject({allowed: false});
  });
});

describe('non-authoritative Proof checklist refresh classifier', () => {
  const status = {
    schema_version: 'proof.checklist.show.v1',
    checklist: 'onboard_v1',
    active: true,
  };
  const baseline = checklistState('2026-09-08T20:09:27Z', '2026-09-08T20:09:27Z');
  const current = checklistState('2026-09-08T21:14:05Z', '2026-09-08T21:14:05Z');

  it('ignores only forward timestamp refreshes and returns raw byte hashes', () => {
    expect(activeChecklistNameFromProofShow(status)).toBe('onboard_v1');
    const result = classifyNonAuthoritativeChecklistRefresh({
      expectedChecklist: 'onboard_v1',
      path: 'proof/checklists/onboard_v1.state.yaml',
      gitStatus: 'M',
      baseline: refreshFile(baseline),
      current: refreshFile(current),
    });
    expect(result).toMatchObject({
      kind: 'ignored',
      path: 'proof/checklists/onboard_v1.state.yaml',
      checklist: 'onboard_v1',
      disposition: 'non-authoritative-proof-checklist-refresh',
      baseline_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      current_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it.each([
    ['semantic state change', checklistState('2026-09-08T21:14:05Z', '2026-09-08T21:14:05Z', 'skipped')],
    ['backward timestamp', checklistState('2026-09-08T19:00:00Z', '2026-09-08T19:00:00Z')],
  ])('rejects %s', (_label, changed) => {
    const result = classifyNonAuthoritativeChecklistRefresh({
      expectedChecklist: 'onboard_v1',
      path: 'proof/checklists/onboard_v1.state.yaml',
      gitStatus: 'M',
      baseline: refreshFile(baseline),
      current: refreshFile(changed),
    });
    expect(result.kind).toBe('rejected');
  });

  it.each([
    ['wrong path', 'proof/checklists/other.state.yaml', baseline, current],
    ['wrong state name', 'proof/checklists/onboard_v1.state.yaml', baseline, current.replace('checklist: onboard_v1', 'checklist: other')],
  ])('does not accept %s', (_label, candidatePath, oldBytes, newBytes) => {
    const result = classifyNonAuthoritativeChecklistRefresh({
      expectedChecklist: 'onboard_v1',
      path: candidatePath,
      gitStatus: 'M',
      baseline: refreshFile(oldBytes),
      current: refreshFile(newBytes),
    });
    expect(result.kind).not.toBe('ignored');
  });

  it('rejects an untrusted or inactive checklist projection', () => {
    expect(() => activeChecklistNameFromProofShow({...status, active: false})).toThrow();
    expect(() => activeChecklistNameFromProofShow({...status, schema_version: 'other'})).toThrow();
  });

  it.each([
    ['non-modification status', {gitStatus: '??'}],
    ['missing check timestamp', {current: refreshFile(current.replace(/\n        at: "[^"]+"\n(?=  research:)/, '\n'))}],
    ['added check result', {current: refreshFile(current.replace(/\n  research:/, '\n      - id: extra\n        status: pass\n        at: "2026-09-08T21:14:05Z"\n  research:'))}],
    ['non-timestamp status change', {current: refreshFile(current.replace('status: confirmed', 'status: skipped'))}],
    ['confirmed_at change', {current: refreshFile(current.replace('status: confirmed', 'status: confirmed\n    confirmed_at: "2026-09-08T21:14:05Z"'))}],
  ])('rejects %s before treating the state file as ignored', (_label, overrides) => {
    const result = classifyNonAuthoritativeChecklistRefresh({
      expectedChecklist: 'onboard_v1',
      path: 'proof/checklists/onboard_v1.state.yaml',
      gitStatus: 'M',
      baseline: refreshFile(baseline),
      current: refreshFile(current),
      ...overrides,
    });
    expect(result.kind).toBe('rejected');
  });

  it.each([
    ['symlink', {kind: 'symlink', linkText: 'outside.state.yaml'} as NativeChecklistRefreshFile],
    ['missing', {kind: 'missing'} as NativeChecklistRefreshFile],
  ])('rejects a %s exact state path', (_label, candidate) => {
    const result = classifyNonAuthoritativeChecklistRefresh({
      expectedChecklist: 'onboard_v1',
      path: 'proof/checklists/onboard_v1.state.yaml',
      gitStatus: 'M',
      baseline: refreshFile(baseline),
      current: candidate,
    });
    expect(result.kind).toBe('rejected');
  });
});

describeNative('native onboarding promotion boundary', () => {
  it.each([
    ['executable source edit', 'package native\n// Implements: SYS-REQ-1\nfunc B() int { return 3 }\n'],
    ['raw-string pseudo annotation', 'package native\nconst marker = "// Implements: SYS-REQ-1"\nfunc B() int { return 2 }\n'],
    ['build tag', '//go:build native\n\npackage native\nfunc B() int { return 2 }\n'],
    ['cgo directive', 'package native\n// #cgo CFLAGS: -Dchanged\nfunc B() int { return 2 }\n'],
  ])('rejects %s under the opt-in Go trace source policy', (_label, source) => {
    const fixture = createFixture();
    try {
      fs.writeFileSync(path.join(fixture.writerRoot, 'b.go'), source, 'utf8');
      const before = canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths]);
      const result = promoteNativeDelta({...promotionInput(fixture), sourceWritePolicy: 'go-trace-annotations-only'});
      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/trace source policy|bounded trace annotation scanner/);
      expect(canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ['deletion', (fixture: ReturnType<typeof createFixture>) => fs.rmSync(path.join(fixture.writerRoot, 'b.go'))],
    ['symlink', (fixture: ReturnType<typeof createFixture>) => {
      fs.rmSync(path.join(fixture.writerRoot, 'b.go'));
      fs.symlinkSync('a.go', path.join(fixture.writerRoot, 'b.go'));
    }],
    ['new Go file', (fixture: ReturnType<typeof createFixture>) => {
      fixture.workItem.sorted_owned_paths = ['c.go'];
      fs.writeFileSync(path.join(fixture.writerRoot, 'c.go'), 'package native\nfunc C() int { return 2 }\n', 'utf8');
    }],
    ['renamed Go file', (fixture: ReturnType<typeof createFixture>) => {
      fixture.workItem.sorted_owned_paths = ['c.go'];
      fs.renameSync(path.join(fixture.writerRoot, 'b.go'), path.join(fixture.writerRoot, 'c.go'));
    }],
    ['non-Go owned source', (fixture: ReturnType<typeof createFixture>) => {
      fixture.workItem.sorted_owned_paths = ['b.txt'];
      fs.writeFileSync(path.join(fixture.writerRoot, 'b.txt'), 'owned non-Go source\n', 'utf8');
    }],
  ])('rejects %s source shape under the opt-in Go trace source policy', (_label, mutate) => {
    const fixture = createFixture();
    try {
      mutate(fixture);
      const result = promoteNativeDelta({...promotionInput(fixture), sourceWritePolicy: 'go-trace-annotations-only'});
      expect(result.status).toBe('rejected');
      expect(result.rejected_paths.length).toBeGreaterThan(0);
      expect(result.reason).toMatch(/Go trace source policy|out-of-scope|deleted|symlink|regular/);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('promotes a grounded current component requirement annotation under the opt-in policy', () => {
    const fixture = createFixture();
    try {
      const listed = JSON.parse(proof(fixture.writerRoot, ['req', 'list', '--component', 'component_b', '--format', 'json'])) as Array<{id?: string; file_path?: string}>;
      const row = listed.find(candidate => candidate.file_path === fixture.componentBRequirementPath && typeof candidate.id === 'string');
      if (!row?.id) throw new Error('fixture Proof req list did not return the current component_b requirement ID');
      const source = `package native\n// Implements: ${row.id}\nfunc B() int { return 2 }\n`;
      fs.writeFileSync(path.join(fixture.writerRoot, 'b.go'), source, 'utf8');
      const headBefore = git(fixture.canonicalRoot, ['rev-parse', 'HEAD']);

      const result = promoteNativeDelta({...promotionInput(fixture), sourceWritePolicy: 'go-trace-annotations-only'});

      expect(result.status).toBe('promoted');
      expect(result.accepted_paths).toEqual(['b.go']);
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, 'b.go'), 'utf8')).toBe(source);
      expect(git(fixture.canonicalRoot, ['rev-parse', 'HEAD'])).not.toBe(headBefore);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects an unknown source-write policy before changing canonical state', () => {
    const fixture = createFixture();
    try {
      const before = canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths]);
      const result = promoteNativeDelta({
        ...promotionInput(fixture),
        sourceWritePolicy: 'bogus-policy',
      } as unknown as NativePromotionInput);
      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/unsupported native source write policy/);
      expect(canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('promotes only the component-B native delta and preserves component A', () => {
    const fixture = createFixture();
    try {
      const aBefore = canonicalBytes(fixture.canonicalRoot, ['a.go']);
      const untouchedBefore = canonicalBytes(fixture.canonicalRoot, fixture.untouchedNativePaths);
      fs.writeFileSync(path.join(fixture.writerRoot, 'b.go'), 'package native\n// B annotation\nfunc B() int { return 2 }\n');
      const reqFile = path.basename(fixture.componentBRequirementPath);
      const reqAbsolute = path.join(fixture.writerRoot, fixture.componentBRequirementPath);
      fs.appendFileSync(reqAbsolute, '\n# promoted native annotation\n');
      const varsFile = path.join(fixture.writerRoot, 'specs/system/variables/component_b.vars.yaml');
      fs.appendFileSync(varsFile, '# component-B native annotation\n');

      const result = promoteNativeDelta(promotionInput(fixture));
      expect(result.status).toBe('promoted');
      expect(result.accepted_paths.sort()).toEqual(
        ['b.go', `specs/system/requirements/${reqFile}`, 'specs/system/variables/component_b.vars.yaml'].sort()
      );
      expect(canonicalBytes(fixture.canonicalRoot, ['a.go']).get('a.go')).toEqual(aBefore.get('a.go'));
      expect(canonicalBytes(fixture.canonicalRoot, fixture.untouchedNativePaths)).toEqual(untouchedBefore);
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, 'b.go'), 'utf8')).toContain('// B annotation');
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, 'b.go'), 'utf8')).toContain('return 2');
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(git(fixture.canonicalRoot, ['log', '-1', '--format=%s'])).toContain('promote native component_b artifacts');
    } finally {
      fixture.cleanup();
    }
  });

  it('ignores a forward-only Proof checklist timestamp refresh without copying it', () => {
    const fixture = createFixture();
    try {
      const writerState = path.join(fixture.writerRoot, fixture.checklistStatePath);
      const canonicalState = path.join(fixture.canonicalRoot, fixture.checklistStatePath);
      if (!fs.existsSync(writerState) || !fs.existsSync(canonicalState)) {
        throw new Error('Proof fixture did not create the canonical checklist state file');
      }
      const canonicalBefore = fs.readFileSync(canonicalState);
      const refreshed = fs.readFileSync(writerState, 'utf8')
        .replace(/^(updated_at:\s*["']).*?(["']\s*)$/m, (_match, prefix, suffix) => `${prefix}2099-01-01T00:00:00Z${suffix}`)
        .replace(/^(\s+at:\s*["']).*?(["']\s*)$/gm, (_match, prefix, suffix) => `${prefix}2099-01-01T00:00:00Z${suffix}`);
      if (refreshed === fs.readFileSync(writerState, 'utf8')) throw new Error('fixture state has no timestamp leaves');
      fs.writeFileSync(writerState, refreshed, 'utf8');
      fs.writeFileSync(path.join(fixture.writerRoot, 'b.go'), 'package native\n// timestamp-only checklist refresh\nfunc B() int { return 2 }\n');

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('promoted');
      expect(result.ignored_paths).toContain(fixture.checklistStatePath);
      expect(result.accepted_paths).not.toContain(fixture.checklistStatePath);
      expect(fs.readFileSync(canonicalState)).toEqual(canonicalBefore);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('promotes a Proof-owned regular variable file with exact same-component aliases', () => {
    const fixture = createFixture();
    try {
      const target = 'specs/system/variables/component_b.vars.yaml';
      const aliases = [
        'specs/stakeholder/variables/component_b.vars.yaml',
        'specs/software/variables/component_b.vars.yaml',
        'specs/integration/variables/component_b.vars.yaml',
      ];
      for (const alias of aliases) fs.mkdirSync(path.dirname(path.join(fixture.writerRoot, alias)), {recursive: true});
      for (const alias of aliases) {
        fs.symlinkSync('../../system/variables/component_b.vars.yaml', path.join(fixture.writerRoot, alias));
      }
      fs.appendFileSync(path.join(fixture.writerRoot, target), '\n# component-B alias promotion\n');

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('promoted');
      expect(result.accepted_paths.sort()).toEqual([target, ...aliases].sort());
      const targetBytes = fs.readFileSync(path.join(fixture.canonicalRoot, target));
      for (const alias of aliases) {
        const aliasPath = path.join(fixture.canonicalRoot, alias);
        expect(fs.lstatSync(aliasPath).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(aliasPath)).toBe('../../system/variables/component_b.vars.yaml');
        expect(fs.readFileSync(aliasPath)).toEqual(targetBytes);
        expect(git(fixture.canonicalRoot, ['ls-tree', 'HEAD', '--', alias])).toMatch(/^120000\s/);
      }
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('promotes aliases when their Proof-owned regular target is unchanged at the baseline', () => {
    const fixture = createFixture();
    const alias = 'specs/software/variables/component_b.vars.yaml';
    const target = 'specs/system/variables/component_b.vars.yaml';
    try {
      const aliasPath = path.join(fixture.writerRoot, alias);
      fs.mkdirSync(path.dirname(aliasPath), {recursive: true});
      fs.symlinkSync('../../system/variables/component_b.vars.yaml', aliasPath);

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('promoted');
      expect(result.accepted_paths).toEqual([alias]);
      expect(fs.readlinkSync(path.join(fixture.canonicalRoot, alias))).toBe('../../system/variables/component_b.vars.yaml');
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, target))).toEqual(
        fs.readFileSync(path.join(fixture.writerRoot, target))
      );
      expect(git(fixture.canonicalRoot, ['ls-tree', 'HEAD', '--', alias])).toMatch(/^120000\s/);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ['unreported projection', 'specs/other/component_b.vars.yaml', '../system/variables/component_b.vars.yaml'],
    ['absolute target', 'specs/software/variables/component_b.vars.yaml', '/tmp/component_b.vars.yaml'],
    ['escaping target', 'specs/software/variables/component_b.vars.yaml', '../../../../outside.vars.yaml'],
    ['dangling target', 'specs/software/variables/component_b.vars.yaml', '../../system/variables/missing.vars.yaml'],
    ['cross-component target', 'specs/software/variables/component_b.vars.yaml', '../../system/variables/component_a.vars.yaml'],
  ])('rejects a %s alias without changing canonical data', (_label, alias, target) => {
    const fixture = createFixture();
    try {
      const aliasPath = path.join(fixture.writerRoot, alias);
      fs.mkdirSync(path.dirname(aliasPath), {recursive: true});
      fs.symlinkSync(target, aliasPath);
      const canonicalBefore = canonicalBytes(fixture.canonicalRoot, [
        'b.go',
        fixture.componentBRequirementPath,
        'specs/system/variables/component_b.vars.yaml',
      ]);

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      if (_label === 'unreported projection') {
        expect(result.reason).toMatch(/not an owned variable projection for component component_b/);
      } else {
        expect(result.reason).toMatch(/alias|outside|escapes|owned|no such file|rebuilding index/);
      }
      expect(canonicalBytes(fixture.canonicalRoot, [
        'b.go',
        fixture.componentBRequirementPath,
        'specs/system/variables/component_b.vars.yaml',
      ])).toEqual(canonicalBefore);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('compares an existing canonical alias by exact Git link text before promotion', () => {
    const fixture = createFixture({seedComponentBAliases: true});
    const alias = 'specs/software/variables/component_b.vars.yaml';
    try {
      const writerAlias = path.join(fixture.writerRoot, alias);
      fs.unlinkSync(writerAlias);
      fs.symlinkSync('./../../system/variables/component_b.vars.yaml', writerAlias);
      const canonicalAlias = path.join(fixture.canonicalRoot, alias);
      fs.unlinkSync(canonicalAlias);
      fs.symlinkSync('./../../system/variables/component_b.vars.yaml', canonicalAlias);
      git(fixture.canonicalRoot, ['add', '--', alias]);
      git(fixture.canonicalRoot, ['commit', '--quiet', '-m', 'canonical alias changed']);
      const canonicalHeadBefore = git(fixture.canonicalRoot, ['rev-parse', 'HEAD']);
      const canonicalLinkBefore = fs.readlinkSync(canonicalAlias);

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/canonical path .*changed after writer baseline/);
      expect(fs.readlinkSync(canonicalAlias)).toBe(canonicalLinkBefore);
      expect(git(fixture.canonicalRoot, ['rev-parse', 'HEAD'])).toBe(canonicalHeadBefore);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a non-variable symlink in an owned source path without writing canonical data', () => {
    const fixture = createFixture();
    try {
      const before = canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths]);
      fs.rmSync(path.join(fixture.writerRoot, 'b.go'));
      fs.symlinkSync('a.go', path.join(fixture.writerRoot, 'b.go'));

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/symlink/);
      expect(canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a symlink-parent path before it can reach canonical promotion', () => {
    const fixture = createFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-promotion-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'component_b.vars.yaml'), 'outside native data\n');
      fs.symlinkSync(outside, path.join(fixture.writerRoot, 'escaped-parent'), 'dir');
      const before = canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths]);

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.rejected_paths).toContain('escaped-parent');
      expect(canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
      fs.rmSync(outside, {recursive: true, force: true});
    }
  });

  it('rejects sibling deletion and global changes without changing canonical bytes', () => {
    const fixture = createFixture();
    try {
      const before = canonicalBytes(fixture.canonicalRoot, ['a.go', 'proof.yaml', ...fixture.untouchedNativePaths]);
      fs.rmSync(path.join(fixture.writerRoot, 'a.go'));
      fs.appendFileSync(path.join(fixture.writerRoot, 'proof.yaml'), '\n# forbidden global change\n');

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.rejected_paths).toEqual(expect.arrayContaining(['a.go', 'proof.yaml']));
      expect(canonicalBytes(fixture.canonicalRoot, ['a.go', 'proof.yaml', ...fixture.untouchedNativePaths])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects relabeling existing component-A native files as component B', () => {
    const fixture = createFixture();
    try {
      const [componentARequirementPath, componentAVariablePath, checklistPath] = fixture.untouchedNativePaths;
      const before = canonicalBytes(fixture.canonicalRoot, [componentARequirementPath, componentAVariablePath, checklistPath]);
      const requirementPath = path.join(fixture.writerRoot, componentARequirementPath);
      const variablePath = path.join(fixture.writerRoot, componentAVariablePath);
      fs.writeFileSync(
        requirementPath,
        fs.readFileSync(requirementPath, 'utf8').replace('component: component_a', 'component: component_b')
      );
      fs.writeFileSync(
        variablePath,
        fs.readFileSync(variablePath, 'utf8').replace('component: component_a', 'component: component_b')
      );

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/not already owned|writer baseline/);
      expect(result.rejected_paths).toEqual(expect.arrayContaining([componentARequirementPath, componentAVariablePath]));
      expect(canonicalBytes(fixture.canonicalRoot, [componentARequirementPath, componentAVariablePath, checklistPath])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('ignores only the Proof private index files and rejects other .proof paths', () => {
    const fixture = createFixture();
    try {
      fs.mkdirSync(path.join(fixture.writerRoot, '.proof'), {recursive: true});
      fs.writeFileSync(path.join(fixture.writerRoot, '.proof/index.db'), 'private cache\n');
      fs.writeFileSync(path.join(fixture.writerRoot, '.proof/author-note.md'), 'not a private cache\n');
      git(fixture.writerRoot, ['add', '--intent-to-add', '-f', '--', '.proof/index.db', '.proof/author-note.md']);

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.ignored_paths).toContain('.proof/index.db');
      expect(result.rejected_paths).toContain('.proof/author-note.md');
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('retains the exact Proof validation failure and leaves canonical state untouched', () => {
    const fixture = createFixture();
    try {
      const before = canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths]);
      const varsFile = path.join(fixture.writerRoot, 'specs/system/variables/component_b.vars.yaml');
      const invalid = fs.readFileSync(varsFile, 'utf8').replace(
        /(- name: state\n)/,
        '$1      proof_auxiliary: true\n'
      );
      fs.writeFileSync(varsFile, invalid);

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/validation failed|Proof req show|staging/);
      expect(result.validation?.status).not.toBe(0);
      expect(result.validation?.stdout).toContain('proof_auxiliary');
      expect(canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a stale or dirty canonical baseline before staging', () => {
    const fixture = createFixture();
    try {
      const stale = promoteNativeDelta({...promotionInput(fixture), baselineCommit: '0'.repeat(40)});
      expect(stale.status).toBe('rejected');
      expect(stale.reason).toMatch(/baseline|pinned|commit/);

      fs.writeFileSync(path.join(fixture.canonicalRoot, 'untracked-native-promotion.txt'), 'caller data\n');
      const dirty = promoteNativeDelta(promotionInput(fixture));
      expect(dirty.status).toBe('rejected');
      expect(dirty.reason).toMatch(/clean|dirty/);
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, 'untracked-native-promotion.txt'), 'utf8')).toBe('caller data\n');
    } finally {
      fixture.cleanup();
    }
  });

  it('promotes B from its original baseline after an unrelated A promotion', () => {
    const fixture = createFixture();
    try {
      fs.writeFileSync(path.join(fixture.canonicalRoot, 'a.go'), 'package native\n// A was promoted first\nfunc A() int { return 1 }\n');
      git(fixture.canonicalRoot, ['add', '--', 'a.go']);
      git(fixture.canonicalRoot, ['commit', '--quiet', '-m', 'promote component_a']);
      const aAfter = fs.readFileSync(path.join(fixture.canonicalRoot, 'a.go'));
      const untouchedAfterA = canonicalBytes(fixture.canonicalRoot, fixture.untouchedNativePaths);

      fs.writeFileSync(path.join(fixture.writerRoot, 'b.go'), 'package native\n// B annotation from C0\nfunc B() int { return 2 }\n');
      fs.appendFileSync(path.join(fixture.writerRoot, fixture.componentBRequirementPath), '\n# B native annotation from C0\n');
      fs.appendFileSync(path.join(fixture.writerRoot, 'specs/system/variables/component_b.vars.yaml'), '\n# B variable annotation from C0\n');

      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('promoted');
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, 'a.go'))).toEqual(aAfter);
      expect(canonicalBytes(fixture.canonicalRoot, fixture.untouchedNativePaths)).toEqual(untouchedAfterA);
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, 'b.go'), 'utf8')).toContain('B annotation from C0');
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a conflicting canonical B edit without writing it', () => {
    const fixture = createFixture();
    try {
      fs.writeFileSync(path.join(fixture.canonicalRoot, 'b.go'), 'package native\n// canonical B edit\nfunc B() int { return 2 }\n');
      git(fixture.canonicalRoot, ['add', '--', 'b.go']);
      git(fixture.canonicalRoot, ['commit', '--quiet', '-m', 'promote another component_b edit']);
      const before = canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths]);

      fs.writeFileSync(path.join(fixture.writerRoot, 'b.go'), 'package native\n// conflicting writer B edit\nfunc B() int { return 2 }\n');
      const result = promoteNativeDelta(promotionInput(fixture));

      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/changed after writer baseline|conflicting/);
      expect(result.rejected_paths).toContain('b.go');
      expect(canonicalBytes(fixture.canonicalRoot, ['b.go', ...fixture.untouchedNativePaths])).toEqual(before);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('throws an interrupted apply after canonical bytes have begun changing', () => {
    const fixture = createFixture();
    try {
      const untouchedBefore = canonicalBytes(fixture.canonicalRoot, fixture.untouchedNativePaths);
      fs.writeFileSync(path.join(fixture.writerRoot, 'b.go'), 'package native\n// B apply interrupted\nfunc B() int { return 2 }\n');
      const reqAbsolute = path.join(fixture.writerRoot, fixture.componentBRequirementPath);
      fs.appendFileSync(reqAbsolute, '\n# apply failure after source copy\n');
      const canonicalReq = path.join(fixture.canonicalRoot, fixture.componentBRequirementPath);
      const canonicalReqMode = fs.statSync(canonicalReq).mode & 0o777;
      fs.chmodSync(canonicalReq, 0o444);
      try {
        expect(() => promoteNativeDelta(promotionInput(fixture))).toThrow(
          /native promotion apply interrupted after canonical writes began/
        );
      } finally {
        fs.chmodSync(canonicalReq, canonicalReqMode);
      }
      expect(fs.readFileSync(path.join(fixture.canonicalRoot, 'b.go'), 'utf8')).toContain('B apply interrupted');
      expect(canonicalBytes(fixture.canonicalRoot, fixture.untouchedNativePaths)).toEqual(untouchedBefore);
      expect(git(fixture.canonicalRoot, ['status', '--porcelain', '--untracked-files=all'])).toMatch(/b\.go/);
    } finally {
      fixture.cleanup();
    }
  });
});
