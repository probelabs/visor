import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { AIReviewService } from '../../src/ai-review-service';
import type { PRInfo } from '../../src/pr-analyzer';
import type { VisorConfig } from '../../src/types/config';

const prInfo = {
  number: 902,
  title: 'Generated isolated writer context',
  author: 'test',
  base: 'main',
  head: 'candidate',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

type Checkout = {
  success: true;
  path: string;
  ref: string;
  commit: string;
  worktree_id: string;
  repository: string;
  is_worktree: true;
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeGitFixture(): {
  canonicalRoot: string;
  writerRoot: string;
  commit: string;
  checkout: Checkout;
  dispose: () => void;
} {
  const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-generated-writer-canonical-'));
  const writerParent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-generated-writer-parent-'));
  const writerRoot = path.join(writerParent, 'component-one');
  git(canonicalRoot, ['init', '--quiet']);
  git(canonicalRoot, ['config', 'user.email', 'test@example.invalid']);
  git(canonicalRoot, ['config', 'user.name', 'Visor test']);
  fs.writeFileSync(path.join(canonicalRoot, 'README.md'), 'canonical fixture\n');
  git(canonicalRoot, ['add', 'README.md']);
  git(canonicalRoot, ['commit', '--quiet', '-m', 'baseline']);
  const commit = git(canonicalRoot, ['rev-parse', 'HEAD']);
  git(canonicalRoot, ['worktree', 'add', '--quiet', '--detach', writerRoot, commit]);
  const checkout: Checkout = {
    success: true,
    path: fs.realpathSync(writerRoot),
    ref: commit,
    commit,
    worktree_id: 'component-one',
    repository: fs.realpathSync(canonicalRoot),
    is_worktree: true,
  };
  return {
    canonicalRoot: fs.realpathSync(canonicalRoot),
    writerRoot: fs.realpathSync(writerRoot),
    commit,
    checkout,
    dispose: () => {
      try {
        git(canonicalRoot, ['worktree', 'remove', '--force', writerRoot]);
      } catch {}
      fs.rmSync(writerParent, { recursive: true, force: true });
      fs.rmSync(canonicalRoot, { recursive: true, force: true });
    },
  };
}

function configFor(checkout: Checkout): VisorConfig {
  return {
    version: '1.0',
    max_parallelism: 1,
    workspace: { enabled: false },
    claim_types: {
      'fixture.catalog@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: { id: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
      },
      'fixture.item@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
      'component.checkout@1': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'success',
            'path',
            'ref',
            'commit',
            'worktree_id',
            'repository',
            'is_worktree',
          ],
          properties: {
            success: { const: true },
            path: { type: 'string', minLength: 1 },
            ref: { type: 'string', minLength: 1 },
            commit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
            worktree_id: { type: 'string', minLength: 1 },
            repository: { type: 'string', minLength: 1 },
            is_worktree: { const: true },
          },
        },
      },
    },
    subgraphs: {
      'writer-pipeline': {
        input: { name: 'component', claim: 'fixture.item@1' },
        checks: {
          checkout: {
            type: 'memory',
            operation: 'set',
            key: 'generated-isolated-writer-checkout',
            value: checkout,
            consumes: [{ claim: 'fixture.item@1', as: 'component' }],
            emits: [{ claim: 'component.checkout@1', from: 'output' }],
          },
          writer: {
            type: 'ai',
            prompt: 'Inspect the component and report the result.',
            depends_on: ['checkout'],
            consumes: [
              { claim: 'fixture.item@1', as: 'component' },
              { claim: 'component.checkout@1', as: 'checkout' },
            ],
            ai: {
              provider: 'codex',
              model: 'gpt-5.6-luna',
              codex_execution_profile: 'luna-xhigh-isolated-writer-v1',
              codex_working_directory_from: 'checkout',
              allowEdit: true,
              allowedTools: ['search', 'extract', 'listFiles'],
              timeout: 1000,
            },
          },
        },
      },
    },
    checks: {
      discover: {
        type: 'command',
        exec: `node -e 'process.stdout.write(JSON.stringify({items:[{id:"component-one"}]}))'`,
        emits: [{ claim: 'fixture.catalog@1', from: 'output' }],
        expand: {
          claim: 'fixture.catalog@1',
          template: 'writer-pipeline',
          items_pointer: '/items',
          key_pointer: '/id',
          item_claim: 'fixture.item@1',
        },
      },
    },
  } as unknown as VisorConfig;
}

async function executeFixture(checkout: Checkout, canonicalRoot: string) {
  const engine = new StateMachineExecutionEngine(canonicalRoot);
  await engine.executeGroupedChecks(
    prInfo,
    ['discover'],
    undefined,
    configFor(checkout),
    'table',
    false,
    1
  );
  return engine;
}

describe('Graph-v2 generated isolated writer context', () => {
  let originalExecuteReview: AIReviewService['executeReview'];

  beforeEach(() => {
    originalExecuteReview = AIReviewService.prototype.executeReview;
  });

  afterEach(() => {
    AIReviewService.prototype.executeReview = originalExecuteReview;
  });

  it('passes the engine-owned canonical root to a generated writer and binds service to the linked worktree', async () => {
    const fixture = makeGitFixture();
    const serviceConfigs: any[] = [];
    AIReviewService.prototype.executeReview = jest.fn(async function () {
      serviceConfigs.push((this as any).config);
      return { issues: [], output: { status: 'mocked' } } as any;
    }) as any;

    try {
      const run = await executeFixture(fixture.checkout, fixture.canonicalRoot);
      expect(
        (run as any)._lastContext.journal.readRuntimeEvents().some(
          (event: any) => event.type === 'AttemptCompleted' && event.checkId === 'writer'
        )
      ).toBe(true);
      expect(serviceConfigs).toHaveLength(1);
      expect(serviceConfigs[0]).toMatchObject({
        path: fixture.writerRoot,
        cwd: fixture.writerRoot,
        workspacePath: fixture.writerRoot,
        allowedFolders: [fixture.writerRoot],
        codexExecutionProfile: 'luna-xhigh-isolated-writer-v1',
        codexWorkingDirectoryFrom: 'checkout',
        model: 'gpt-5.6-luna',
        allowEdit: true,
      });
      expect(serviceConfigs[0].path).not.toBe(fixture.canonicalRoot);
      expect(serviceConfigs[0].allowedFolders).not.toContain(fixture.canonicalRoot);
    } finally {
      fixture.dispose();
    }
  });

  it('rejects a canonical-root checkout before invoking the model boundary', async () => {
    const fixture = makeGitFixture();
    const service = jest.fn(async function () {
      return { issues: [], output: { status: 'unexpected' } } as any;
    });
    AIReviewService.prototype.executeReview = service as any;
    try {
      for (const tampered of [
        { ...fixture.checkout, path: fixture.canonicalRoot },
        { ...fixture.checkout, path: path.join(fixture.canonicalRoot, 'missing-worktree') },
      ]) {
        const run = await executeFixture(tampered, fixture.canonicalRoot);
        expect(
          (run as any)._lastContext.journal.readRuntimeEvents().some(
            (event: any) => event.type === 'AttemptFailed' && event.checkId === 'writer'
          )
        ).toBe(true);
      }
      expect(service).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });
});
