import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import yaml from 'js-yaml';
import {createExtendedLiquid} from '../../src/liquid-extensions';
import {pinNativeOnboardingTsProject} from '../../examples/agent-governance/native-onboarding/run-onboarding';

type Json = Record<string, any>;

const CONFIG_PATH = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/visor-onboarding.yaml');
const TS_NODE = require.resolve('ts-node/register/transpile-only');

function promotionExec(): string {
  const config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as Json;
  return config.subgraphs['onboard-component'].checks['promote-native-component'].exec as string;
}

function fixtureDeps(componentId = 'component-b'): Json {
  return {
    work_item: {
      component_id: componentId,
      baseline_commit: 'a'.repeat(40),
      sorted_owned_paths: ['b.go'],
    },
    checkout: {
      success: true,
      is_worktree: true,
      path: '/tmp/writer-checkout',
      commit: 'a'.repeat(40),
      worktree_id: 'writer-b',
    },
    author: {status: 'authored'},
  };
}

function encodedComponent(componentId: string): string {
  return Buffer.from(componentId, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stubRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-promotion-wrapper-stub-'));
  const moduleDir = path.join(root, 'examples/agent-governance/native-onboarding');
  fs.mkdirSync(moduleDir, {recursive: true});
  fs.writeFileSync(path.join(moduleDir, 'native-promotion.ts'), `
    const fs = require('node:fs');
    module.exports.promoteNativeDelta = function (input) {
      if (process.env.NATIVE_PROMOTION_STUB_MARKER) {
        fs.writeFileSync(process.env.NATIVE_PROMOTION_STUB_MARKER, 'called');
      }
      if (process.env.NATIVE_PROMOTION_STUB_MODE === 'throw') {
        throw new Error('native prevalidation failed: writer state unavailable');
      }
      const status = process.env.NATIVE_PROMOTION_STUB_MODE;
      return {
        status,
        reason: status === 'promoted' ? 'accepted native delta' : 'native validation rejected delta',
        accepted_paths: status === 'promoted' ? ['b.go'] : [],
        rejected_paths: status === 'promoted' ? [] : ['b.go'],
        native_validation: {status: status === 'promoted' ? 'passed' : 'failed'},
        identity: {component_id: input.workItem.component_id},
        checkpoint: {baseline_commit: input.baselineCommit},
      };
    };
  `);
  return root;
}

type WrapperOptions = {outputDir?: string; omitOutputDir?: boolean; tsNodeProject?: string};

async function runWrapper(mode: 'promoted' | 'rejected' | 'throw', deps = fixtureDeps(), options: WrapperOptions = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-promotion-wrapper-run-'));
  const outputDir = path.join(parent, 'output');
  const canonicalSentinel = path.join(parent, 'canonical-sentinel');
  fs.writeFileSync(canonicalSentinel, 'unchanged');
  const repoRoot = stubRoot();
  const rendered = await createExtendedLiquid().parseAndRender(promotionExec(), {outputs: deps});
  const markerPath = path.join(repoRoot, 'promotion-called');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NATIVE_ONBOARDING_TS_NODE: TS_NODE,
    NATIVE_ONBOARDING_REPO_ROOT: repoRoot,
    NATIVE_ONBOARDING_OUTPUT_DIR: options.outputDir ?? outputDir,
    VISOR_WORKSPACE_MAIN_PROJECT: parent,
    PROOF_BIN: path.join(parent, 'proof'),
    REQUEST_TIMEOUT: '120000',
    NATIVE_PROMOTION_STUB_MODE: mode,
    NATIVE_PROMOTION_STUB_MARKER: markerPath,
    TS_NODE_TRANSPILE_ONLY: '1',
    TS_NODE_PROJECT: options.tsNodeProject ?? path.resolve(__dirname, '../../tsconfig.json'),
  };
  if (options.omitOutputDir) delete env.NATIVE_ONBOARDING_OUTPUT_DIR;
  const result = spawnSync('sh', ['-c', rendered], {
    cwd: parent,
    encoding: 'utf8',
    env,
  });
  const componentId = deps.work_item && typeof deps.work_item.component_id === 'string' && deps.work_item.component_id.length > 0 && Buffer.byteLength(deps.work_item.component_id, 'utf8') <= 180 ? deps.work_item.component_id : 'unknown';
  return {
    parent,
    repoRoot,
    outputDir,
    canonicalSentinel,
    result,
    markerPath,
    recordPath: path.join(outputDir, 'promotion-results', `${encodedComponent(componentId)}.json`),
  };
}

function dispose(run: Awaited<ReturnType<typeof runWrapper>>): void {
  fs.rmSync(run.parent, {recursive: true, force: true});
  fs.rmSync(run.repoRoot, {recursive: true, force: true});
}

