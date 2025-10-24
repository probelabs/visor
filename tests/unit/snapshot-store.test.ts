import { describe, it, expect } from '@jest/globals';
import { ExecutionJournal, ContextView, ScopePath } from '../../src/snapshot-store';

function makeResult(val: any) {
  return { issues: [], output: val } as any;
}

describe('snapshot-store (journal + context view)', () => {
  it('commits are monotonic and readVisible honors snapshot', () => {
    const j = new ExecutionJournal();
    const session = 's1';
    const scope: ScopePath = [];

    const s0 = j.beginSnapshot();
    expect(s0).toBe(0);

    const e1 = j.commitEntry({ sessionId: session, scope, checkId: 'A', result: makeResult(1) });
    const e2 = j.commitEntry({ sessionId: session, scope, checkId: 'A', result: makeResult(2) });
    expect(e2.commitId).toBeGreaterThan(e1.commitId);

    const snap1 = 1; // only first commit visible
    const vis1 = j.readVisible(session, snap1);
    expect(vis1.find(e => e.commitId === e1.commitId)).toBeTruthy();
    expect(vis1.find(e => e.commitId === e2.commitId)).toBeFalsy();
  });

  it('ContextView prefers exact scope, then ancestor, else latest', () => {
    const j = new ExecutionJournal();
    const session = 's2';
    const parent: ScopePath = [];
    const itemScope: ScopePath = [{ check: 'parent', index: 0 }];

    j.commitEntry({ sessionId: session, scope: parent, checkId: 'X', result: makeResult('root') });
    j.commitEntry({
      sessionId: session,
      scope: itemScope,
      checkId: 'X',
      result: makeResult('item0'),
    });
    const snap = j.beginSnapshot();

    // exact item scope
    const cvItem = new ContextView(j, session, snap, itemScope);
    expect((cvItem.get('X') as any).output).toBe('item0');
    expect((cvItem.getRaw('X') as any).output).toBe('root');

    // unrelated scope → latest
    const otherScope: ScopePath = [{ check: 'other', index: 0 }];
    const cvOther = new ContextView(j, session, snap, otherScope);
    expect((cvOther.get('X') as any).output).toBe('item0');

    // history contains both
    const hist = cvOther.getHistory('X');
    expect(hist).toHaveLength(2);
  });
});
