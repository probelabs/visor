import type { EngineContext, RunState } from '../../types/engine';
import type { ReviewSummary } from '../../reviewer';

/**
 * Build dependency results for a check with a specific scope.
 * Extracted from LevelDispatch to centralize dependency resolution logic.
 */
export function buildDependencyResultsWithScope(
  checkId: string,
  checkConfig: any,
  context: EngineContext,
  scope: Array<{ check: string; index: number }>
): Map<string, ReviewSummary> {
  const dependencyResults = new Map<string, ReviewSummary>();

  const dependencies = checkConfig.depends_on || [];
  const depList = Array.isArray(dependencies) ? dependencies : [dependencies];

  const currentIndex = scope.length > 0 ? scope[scope.length - 1].index : undefined;

  for (const depId of depList) {
    if (!depId) continue;
    try {
      const snapshotId = context.journal.beginSnapshot();
      const visible = context.journal.readVisible(
        context.sessionId,
        snapshotId,
        context.event as any
      );
      const sameScope = (
        a: Array<{ check: string; index: number }>,
        b: Array<{ check: string; index: number }>
      ): boolean => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++)
          if (a[i].check !== b[i].check || a[i].index !== b[i].index) return false;
        return true;
      };
      const matches = visible.filter(e => e.checkId === depId && sameScope(e.scope as any, scope));
      let journalResult = (
        matches.length > 0 ? matches[matches.length - 1].result : undefined
      ) as any;

      if (
        journalResult &&
        Array.isArray(journalResult.forEachItems) &&
        currentIndex !== undefined
      ) {
        const perItemSummary: any = (journalResult.forEachItemResults &&
          journalResult.forEachItemResults[currentIndex]) || { issues: [] };
        const perItemOutput = journalResult.forEachItems[currentIndex];
        const combined = { ...perItemSummary, output: perItemOutput } as ReviewSummary;
        dependencyResults.set(depId, combined);
        continue;
      }

      if (!journalResult) {
        try {
          const { ContextView } = require('../../snapshot-store');
          const rawContextView = new ContextView(
            context.journal,
            context.sessionId,
            snapshotId,
            [],
            context.event
          );
          const raw = rawContextView.get(depId);
          if (raw && Array.isArray((raw as any).forEachItems) && currentIndex !== undefined) {
            const perItemSummary: any = ((raw as any).forEachItemResults &&
              (raw as any).forEachItemResults[currentIndex]) || { issues: [] };
            const perItemOutput = (raw as any).forEachItems[currentIndex];
            journalResult = { ...perItemSummary, output: perItemOutput } as ReviewSummary;
          }
        } catch {
          // ignore
        }
      }

      if (journalResult) {
        dependencyResults.set(depId, journalResult as ReviewSummary);
      }
    } catch {
      // ignore individual dep failures
    }
  }

  // Also expose raw outputs for all checks as a best-effort convenience
  try {
    const snapshotId = context.journal.beginSnapshot();
    const allEntries = context.journal.readVisible(
      context.sessionId,
      snapshotId,
      context.event as any
    );
    const allCheckNames = Array.from(new Set(allEntries.map((e: any) => e.checkId)));

    for (const checkName of allCheckNames) {
      try {
        const { ContextView } = require('../../snapshot-store');
        const rawContextView = new ContextView(
          context.journal,
          context.sessionId,
          snapshotId,
          scope,
          context.event
        );
        const jr = rawContextView.get(checkName);
        if (jr) dependencyResults.set(checkName, jr as ReviewSummary);
      } catch {}
    }

    for (const checkName of allCheckNames) {
      const checkCfg = context.config.checks?.[checkName];
      if (checkCfg?.forEach) {
        try {
          const { ContextView } = require('../../snapshot-store');
          const rawContextView = new ContextView(
            context.journal,
            context.sessionId,
            snapshotId,
            [],
            context.event
          );
          const rawResult = rawContextView.get(checkName);
          if (rawResult && (rawResult as any).forEachItems) {
            const rawKey = `${checkName}-raw`;
            dependencyResults.set(rawKey, {
              issues: [],
              output: (rawResult as any).forEachItems,
            } as ReviewSummary);
          }
        } catch {}
      }
    }
  } catch {}

  return dependencyResults;
}

export function buildDependencyResults(
  checkId: string,
  checkConfig: any,
  context: EngineContext,
  _state: RunState
): Map<string, ReviewSummary> {
  return buildDependencyResultsWithScope(checkId, checkConfig, context, []);
}
