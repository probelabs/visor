import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import Sandbox from '@nyariv/sandboxjs';
import { createExtendedLiquid } from '../liquid-extensions';

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

    // Create Octokit from env token
    const token = process.env['INPUT_GITHUB-TOKEN'] || process.env['GITHUB_TOKEN'];
    if (!token) {
      return {
        issues: [
          {
            file: 'system',
            line: 0,
            ruleId: 'github/missing_token',
            message:
              'No GitHub token available; set GITHUB_TOKEN or pass github-token input for native GitHub operations',
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }

    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: token });

    const repoEnv = process.env.GITHUB_REPOSITORY || '';
    const [owner, repo] = repoEnv.split('/') as [string, string];
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
      const out: string[] = [];
      for (const item of arr) {
        if (typeof item === 'string' && (item.includes('{{') || item.includes('{%'))) {
          try {
            const rendered = await liq.parseAndRender(item, ctx);
            out.push(rendered);
          } catch (e) {
            // If Liquid fails, surface as a provider error
            const msg = e instanceof Error ? e.message : String(e);
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
        const code = `
          const __fn = () => {\n${cfg.value_js}\n};
          return __fn();
        `;
        const exec = sandbox.compile(code);
        const res = exec({ pr: prInfo, values });
        if (typeof res === 'string') values = [res];
        else if (Array.isArray(res)) values = (res as unknown[]).map(v => String(v));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
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

    // Trim, drop empty, and de-duplicate values regardless of source
    values = values.map(v => v.trim()).filter(v => v.length > 0);
    values = Array.from(new Set(values));

    try {
      switch (cfg.op) {
        case 'labels.add': {
          if (values.length === 0) break; // no-op if nothing to add
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
    const globals = {
      ...Sandbox.SAFE_GLOBALS,
      Math,
    } as Record<string, unknown>;

    const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);
    const arrayMethods = new Set([
      'some',
      'every',
      'filter',
      'map',
      'reduce',
      'find',
      'includes',
      'indexOf',
      'length',
      'slice',
      'concat',
      'join',
    ]);
    prototypeWhitelist.set(Array.prototype, arrayMethods);

    const stringMethods = new Set([
      'toLowerCase',
      'toUpperCase',
      'includes',
      'indexOf',
      'startsWith',
      'endsWith',
      'slice',
      'substring',
      'length',
      'trim',
      'split',
      'replace',
    ]);
    prototypeWhitelist.set(String.prototype, stringMethods);

    const objectMethods = new Set(['hasOwnProperty', 'toString', 'valueOf']);
    prototypeWhitelist.set(Object.prototype, objectMethods);

    this.sandbox = new Sandbox({ globals, prototypeWhitelist });
    return this.sandbox;
  }
}
