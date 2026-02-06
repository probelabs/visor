/*
 * Internal snapshot store for incremental adoption of snapshot+scope execution.
 * Phase 0: journal only — no behavior change, used for future visibility work.
 */

import type { ReviewSummary } from './reviewer';
import type { EventTrigger } from './types/config';

export type ScopePath = Array<{ check: string; index: number }>;

export interface JournalEntry {
  commitId: number;
  sessionId: string;
  scope: ScopePath;
  checkId: string;
  event: EventTrigger | undefined;
  result: ReviewSummary & { output?: unknown; content?: string };
}

export class ExecutionJournal {
  private commit = 0;
  private entries: JournalEntry[] = [];

  beginSnapshot(): number {
    return this.commit;
  }

  commitEntry(entry: {
    sessionId: string;
    scope: ScopePath;
    checkId: string;
    result: ReviewSummary & { output?: unknown; content?: string };
    event?: EventTrigger;
  }): JournalEntry {
    const committed: JournalEntry = {
      sessionId: entry.sessionId,
      scope: entry.scope,
      checkId: entry.checkId,
      result: entry.result,
      event: entry.event,
      commitId: ++this.commit,
    };
    this.entries.push(committed);
    return committed;
  }

  readVisible(sessionId: string, commitMax: number, event?: EventTrigger): JournalEntry[] {
    return this.entries.filter(
      e =>
        e.sessionId === sessionId && e.commitId <= commitMax && (event ? e.event === event : true)
    );
  }

  // Lightweight helpers for debugging/metrics
  size(): number {
    return this.entries.length;
  }
}

export class ContextView {
  constructor(
    private journal: ExecutionJournal,
    private sessionId: string,
    private snapshotId: number,
    private scope: ScopePath,
    private event?: EventTrigger
  ) {}

  /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
  get(checkId: string): (ReviewSummary & { output?: unknown; content?: string }) | undefined {
    const visible = this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId);
    if (visible.length === 0) return undefined;

    // exact scope match: prefer the most recent commit for this scope
    const exactMatches = visible.filter(e => this.sameScope(e.scope, this.scope));
    if (exactMatches.length > 0) {
      return exactMatches[exactMatches.length - 1].result;
    }

    // nearest ancestor (shortest distance)
    let best: { entry: JournalEntry; dist: number } | undefined;
    for (const e of visible) {
      const dist = this.ancestorDistance(e.scope, this.scope);
      if (dist >= 0 && (best === undefined || dist < best.dist)) {
        best = { entry: e, dist };
      }
    }
    if (best) return best.entry.result;

    // fallback to latest committed result
    return visible[visible.length - 1]?.result;
  }

  /** Return an aggregate (raw) result – the shallowest scope for this check. */
  getRaw(checkId: string): (ReviewSummary & { output?: unknown; content?: string }) | undefined {
    const visible = this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId);
    if (visible.length === 0) return undefined;
    let shallow = visible[0];
    for (const e of visible) {
      if (e.scope.length < shallow.scope.length) shallow = e;
    }
    return shallow.result;
  }

  /** All results for a check up to this snapshot. */
  getHistory(checkId: string): Array<ReviewSummary & { output?: unknown; content?: string }> {
    return this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId)
      .map(e => e.result);
  }

  private sameScope(a: ScopePath, b: ScopePath): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].check !== b[i].check || a[i].index !== b[i].index) return false;
    }
    return true;
  }

  // distance from ancestor to current; -1 if not ancestor
  private ancestorDistance(ancestor: ScopePath, current: ScopePath): number {
    if (ancestor.length > current.length) return -1;
    // Treat root scope ([]) as non-ancestor for unrelated branches
    if (ancestor.length === 0 && current.length > 0) return -1;
    for (let i = 0; i < ancestor.length; i++) {
      if (ancestor[i].check !== current[i].check || ancestor[i].index !== current[i].index)
        return -1;
    }
    return current.length - ancestor.length;
  }
}
