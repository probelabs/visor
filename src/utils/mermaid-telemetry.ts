import { addEvent } from '../telemetry/trace-helpers';
import { addDiagramBlock } from '../telemetry/metrics';
import * as fs from 'fs';
import * as path from 'path';

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
        // Fallback writer for environments where OTel SDK isn't active
        if (process.env.VISOR_TRACE_REPORT === 'true') {
          const outDir =
            process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
          try {
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const jsonPath = path.join(outDir, `${ts}.trace.json`);
            const htmlPath = path.join(outDir, `${ts}.report.html`);
            // Append or create minimal trace JSON
            let data: {
              spans: Array<{ events: Array<{ name: string; attrs: Record<string, unknown> }> }>;
            } = { spans: [] };
            if (fs.existsSync(jsonPath)) {
              try {
                data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
              } catch {
                data = { spans: [] };
              }
            }
            data.spans.push({
              events: [{ name: 'diagram.block', attrs: { check: checkName, origin, code } }],
            });
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
            // Ensure minimal HTML report exists
            if (!fs.existsSync(htmlPath)) {
              fs.writeFileSync(
                htmlPath,
                '<!doctype html><html><head><meta charset="utf-8"/><title>Visor Trace Report</title></head><body><h2>Visor Trace Report</h2></body></html>',
                'utf8'
              );
            }
          } catch {}
        }
        count++;
      } catch {
        // ignore telemetry failures
      }
    }
  }
  return count;
}
