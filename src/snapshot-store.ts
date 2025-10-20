/*
 * Internal snapshot store for incremental adoption of snapshot+scope execution.
 * Phase 0: journal only — no behavior change, used for future visibility work.
 */

import type { ReviewSummary } from './reviewer';

export type ScopePath = Array<{ check: string; index: number }>;

export interface JournalEntry {
  commitId: number;
  sessionId: string;
  scope: ScopePath;
  checkId: string;
  result: ReviewSummary & { output?: unknown; content?: string };
}

export class ExecutionJournal {
  private commit = 0;
  private entries: JournalEntry[] = [];

  beginSnapshot(): number {
    return this.commit;
  }

  commitEntry(entry: Omit<JournalEntry, 'commitId'>): JournalEntry {
    const committed: JournalEntry = { ...entry, commitId: ++this.commit };
    this.entries.push(committed);
    return committed;
  }

  readVisible(sessionId: string, commitMax: number): JournalEntry[] {
    return this.entries.filter(e => e.sessionId === sessionId && e.commitId <= commitMax);
  }

  // Lightweight helpers for debugging/metrics
  size(): number {
    return this.entries.length;
  }
}
