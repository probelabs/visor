import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {
  promoteNativeDelta,
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
      'specs/software/variables/component_b.vars.yaml',
      'specs/integration/variables/component_b.vars.yaml',
    ]) {
      fs.mkdirSync(path.dirname(path.join(canonicalRoot, alias)), {recursive: true});
      fs.symlinkSync('../../system/variables/component_b.vars.yaml', path.join(canonicalRoot, alias));
    }
  }
  const checklistPath = '.proof/onboard-checklist-state.json';
  fs.mkdirSync(path.join(canonicalRoot, '.proof'), {recursive: true});
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
    untouchedNativePaths: [
      componentARequirement.file,
      'specs/system/variables/component_a.vars.yaml',
      checklistPath,
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

describeNative('native onboarding promotion boundary', () => {
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

  it('promotes a Proof-owned regular variable file with exact same-component aliases', () => {
    const fixture = createFixture();
    try {
      const target = 'specs/system/variables/component_b.vars.yaml';
      const aliases = [
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
    ['unreported projection', 'specs/other/component_b.vars.yaml', '../../system/variables/component_b.vars.yaml'],
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
      expect(result.reason).toMatch(/alias|outside|escapes|owned|no such file|rebuilding index/);
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
