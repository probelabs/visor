import { logger } from '../../logger';
import type { ReviewSummary } from '../../reviewer';

/**
 * Render template content for a check using our extended Liquid environment.
 * Extracted from LevelDispatch for reuse and testability.
 */
export async function renderTemplateContent(
  checkId: string,
  checkConfig: any,
  reviewSummary: ReviewSummary
): Promise<string | undefined> {
  try {
    const { createExtendedLiquid } = await import('../../liquid-extensions');
    const fs = await import('fs/promises');
    const path = await import('path');

    const schemaRaw = checkConfig.schema || 'plain';
    const schema = typeof schemaRaw === 'string' ? schemaRaw : 'code-review';

    let templateContent: string | undefined;

    if (checkConfig.template && checkConfig.template.content) {
      templateContent = String(checkConfig.template.content);
    } else if (checkConfig.template && checkConfig.template.file) {
      const file = String(checkConfig.template.file);
      const resolved = path.resolve(process.cwd(), file);
      templateContent = await fs.readFile(resolved, 'utf-8');
    } else if (schema && schema !== 'plain') {
      const sanitized = String(schema).replace(/[^a-zA-Z0-9-]/g, '');
      if (sanitized) {
        // When bundled with ncc, __dirname is dist/ and output/ is at dist/output/
        // When running from source, __dirname is src/state-machine/dispatch/ and output/ is at output/
        const candidatePaths = [
          path.join(__dirname, 'output', sanitized, 'template.liquid'), // bundled: dist/output/
          path.join(__dirname, '..', '..', 'output', sanitized, 'template.liquid'), // source: output/
          path.join(process.cwd(), 'output', sanitized, 'template.liquid'), // fallback: cwd/output/
          path.join(process.cwd(), 'dist', 'output', sanitized, 'template.liquid'), // fallback: cwd/dist/output/
        ];
        for (const p of candidatePaths) {
          try {
            templateContent = await fs.readFile(p, 'utf-8');
            if (templateContent) break;
          } catch {
            // try next
          }
        }
      }
    }

    if (!templateContent) return undefined;

    const liquid = createExtendedLiquid({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false,
    });

    const templateData: Record<string, unknown> = {
      issues: reviewSummary.issues || [],
      checkName: checkId,
      output: (reviewSummary as any).output,
    };

    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[LevelDispatch] Failed to render template for ${checkId}: ${msg}`);
    return undefined;
  }
}
