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
      logger.debug(`[TemplateRenderer] Using inline template for ${checkId}`);
    } else if (checkConfig.template && checkConfig.template.file) {
      const file = String(checkConfig.template.file);
      const resolved = path.resolve(process.cwd(), file);
      templateContent = await fs.readFile(resolved, 'utf-8');
      logger.debug(`[TemplateRenderer] Using template file for ${checkId}: ${resolved}`);
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
            if (templateContent) {
              logger.debug(`[TemplateRenderer] Using schema template for ${checkId}: ${p}`);
              break;
            }
          } catch {
            // try next
          }
        }
        if (!templateContent) {
          logger.warn(
            `[TemplateRenderer] No template found for schema '${sanitized}' in ${checkId}. __dirname=${__dirname}, cwd=${process.cwd()}, tried ${candidatePaths.length} paths: ${candidatePaths.join(', ')}`
          );
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

    // Ensure output is an object, not a JSON string
    // If output is a string that looks like JSON, parse it
    let output = (reviewSummary as any).output;
    if (typeof output === 'string') {
      const trimmed = output.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          output = JSON.parse(trimmed);
        } catch {
          // Not valid JSON, keep as string
        }
      }
    }

    const templateData: Record<string, unknown> = {
      issues: reviewSummary.issues || [],
      checkName: checkId,
      output,
    };

    logger.debug(
      `[TemplateRenderer] Rendering template for ${checkId} with output type=${typeof output}, keys=${output && typeof output === 'object' ? Object.keys(output).join(',') : 'n/a'}`
    );

    const rendered = await liquid.parseAndRender(templateContent, templateData);
    const trimmed = rendered.trim();

    if (!trimmed) {
      logger.warn(
        `[TemplateRenderer] Template rendered EMPTY for ${checkId}. output=${JSON.stringify(output)?.substring(0, 200)}`
      );
    }

    return trimmed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[LevelDispatch] Failed to render template for ${checkId}: ${msg}`);
    return undefined;
  }
}
