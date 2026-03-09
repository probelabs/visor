import { evaluateOutputs, evaluateWorkflowOutputs } from '../../src/test-runner/evaluators';
import type { ExpectBlock } from '../../src/test-runner/assertions';

describe('Numeric comparison operators in output assertions', () => {
  const outputHistory: Record<string, unknown[]> = {
    calc: [{ settlement: { deductions: 5, barCutAmount: 0, total: -1 }, count: 3 }],
  };

  it('gt passes when value is greater', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'calc', path: 'settlement.deductions', gt: 0 }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toEqual([]);
  });

  it('gt fails when value is equal', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'calc', path: 'count', gt: 3 }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expected > 3 but got 3');
  });

  it('gte passes when value is equal', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'calc', path: 'count', gte: 3 }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toEqual([]);
  });

  it('gte fails when value is less', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'calc', path: 'count', gte: 4 }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expected >= 4 but got 3');
  });

  it('lt passes when value is less', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'calc', path: 'settlement.total', lt: 0 }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toEqual([]);
  });

  it('lte passes when value is equal', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'calc', path: 'settlement.barCutAmount', lte: 0 }],
    };
    evaluateOutputs(errors, exp, outputHistory);
    expect(errors).toEqual([]);
  });

  it('reports type error for non-numeric value', () => {
    const history: Record<string, unknown[]> = {
      step1: [{ val: 'hello' }],
    };
    const errors: string[] = [];
    const exp: ExpectBlock = {
      outputs: [{ step: 'step1', path: 'val', gt: 0 }],
    };
    evaluateOutputs(errors, exp, history);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expected number for gt but got string');
  });

  it('works with workflow_output assertions', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      workflow_output: [{ path: 'total', gte: 1 }],
    } as any;
    evaluateWorkflowOutputs(errors, exp, { total: 5 });
    expect(errors).toEqual([]);
  });

  it('workflow_output gt fails correctly', () => {
    const errors: string[] = [];
    const exp: ExpectBlock = {
      workflow_output: [{ path: 'total', gt: 10 }],
    } as any;
    evaluateWorkflowOutputs(errors, exp, { total: 5 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expected > 10 but got 5');
  });
});
