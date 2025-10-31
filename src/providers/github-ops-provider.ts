import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import Sandbox from '@nyariv/sandboxjs';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';

export class GitHubOpsProvider extends CheckProvider {
  private sandbox?: Sandbox;

  getName(): string {
    return 'github';
  }

  getDescription(): string {
    return 'Native GitHub operations (labels, comments, reviewers) executed via Octokit';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') return false;
    const cfg = config as CheckProviderConfig & { op?: string };
    return typeof cfg.op === 'string' && cfg.op.length > 0;
  }

  getSupportedConfigKeys(): string[] {
    return ['op', 'values', 'value', 'value_js'];
  }

  async isAvailable(): Promise<boolean> {
    // Available when running in GitHub context or when a token is provided
    return Boolean(
      process.env.GITHUB_TOKEN || process.env['INPUT_GITHUB-TOKEN'] || process.env.GITHUB_REPOSITORY
    );
  }

  getRequirements(): string[] {
    return ['GITHUB_TOKEN or INPUT_GITHUB-TOKEN', 'GITHUB_REPOSITORY'];
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<ReviewSummary> {
    const cfg = config as CheckProviderConfig & {
      op: string;
      values?: string[] | string;
      value?: string;
      value_js?: string;
    };

    // IMPORTANT: Always prefer authenticated octokit from event context (GitHub App or token)
    // This ensures proper bot identity in reactions, labels, and comments
    let octokit: import('@octokit/rest').Octokit | undefined = config.eventContext?.octokit as
      | import('@octokit/rest').Octokit
      | undefined;
    if (process.env.VISOR_DEBUG === 'true') {
      try {
        logger.debug(`[github-ops] pre-fallback octokit? ${!!octokit}`);
      } catch {}
    }
    // Test runner fallback: use global recorder if eventContext is missing octokit
    if (!octokit) {
      try {
        const { getGlobalRecorder } = require('../test-runner/recorders/global-recorder');
        const rec = getGlobalRecorder && getGlobalRecorder();
        if (rec) octokit = rec as any;
      } catch {}
    }

    if (!octokit) {
      if (process.env.VISOR_DEBUG === 'true') {
        try {
          console.error('[github-ops] missing octokit after fallback — returning issue');
        } catch {}
      }
      return {
        issues: [
          {
            file: 'system',
            line: 0,
            ruleId: 'github/missing_octokit',
            message:
              'No authenticated Octokit instance available in event context. GitHub operations require proper authentication context.',
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }

    const repoEnv = process.env.GITHUB_REPOSITORY || '';
    let owner = '';
    let repo = '';
    if (repoEnv.includes('/')) {
      [owner, repo] = repoEnv.split('/') as [string, string];
    } else {
      try {
        const ec: any = config.eventContext || {};
        owner = ec?.repository?.owner?.login || owner;
        repo = ec?.repository?.name || repo;
      } catch {}
    }
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.info(
          `[github-ops] context octokit? ${!!octokit} repo=${owner}/${repo} pr#=${prInfo?.number}`
        );
      }
    } catch {}
    if (!owner || !repo || !prInfo?.number) {
      return {
        issues: [
          {
            file: 'system',
            line: 0,
            ruleId: 'github/missing_context',
            message: 'Missing owner/repo or PR number; GitHub operations require Action context',
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }

    // Build values list (allow string or array), render Liquid templates if present, and normalize
    let valuesRaw: string[] = [];
    if (Array.isArray(cfg.values)) valuesRaw = (cfg.values as unknown[]).map(v => String(v));
    else if (typeof cfg.values === 'string') valuesRaw = [cfg.values];
    else if (typeof cfg.value === 'string') valuesRaw = [cfg.value];
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        logger.info(`[github-ops] op=${cfg.op} valuesRaw(before)=${JSON.stringify(valuesRaw)}`);
      }
    } catch {}

    // Liquid render helper for values
    const renderValues = async (arr: string[]): Promise<string[]> => {
      if (!arr || arr.length === 0) return [];
      const liq = createExtendedLiquid({
        cache: false,
        strictFilters: false,
        strictVariables: false,
      });
      const outputs: Record<string, unknown> = {};
      if (dependencyResults) {
        for (const [name, result] of dependencyResults.entries()) {
          const summary = result as ReviewSummary & { output?: unknown };
          outputs[name] = summary.output !== undefined ? summary.output : summary;
        }
      }
      // Fallback: if outputs missing but engine provided history, use last output snapshot
      try {
        const hist = (config as any).__outputHistory as Map<string, unknown[]> | undefined;
        if (hist) {
          for (const [name, arr] of hist.entries()) {
            if (!outputs[name] && Array.isArray(arr) && arr.length > 0) {
              outputs[name] = arr[arr.length - 1];
            }
          }
        }
      } catch {}
      const ctx = {
        pr: {
          number: prInfo.number,
          title: prInfo.title,
          author: prInfo.author,
          branch: prInfo.head,
          base: prInfo.base,
          authorAssociation: prInfo.authorAssociation,
        },
        outputs,
      };
      try {
        if (process.env.VISOR_DEBUG === 'true') {
          logger.info(`[github-ops] deps keys=${Object.keys(outputs).join(', ')}`);
          const ov = outputs['overview'] as any;
          if (ov) {
            logger.info(`[github-ops] outputs.overview.keys=${Object.keys(ov).join(',')}`);
            if (ov.tags) {
              logger.info(
                `[github-ops] outputs.overview.tags keys=${Object.keys(ov.tags).join(',')}`
              );
              try {
                logger.info(
                  `[github-ops] outputs.overview.tags['review-effort']=${String(ov.tags['review-effort'])}`
                );
              } catch {}
            }
          }
        }
      } catch {}
      const out: string[] = [];
      for (const item of arr) {
        if (typeof item === 'string' && (item.includes('{{') || item.includes('{%'))) {
          try {
            const rendered = await liq.parseAndRender(item, ctx);
            out.push(rendered);
          } catch (e) {
            // If Liquid fails, surface as a provider error
            const msg = e instanceof Error ? e.message : String(e);
            if (process.env.VISOR_DEBUG === 'true') {
              logger.warn(`[github-ops] liquid_render_error: ${msg}`);
            }
            return Promise.reject({
              issues: [
                {
                  file: 'system',
                  line: 0,
                  ruleId: 'github/liquid_render_error',
                  message: `Failed to render template: ${msg}`,
                  severity: 'error',
                  category: 'logic',
                },
              ],
            } as ReviewSummary);
          }
        } else {
          out.push(String(item));
        }
      }
      return out;
    };

    let values: string[] = await renderValues(valuesRaw);

    if (cfg.value_js && cfg.value_js.trim()) {
      try {
        // Evaluate user-provided value_js in a restricted sandbox (no process/global exposure)
        const sandbox = this.getSecureSandbox();

        // Build dependency outputs map (mirrors Liquid context construction)
        const depOutputs: Record<string, unknown> = {};
        if (dependencyResults) {
          for (const [name, result] of dependencyResults.entries()) {
            const summary = result as ReviewSummary & { output?: unknown };
            depOutputs[name] = summary.output !== undefined ? summary.output : summary;
          }
        }

        const res = compileAndRun<unknown>(
          sandbox,
          cfg.value_js,
          { pr: prInfo, values, outputs: depOutputs },
          { injectLog: true, wrapFunction: true, logPrefix: '[github:value_js]' }
        );
        if (typeof res === 'string') values = [res];
        else if (Array.isArray(res)) values = (res as unknown[]).map(v => String(v));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (process.env.VISOR_DEBUG === 'true') {
          logger.warn(`[github-ops] value_js_error: ${msg}`);
        }
        return {
          issues: [
            {
              file: 'system',
              line: 0,
              ruleId: 'github/value_js_error',
              message: `value_js evaluation failed: ${msg}`,
              severity: 'error',
              category: 'logic',
            },
          ],
        };
      }
    }

    // Fallback: if values are still empty, try deriving from dependency outputs (common pattern: outputs.<dep>.tags)
    if (values.length === 0 && dependencyResults && dependencyResults.size > 0) {
      try {
        const derived: string[] = [];
        for (const result of dependencyResults.values()) {
          const out = (result as ReviewSummary & { output?: unknown })?.output ?? result;
          const tags = (out as Record<string, unknown>)?.['tags'] as
            | Record<string, unknown>
            | undefined;
          if (tags && typeof tags === 'object') {
            const label = tags['label'];
            const effort = (tags as Record<string, unknown>)['review-effort'];
            if (label != null) derived.push(String(label));
            if (effort !== undefined && effort !== null)
              derived.push(`review/effort:${String(effort)}`);
          }
        }
        values = derived;
        if (process.env.VISOR_DEBUG === 'true') {
          logger.info(`[github-ops] derived values from deps: ${JSON.stringify(values)}`);
        }
      } catch {}
    }

    // Trim, drop empty, and de-duplicate values regardless of source
    values = values.map(v => v.trim()).filter(v => v.length > 0);
    values = Array.from(new Set(values));

    try {
      // Minimal debug to help diagnose label flow under tests
      if (process.env.NODE_ENV === 'test' || process.env.VISOR_DEBUG === 'true') {
        logger.info(`[github-ops] ${cfg.op} resolved values: ${JSON.stringify(values)}`);
      }
    } catch {}

    try {
      switch (cfg.op) {
        case 'labels.add': {
          if (values.length === 0) break; // no-op if nothing to add
          try {
            if (process.env.VISOR_OUTPUT_FORMAT !== 'json')
              logger.step(`[github-ops] labels.add -> ${JSON.stringify(values)}`);
          } catch {}
          await octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: prInfo.number,
            labels: values,
          });
          break;
        }
        case 'labels.remove': {
          for (const l of values) {
            await octokit.rest.issues.removeLabel({
              owner,
              repo,
              issue_number: prInfo.number,
              name: l,
            });
          }
          break;
        }
        case 'comment.create': {
          const body = values.join('\n').trim();
          if (body)
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: prInfo.number,
              body,
            });
          break;
        }
        default:
          return {
            issues: [
              {
                file: 'system',
                line: 0,
                ruleId: 'github/unsupported_op',
                message: `Unsupported GitHub op: ${cfg.op}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
      }

      return { issues: [] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        logger.error(`[github-ops] op_failed ${cfg.op}: ${msg}`);
      } catch {}
      return {
        issues: [
          {
            file: 'system',
            line: 0,
            ruleId: 'github/op_failed',
            message: `GitHub operation failed (${cfg.op}): ${msg}`,
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }
  }

  /**
   * Create a secure sandbox for evaluating small expressions without access to process/env
   */
  private getSecureSandbox(): Sandbox {
    if (this.sandbox) return this.sandbox;
    this.sandbox = createSecureSandbox();
    return this.sandbox;
  }
}
