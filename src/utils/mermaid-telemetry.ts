import { addEvent } from '../telemetry/trace-helpers';
import { addDiagramBlock } from '../telemetry/metrics';

const MERMAID_RE = /```mermaid\s*\n([\s\S]*?)\n```/gi;

export type DiagramOrigin = 'content' | 'issue';

export function emitMermaidFromMarkdown(
  checkName: string,
  markdown: string,
  origin: DiagramOrigin
): number {
  if (!markdown || typeof markdown !== 'string') return 0;
  let m: RegExpExecArray | null;
  let count = 0;
  MERMAID_RE.lastIndex = 0;
  while ((m = MERMAID_RE.exec(markdown)) != null) {
    const code = (m[1] || '').trim();
    if (code) {
      try {
        addEvent('diagram.block', { check: checkName, origin, code });
        addDiagramBlock(origin);
        count++;
      } catch {
        // ignore telemetry failures
      }
    }
  }
  return count;
}
