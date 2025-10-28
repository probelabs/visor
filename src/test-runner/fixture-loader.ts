export type BuiltinFixtureName =
  | 'gh.pr_open.minimal'
  | 'gh.pr_sync.minimal'
  | 'gh.issue_open.minimal'
  | 'gh.issue_comment.standard'
  | 'gh.issue_comment.visor_help'
  | 'gh.issue_comment.visor_regenerate'
  | 'gh.issue_comment.edited'
  | 'gh.pr_closed.minimal';

export interface LoadedFixture {
  name: string;
  webhook: { name: string; action?: string; payload: Record<string, unknown> };
  git?: { branch?: string; baseBranch?: string };
  files?: Array<{
    path: string;
    content: string;
    status?: 'added' | 'modified' | 'removed' | 'renamed';
    additions?: number;
    deletions?: number;
  }>;
  diff?: string; // unified diff text
  env?: Record<string, string>;
  time?: { now?: string };
}

export class FixtureLoader {
  load(name: BuiltinFixtureName): LoadedFixture {
    // Minimal, stable, general-purpose fixtures used by the test runner.
    // All fixtures supply a webhook payload and, for PR variants, a small diff.
    if (name.startsWith('gh.pr_open')) {
      const files: LoadedFixture['files'] = [
        {
          path: 'src/search.ts',
          content: 'export function search(q: string) {\n  return []\n}\n',
          status: 'added',
          additions: 3,
          deletions: 0,
        },
      ];
      const diff = this.buildUnifiedDiff(files);
      return {
        name,
        webhook: {
          name: 'pull_request',
          action: 'opened',
          payload: { pull_request: { number: 1, title: 'feat: add user search' } },
        },
        git: { branch: 'feature/test', baseBranch: 'main' },
        files,
        diff,
      };
    }
    if (name.startsWith('gh.pr_sync')) {
      const files: LoadedFixture['files'] = [
        {
          path: 'src/search.ts',
          content: 'export function search(q: string) {\n  return [q] // updated\n}\n',
          status: 'modified',
          additions: 1,
          deletions: 0,
        },
      ];
      const diff = this.buildUnifiedDiff(files);
      return {
        name,
        webhook: {
          name: 'pull_request',
          action: 'synchronize',
          payload: { pull_request: { number: 1, title: 'feat: add user search (update)' } },
        },
        git: { branch: 'feature/test', baseBranch: 'main' },
        files,
        diff,
      };
    }
    if (name.startsWith('gh.issue_open')) {
      return {
        name,
        webhook: {
          name: 'issues',
          action: 'opened',
          payload: {
            issue: { number: 12, title: 'Bug: crashes on search edge case', body: 'Steps...' },
          },
        },
      };
    }
    if (name === 'gh.issue_comment.standard') {
      return {
        name,
        webhook: {
          name: 'issue_comment',
          action: 'created',
          payload: { comment: { body: 'Thanks for the update!' }, issue: { number: 1 } },
        },
      };
    }
    if (name === 'gh.issue_comment.visor_help') {
      return {
        name,
        webhook: {
          name: 'issue_comment',
          action: 'created',
          payload: { comment: { body: '/visor help' }, issue: { number: 1 } },
        },
      };
    }
    if (name === 'gh.issue_comment.visor_regenerate') {
      return {
        name,
        webhook: {
          name: 'issue_comment',
          action: 'created',
          payload: { comment: { body: '/visor Regenerate reviews' }, issue: { number: 1 } },
        },
      };
    }
    if (name === 'gh.pr_closed.minimal') {
      return {
        name,
        webhook: {
          name: 'pull_request',
          action: 'closed',
          payload: { pull_request: { number: 1, title: 'feat: add user search' } },
        },
      };
    }
    // Fallback minimal
    return {
      name,
      webhook: { name: 'unknown', payload: {} },
    };
  }

  private buildUnifiedDiff(
    files: Array<{ path: string; content: string; status?: string }>
  ): string {
    // Build a very small, stable unified diff suitable for prompts
    const chunks = files.map(f => {
      const header =
        `diff --git a/${f.path} b/${f.path}\n` +
        (f.status === 'added'
          ? 'index 0000000..1111111 100644\n--- /dev/null\n'
          : `index 1111111..2222222 100644\n--- a/${f.path}\n`) +
        `+++ b/${f.path}\n` +
        '@@\n';
      const body = f.content
        .split('\n')
        .map(line => (f.status === 'removed' ? `-${line}` : `+${line}`))
        .join('\n');
      return header + body + '\n';
    });
    return chunks.join('\n');
  }
}
