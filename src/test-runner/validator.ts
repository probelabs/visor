import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

// Lightweight JSON Schema for the tests DSL. The goal is helpful errors,
// not full semantic validation.
const schema: any = {
  $id: 'https://visor/probe/tests-dsl.schema.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'string' },
    extends: {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    tests: {
      type: 'object',
      additionalProperties: false,
      required: ['cases'],
      properties: {
        defaults: {
          type: 'object',
          additionalProperties: false,
          properties: {
            strict: { type: 'boolean' },
            ai_provider: { type: 'string' },
            fail_on_unexpected_calls: { type: 'boolean' },
            github_recorder: {
              type: 'object',
              additionalProperties: false,
              properties: {
                error_code: { type: 'number' },
                timeout_ms: { type: 'number' },
              },
            },
            macros: {
              type: 'object',
              additionalProperties: { $ref: '#/$defs/expectBlock' },
            },
          },
        },
        fixtures: { type: 'array' },
        cases: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/testCase' },
        },
      },
    },
  },
  required: ['tests'],
  $defs: {
    fixtureRef: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            builtin: { type: 'string' },
            overrides: { type: 'object' },
          },
          required: ['builtin'],
        },
      ],
    },
    testCase: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        skip: { type: 'boolean' },
        strict: { type: 'boolean' },
        github_recorder: {
          type: 'object',
          additionalProperties: false,
          properties: {
            error_code: { type: 'number' },
            timeout_ms: { type: 'number' },
          },
        },
        event: {
          type: 'string',
          enum: [
            'manual',
            'pr_opened',
            'pr_updated',
            'pr_closed',
            'issue_opened',
            'issue_comment',
          ],
        },
        fixture: { $ref: '#/$defs/fixtureRef' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        mocks: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              { type: 'array' },
              { type: 'object' },
            ],
          },
        },
        expect: { $ref: '#/$defs/expectBlock' },
        // Flow cases
        flow: {
          type: 'array',
          items: { $ref: '#/$defs/flowStage' },
        },
      },
      required: ['name'],
      anyOf: [
        { required: ['event'] },
        { required: ['flow'] },
      ],
    },
    flowStage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        github_recorder: {
          type: 'object',
          additionalProperties: false,
          properties: {
            error_code: { type: 'number' },
            timeout_ms: { type: 'number' },
          },
        },
        event: {
          type: 'string',
          enum: [
            'manual',
            'pr_opened',
            'pr_updated',
            'pr_closed',
            'issue_opened',
            'issue_comment',
          ],
        },
        fixture: { $ref: '#/$defs/fixtureRef' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        mocks: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              { type: 'array' },
              { type: 'object' },
            ],
          },
        },
        expect: { $ref: '#/$defs/expectBlock' },
      },
      required: ['event'],
    },
    countExpectation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        exactly: { type: 'number' },
        at_least: { type: 'number' },
        at_most: { type: 'number' },
      },
      // Mutual exclusion is enforced at runtime; schema ensures they are numeric if present.
    },
    callsExpectation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        step: { type: 'string' },
        provider: { type: 'string' },
        op: { type: 'string' },
        args: { type: 'object' },
        exactly: { type: 'number' },
        at_least: { type: 'number' },
        at_most: { type: 'number' },
      },
    },
    promptsExpectation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        step: { type: 'string' },
        index: {
          oneOf: [
            { type: 'number' },
            { enum: ['first', 'last'] },
          ],
        },
        contains: {
          type: 'array',
          items: { type: 'string' },
        },
        not_contains: {
          type: 'array',
          items: { type: 'string' },
        },
        matches: { type: 'string' },
        where: {
          type: 'object',
          additionalProperties: false,
          properties: {
            contains: { type: 'array', items: { type: 'string' } },
            not_contains: { type: 'array', items: { type: 'string' } },
            matches: { type: 'string' },
          },
        },
      },
      required: ['step'],
    },
    outputsExpectation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        step: { type: 'string' },
        index: {
          oneOf: [
            { type: 'number' },
            { enum: ['first', 'last'] },
          ],
        },
        path: { type: 'string' },
        equals: {},
        equalsDeep: {},
        matches: { type: 'string' },
        where: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            equals: {},
            matches: { type: 'string' },
          },
          required: ['path'],
        },
        contains_unordered: { type: 'array' },
      },
      required: ['step', 'path'],
    },
    expectBlock: {
      type: 'object',
      additionalProperties: false,
      properties: {
        use: { type: 'array', items: { type: 'string' } },
        calls: { type: 'array', items: { $ref: '#/$defs/callsExpectation' } },
        prompts: { type: 'array', items: { $ref: '#/$defs/promptsExpectation' } },
        outputs: { type: 'array', items: { $ref: '#/$defs/outputsExpectation' } },
        no_calls: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { step: { type: 'string' }, provider: { type: 'string' }, op: { type: 'string' } },
          },
        },
        fail: {
          type: 'object',
          additionalProperties: false,
          properties: { message_contains: { type: 'string' } },
        },
        strict_violation: {
          type: 'object',
          additionalProperties: false,
          properties: { for_step: { type: 'string' }, message_contains: { type: 'string' } },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function toYamlPath(instancePath: string): string {
  if (!instancePath) return 'tests';
  // Ajv instancePath starts with '/'
  const parts = instancePath.split('/').slice(1).map(p => (p.match(/^\d+$/) ? `[${p}]` : `.${p}`));
  let out = parts.join('');
  if (out.startsWith('.')) out = out.slice(1);
  // Heuristic: put root under tests for nicer messages
  if (!out.startsWith('tests')) out = `tests.${out}`;
  return out;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

const knownKeys = new Set([
  // top-level
  'version', 'extends', 'tests',
  // tests
  'tests.defaults', 'tests.fixtures', 'tests.cases',
  // defaults
  'tests.defaults.strict', 'tests.defaults.ai_provider', 'tests.defaults.github_recorder', 'tests.defaults.macros', 'tests.defaults.fail_on_unexpected_calls',
  // case
  'name', 'description', 'skip', 'strict', 'event', 'fixture', 'env', 'mocks', 'expect', 'flow',
  // expect
  'expect.use', 'expect.calls', 'expect.prompts', 'expect.outputs', 'expect.no_calls', 'expect.fail', 'expect.strict_violation',
  // calls
  'step', 'provider', 'op', 'exactly', 'at_least', 'at_most', 'args',
  // prompts/outputs
  'index', 'contains', 'not_contains', 'matches', 'path', 'equals', 'equalsDeep', 'where', 'contains_unordered',
]);

function hintForAdditionalProperty(err: ErrorObject): string | undefined {
  if (err.keyword !== 'additionalProperties') return undefined;
  const prop = (err.params as any)?.additionalProperty;
  if (!prop || typeof prop !== 'string') return undefined;
  // find nearest known key suffix match
  let best: { key: string; dist: number } | null = null;
  for (const k of knownKeys) {
    const dist = levenshtein(prop, k.includes('.') ? k.split('.').pop()! : k);
    if (dist <= 3 && (!best || dist < best.dist)) best = { key: k, dist };
  }
  if (best) return `Did you mean "${best.key}"?`;
  return undefined;
}

function formatError(e: ErrorObject): string {
  const path = toYamlPath(e.instancePath || '');
  let msg = `${path}: ${e.message}`;
  const hint = hintForAdditionalProperty(e);
  if (hint) msg += ` (${hint})`;
  if (e.keyword === 'enum' && Array.isArray((e.params as any)?.allowedValues)) {
    msg += ` (allowed: ${(e.params as any).allowedValues.join(', ')})`;
  }
  return msg;
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateTestsDoc(doc: unknown): ValidationResult {
  try {
    const ok = validate(doc);
    if (ok) return { ok: true };
    const errs = (validate.errors || []).map(formatError);
    return { ok: false, errors: errs };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}
