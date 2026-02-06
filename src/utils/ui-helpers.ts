import { GroupedCheckResults } from '../reviewer';

export function deriveExecutedCheckNames(groupedResults: GroupedCheckResults): string[] {
  const names = new Set<string>();
  for (const [, group] of Object.entries(groupedResults)) {
    for (const r of group) {
      if (r && typeof r.checkName === 'string') names.add(r.checkName);
    }
  }
  return Array.from(names);
}