describe('native onboarding promotion command wrapper', () => {
  it('persists the exact rejected result before preserving stdout and exit status', async () => {
    const run = await runWrapper('rejected', fixtureDeps('../component-b'));
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.signal).toBeNull();
      expect(run.result.stderr).toBe('');
      expect(fs.readFileSync(run.recordPath, 'utf8')).toBe(run.result.stdout);
      expect(JSON.parse(fs.readFileSync(run.recordPath, 'utf8'))).toEqual({
        status: 'rejected',
        reason: 'native validation rejected delta',
        accepted_paths: [],
        rejected_paths: ['b.go'],
        native_validation: {status: 'failed'},
        identity: {component_id: '../component-b'},
        checkpoint: {baseline_commit: 'a'.repeat(40)},
        component_id: '../component-b',
        baseline_commit: 'a'.repeat(40),
      });
      expect(fs.statSync(run.recordPath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(run.outputDir)).toEqual(['promotion-results']);
    } finally {
      dispose(run);
    }
  });

  it('persists promoted output without changing the successful result', async () => {
    const run = await runWrapper('promoted');
    try {
      expect(run.result.status).toBe(0);
      expect(run.result.signal).toBeNull();
      expect(run.result.stderr).toBe('');
      expect(fs.readFileSync(run.recordPath, 'utf8')).toBe(run.result.stdout);
      expect(JSON.parse(run.result.stdout)).toEqual(expect.objectContaining({status: 'promoted', component_id: 'component-b'}));
      expect(fs.statSync(run.recordPath).mode & 0o777).toBe(0o600);
    } finally {
      dispose(run);
    }
  });

  it('pins the Visor TypeScript project for a child wrapper from an arbitrary cwd', async () => {
    const hostileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-promotion-hostile-tsconfig-'));
    const hostileProject = path.join(hostileRoot, 'tsconfig.json');
    fs.writeFileSync(hostileProject, JSON.stringify({
      compilerOptions: {module: 'NodeNext', moduleResolution: 'Classic', target: 'ES2022'},
    }));
    const previousProject = process.env.TS_NODE_PROJECT;
    try {
      const unpinned = await runWrapper('promoted', fixtureDeps(), {tsNodeProject: hostileProject});
      try {
        expect(unpinned.result.status).toBe(1);
        expect(unpinned.result.stderr).toContain('TS5109');
        expect(fs.existsSync(unpinned.markerPath)).toBe(false);
      } finally {
        dispose(unpinned);
      }

      process.env.TS_NODE_PROJECT = hostileProject;
      const pinnedProject = pinNativeOnboardingTsProject();
      expect(pinnedProject).toBe(path.resolve(__dirname, '../../tsconfig.json'));
      expect(process.env.TS_NODE_PROJECT).toBe(pinnedProject);
      const pinned = await runWrapper('promoted', fixtureDeps(), {tsNodeProject: pinnedProject});
      try {
        expect(pinned.result.status).toBe(0);
        expect(pinned.result.stderr).toBe('');
        expect(fs.existsSync(pinned.markerPath)).toBe(true);
        expect(fs.readFileSync(pinned.recordPath, 'utf8')).toBe(pinned.result.stdout);
      } finally {
        dispose(pinned);
      }
    } finally {
      if (previousProject === undefined) delete process.env.TS_NODE_PROJECT;
      else process.env.TS_NODE_PROJECT = previousProject;
      fs.rmSync(hostileRoot, {recursive: true, force: true});
    }
  });

  it('records bounded thrown prevalidation errors and keeps the command failed', async () => {
    const run = await runWrapper('throw');
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.signal).toBeNull();
      expect(run.result.stdout).toBe('');
      expect(run.result.stderr).toContain('native prevalidation failed: writer state unavailable');
      expect(JSON.parse(fs.readFileSync(run.recordPath, 'utf8'))).toEqual({
        status: 'failed',
        reason: 'promotion wrapper failed',
        error: 'native prevalidation failed: writer state unavailable',
        component_id: 'component-b',
      });
      expect(fs.statSync(run.recordPath).mode & 0o777).toBe(0o600);
    } finally {
      dispose(run);
    }
  });

  it.each([
    ['missing WorkItem', {...fixtureDeps(), work_item: undefined}],
    ['empty component ID', fixtureDeps('')],
  ])('records the original validation error for %s under unknown.json', async (_label, deps) => {
    const run = await runWrapper('promoted', deps);
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stdout).toBe('');
      expect(run.result.stderr).toContain('promotion is missing the prepared WorkItem');
      expect(JSON.parse(fs.readFileSync(run.recordPath, 'utf8'))).toEqual({
        status: 'failed',
        reason: 'promotion wrapper failed',
        error: 'promotion is missing the prepared WorkItem',
        component_id: 'unknown',
      });
      expect(fs.existsSync(run.markerPath)).toBe(false);
    } finally {
      dispose(run);
    }
  });

  it.each([
    ['relative output directory', {outputDir: 'relative-output'}],
    ['missing output directory', {omitOutputDir: true}],
  ])('does not invoke promotion for %s', async (_label, options) => {
    const run = await runWrapper('promoted', fixtureDeps(), options);
    try {
      expect(run.result.status).toBe(1);
      expect(run.result.stdout).toBe('');
      expect(run.result.stderr).toContain('NATIVE_ONBOARDING_OUTPUT_DIR must be an absolute path');
      expect(fs.existsSync(run.markerPath)).toBe(false);
      expect(fs.readFileSync(run.canonicalSentinel, 'utf8')).toBe('unchanged');
      expect(fs.existsSync(run.outputDir)).toBe(false);
    } finally {
      dispose(run);
    }
  });
});
