import { evaluateCase } from '../../../src/test-runner/evaluators';
import type { ExpectBlock } from '../../../src/test-runner/assertions';
import { validateTestsDoc } from '../../../src/test-runner/validator';

function stat(checkName: string, totalRuns: number, logicalCheckName?: string): any {
  return {
    checkName,
    ...(logicalCheckName === undefined ? {} : { logicalCheckName }),
    totalRuns,
    successfulRuns: totalRuns,
    failedRuns: 0,
    skippedRuns: 0,
    skipped: false,
    totalDuration: 0,
    issuesFound: 0,
    issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
  };
}

function errorsFor(
  checks: any[],
  expect: ExpectBlock,
  strict = false,
  outputHistory: Record<string, unknown[]> = {}
): string[] {
  return evaluateCase(
    'logical-step',
    { checks } as any,
    { calls: [] },
    undefined,
    expect,
    strict,
    {},
    {} as any,
    outputHistory
  );
}

describe('generated logical_step call assertions', () => {
  it('aggregates only generated rows and supports all count operators', () => {
    const checks = [
      stat('generation-hash-a', 1, 'inspect-native-component'),
      stat('generation-hash-b', 2, 'inspect-native-component'),
    ];

    expect(
      errorsFor(checks, {
        calls: [{ logical_step: 'inspect-native-component', exactly: 3 }],
      })
    ).toEqual([]);
    expect(
      errorsFor(checks, {
        calls: [{ logical_step: 'inspect-native-component', at_least: 3 }],
      })
    ).toEqual([]);
    expect(
      errorsFor(checks, {
        calls: [{ logical_step: 'inspect-native-component', at_most: 3 }],
      })
    ).toEqual([]);
    expect(
      errorsFor(checks, {
        calls: [{ logical_step: 'inspect-native-component', exactly: 2 }],
      })
    ).toEqual(['Expected logical_step inspect-native-component exactly 2, got 3']);
  });

  it('keeps legacy exact step matching, including opaque generated hashes', () => {
    const checks = [stat('generation-hash-a', 1, 'inspect-native-component')];
    expect(errorsFor(checks, { calls: [{ step: 'generation-hash-a', exactly: 1 }] })).toEqual([]);
    // There is no implicit alias from the logical id to the exact execution key.
    expect(
      errorsFor(checks, { calls: [{ step: 'inspect-native-component', exactly: 0 }] })
    ).toEqual([]);
  });

  it('does not let logical_step cover a top-level row with the same name', () => {
    const checks = [
      stat('generation-hash-a', 1, 'inspect-native-component'),
      stat('inspect-native-component', 1),
    ];
    const errors = errorsFor(
      checks,
      { calls: [{ logical_step: 'inspect-native-component', exactly: 1 }] },
      true
    );
    expect(errors).toEqual(['Step executed without expect: inspect-native-component']);
  });

  it('reports unexpected generated rows under strict mode', () => {
    const errors = errorsFor(
      [
        stat('generation-hash-a', 1, 'inspect-native-component'),
        stat('generation-hash-b', 1, 'other-generated-check'),
      ],
      { calls: [{ logical_step: 'inspect-native-component', exactly: 1 }] },
      true
    );
    expect(errors).toEqual(['Step executed without expect: generation-hash-b']);
  });

  it('covers dotted generated logical ids added from output history in strict mode', () => {
    const checks = [stat('generation-hash-a', 1, 'nested.inspect')];
    const outputHistory = { 'nested.inspect': [{ ok: true }] };
    const errors = errorsFor(
      checks,
      { calls: [{ logical_step: 'nested.inspect', exactly: 1 }] },
      true,
      outputHistory
    );
    // The dotted logical id is inferred from output history by the evaluator;
    // it must still be covered by the generated row's logical selector.
    expect(errors).toEqual([]);
    // Dotted logical output history does not implicitly alias the exact step
    // selector; exact matching still requires the opaque generation hash.
    expect(
      errorsFor(checks, { calls: [{ step: 'nested.inspect', exactly: 0 }] }, false, outputHistory)
    ).toEqual([]);
  });

  it('rejects missing, duplicate, and malformed step selectors in the schema', () => {
    const valid = (call: unknown) =>
      validateTestsDoc({
        tests: { cases: [{ name: 'selector', event: 'manual', expect: { calls: [call] } }] },
      });

    expect(valid({ logical_step: 'inspect-native-component', exactly: 1 }).ok).toBe(true);
    expect(valid({ provider: 'github', op: 'checks.create', exactly: 1 }).ok).toBe(true);
    expect(valid({ step: 'exact', logical_step: 'logical', exactly: 1 }).ok).toBe(false);
    expect(valid({ exactly: 1 }).ok).toBe(false);
    expect(valid({ logical_step: 42, exactly: 1 }).ok).toBe(false);
  });

  it('rejects missing and duplicate selectors at evaluation time too', () => {
    expect(errorsFor([stat('step', 1)], { calls: [{ exactly: 1 } as any] })).toEqual([
      'Call expectation must specify exactly one of step or logical_step',
    ]);
    expect(
      errorsFor([stat('step', 1)], {
        calls: [{ step: 'step', logical_step: 'logical', exactly: 1 } as any],
      })
    ).toEqual(['Call expectation cannot specify both step and logical_step']);
  });
});
