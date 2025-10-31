import type { PRInfo } from '../../pr-analyzer';
import { FixtureLoader } from '../fixture-loader';

function deepSet(target: any, path: string, value: unknown): void {
  const parts: (string | number)[] = [];
  const regex = /\[(\d+)\]|\['([^']+)'\]|\["([^"]+)"\]|\.([^\.\[\]]+)/g;
  let m: RegExpExecArray | null;
  let cursor = 0;
  if (!path.startsWith('.') && !path.startsWith('[')) {
    const first = path.split('.')[0];
    parts.push(first);
    cursor = first.length;
  }
  while ((m = regex.exec(path)) !== null) {
    if (m.index !== cursor) continue;
    cursor = regex.lastIndex;
    if (m[1] !== undefined) parts.push(Number(m[1]));
    else if (m[2] !== undefined) parts.push(m[2]);
    else if (m[3] !== undefined) parts.push(m[3]);
    else if (m[4] !== undefined) parts.push(m[4]);
  }
  let obj = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as any;
    if (obj[key] == null || typeof obj[key] !== 'object') {
      obj[key] = typeof parts[i + 1] === 'number' ? [] : {};
    }
    obj = obj[key];
  }
  obj[parts[parts.length - 1] as any] = value;
}

export function buildPrInfoFromFixture(
  mapEventFromFixtureName: (fx?: string) => import('../../types/config').EventTrigger,
  fixtureName?: string,
  overrides?: Record<string, unknown>
): PRInfo {
  const eventType = mapEventFromFixtureName(fixtureName);
  const isIssue = eventType === 'issue_opened' || eventType === 'issue_comment';
  const number = 1;
  const loader = new FixtureLoader();
  const fx =
    fixtureName && fixtureName.startsWith('gh.') ? loader.load(fixtureName as any) : undefined;
  const title =
    (fx?.webhook.payload as any)?.pull_request?.title ||
    (fx?.webhook.payload as any)?.issue?.title ||
    (isIssue ? 'Sample issue title' : 'feat: add user search');
  const body = (fx?.webhook.payload as any)?.issue?.body || (isIssue ? 'Issue body' : 'PR body');
  const commentBody = (fx?.webhook.payload as any)?.comment?.body;
  const prInfo: PRInfo = {
    number,
    title,
    body,
    author: 'test-user',
    authorAssociation: 'MEMBER',
    base: 'main',
    head: 'feature/test',
    files: (fx?.files || []).map((f: any) => ({
      filename: f.path,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      changes: (f.additions || 0) + (f.deletions || 0),
      status: (f.status as any) || 'modified',
      patch: f.content ? `@@\n+${f.content}` : undefined,
    })),
    totalAdditions: 0,
    totalDeletions: 0,
    eventType,
    fullDiff: fx?.diff,
    isIssue,
    eventContext: {
      event_name:
        fx?.webhook?.name ||
        (isIssue ? (eventType === 'issue_comment' ? 'issue_comment' : 'issues') : 'pull_request'),
      action:
        fx?.webhook?.action ||
        (eventType === 'pr_opened'
          ? 'opened'
          : eventType === 'pr_updated'
            ? 'synchronize'
            : undefined),
      issue: isIssue ? { number, title, body, user: { login: 'test-user' } } : undefined,
      pull_request: !isIssue
        ? { number, title, head: { ref: 'feature/test' }, base: { ref: 'main' } }
        : undefined,
      repository: { owner: { login: 'owner' }, name: 'repo' },
      comment:
        eventType === 'issue_comment'
          ? { body: commentBody || 'dummy', user: { login: 'contributor' } }
          : undefined,
    },
  };

  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      if (k.startsWith('pr.')) {
        const key = k.slice(3);
        (prInfo as any)[key] = v as any;
      } else if (k.startsWith('webhook.')) {
        const path = k.slice(8);
        deepSet((prInfo as any).eventContext || ((prInfo as any).eventContext = {}), path, v);
      }
    }
  }
  try {
    (prInfo as any).includeCodeContext = false;
    (prInfo as any).isPRContext = false;
  } catch {}
  return prInfo;
}
