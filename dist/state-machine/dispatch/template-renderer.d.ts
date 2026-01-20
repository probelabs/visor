import type { ReviewSummary } from '../../reviewer';
/**
 * Render template content for a check using our extended Liquid environment.
 * Extracted from LevelDispatch for reuse and testability.
 */
export declare function renderTemplateContent(checkId: string, checkConfig: any, reviewSummary: ReviewSummary): Promise<string | undefined>;
//# sourceMappingURL=template-renderer.d.ts.map