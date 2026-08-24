import { compileClaimPlan, ClaimPlanError } from '../../../../src/state-machine/graph/claim-plan';
import { ClaimKernelError } from '../../../../src/state-machine/graph/claim-kernel';

const schema = {
  type: 'object',
  required: ['value'],
  properties: { value: { type: 'string' } },
};

describe('Graph v2 C1 claim plan', () => {
  it('compiles exact consumption into immutable effective dependencies without authored mutation', () => {
    const authoredSchema = JSON.parse(JSON.stringify(schema));
    const config: any = {
      version: '1.0',
      claim_types: { 'fixture.ready@1': { schema: authoredSchema } },
      checks: {
        producer: { type: 'noop', emits: [{ claim: 'fixture.ready@1', from: 'output' }] },
        sibling: { type: 'noop' },
        consumer: {
          type: 'noop',
          depends_on: ['sibling'],
          consumes: [{ claim: 'fixture.ready@1', cardinality: 'one' }],
        },
      },
    };
    const authored = JSON.parse(JSON.stringify(config));

    const plan = compileClaimPlan(config);

    expect(plan.active).toBe(true);
    expect(plan.emitterByClaim['fixture.ready@1']).toBe('producer');
    expect(plan.effectiveDependenciesByCheck.consumer).toEqual(['sibling', 'producer']);
    expect(config).toEqual(authored);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.claimTypes['fixture.ready@1'].schema)).toBe(true);
    expect(Object.isFrozen(plan.emissionsByCheck.producer[0])).toBe(true);
    expect(Object.isFrozen(plan.consumptionsByCheck.consumer[0])).toBe(true);
    expect(Object.isFrozen(plan.effectiveDependenciesByCheck.consumer)).toBe(true);

    config.claim_types['fixture.ready@1'].schema.required.push('changed-after-compile');
    expect(plan.claimTypes['fixture.ready@1'].schema).toEqual(schema);
  });

  it.each(['emits', 'consumes'])('rejects a property-present empty %s declaration', field => {
    const config: any = {
      version: '1.0',
      checks: { check: { type: 'noop', [field]: [] } },
    };
    try {
      compileClaimPlan(config);
      throw new Error('expected empty declaration rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimPlanError);
      expect((error as ClaimPlanError).code).toBe('EMPTY_CLAIM_DECLARATION');
    }
  });

  it('strictly compiles schemas before launch', () => {
    const config: any = {
      version: '1.0',
      claim_types: { 'fixture.ready@1': { schema: { type: 'object', propertiez: {} } } },
      checks: { producer: { type: 'noop' } },
    };
    try {
      compileClaimPlan(config);
      throw new Error('expected strict schema rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimKernelError);
      expect((error as ClaimKernelError).code).toBe('INVALID_CLAIM_SCHEMA');
    }
  });

  it('rejects OR dependency tokens only in claim mode', () => {
    const claimConfig: any = {
      version: '1.0',
      claim_types: { 'fixture.ready@1': { schema } },
      checks: {
        a: { type: 'noop' },
        b: { type: 'noop' },
        c: { type: 'noop', depends_on: 'a|b' },
      },
    };
    try {
      compileClaimPlan(claimConfig);
      throw new Error('expected claim-mode OR rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimPlanError);
      expect((error as ClaimPlanError).code).toBe('UNSUPPORTED_CLAIM_OR_DEPENDENCY');
    }

    delete claimConfig.claim_types;
    expect(compileClaimPlan(claimConfig).effectiveDependenciesByCheck.c).toEqual(['a', 'b']);
  });

  it.each([
    {
      name: 'wrong version',
      mutate: (config: any) => {
        config.checks.consumer.consumes[0].claim = 'fixture.ready@2';
      },
      message: 'undeclared claim',
    },
    {
      name: 'invalid reference',
      mutate: (config: any) => {
        config.claim_types = { fixture: { schema } };
        config.checks.producer.emits[0].claim = 'fixture';
        config.checks.consumer.consumes[0].claim = 'fixture';
      },
      message: 'Invalid claim reference',
    },
    {
      name: 'duplicate emitter',
      mutate: (config: any) => {
        config.checks.other = {
          type: 'noop',
          emits: [{ claim: 'fixture.ready@1', from: 'output' }],
        };
      },
      message: 'duplicate emitters',
    },
    {
      name: 'unsupported root scope',
      mutate: (config: any) => {
        config.checks.producer.forEach = true;
      },
      message: 'root-scope only',
    },
  ])('rejects $name', ({ mutate, message }) => {
    const config: any = {
      version: '1.0',
      claim_types: { 'fixture.ready@1': { schema } },
      checks: {
        producer: { type: 'noop', emits: [{ claim: 'fixture.ready@1', from: 'output' }] },
        consumer: {
          type: 'noop',
          consumes: [{ claim: 'fixture.ready@1', cardinality: 'one' }],
        },
      },
    };
    mutate(config);
    expect(() => compileClaimPlan(config)).toThrow(message);
  });

  it('rejects a claim-consumption cycle', () => {
    const config: any = {
      version: '1.0',
      claim_types: {
        'fixture.a@1': { schema },
        'fixture.b@1': { schema },
      },
      checks: {
        a: {
          type: 'noop',
          emits: [{ claim: 'fixture.a@1', from: 'output' }],
          consumes: [{ claim: 'fixture.b@1', cardinality: 'one' }],
        },
        b: {
          type: 'noop',
          emits: [{ claim: 'fixture.b@1', from: 'output' }],
          consumes: [{ claim: 'fixture.a@1', cardinality: 'one' }],
        },
      },
    };
    expect(() => compileClaimPlan(config)).toThrow(ClaimPlanError);
    expect(() => compileClaimPlan(config)).toThrow('Claim dependency cycle detected');
  });

  it('preserves legacy dependency-only configuration', () => {
    const config: any = {
      version: '1.0',
      checks: { a: { type: 'noop' }, b: { type: 'noop', depends_on: 'a' } },
    };
    const plan = compileClaimPlan(config);
    expect(plan.active).toBe(false);
    expect(plan.effectiveDependenciesByCheck).toEqual({ a: [], b: ['a'] });
  });
});
