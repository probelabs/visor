import {
  compileJsonPointer,
  InstancePlanError,
  PROOF_ADMIT_PROVIDER_TYPE,
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_CANDIDATE_CLAIM,
  qualifiedNestedExpansionOwner,
  resolveJsonPointer,
} from '../../../../src/state-machine/graph/instance-plan';
import { compileClaimPlan } from '../../../../src/state-machine/graph/claim-plan';

function config(): any {
  return {
    version: '1.0',
    claim_types: {
      'component.catalog@1': {
        schema: {
          type: 'object',
          required: ['components'],
          properties: { components: { type: 'array' } },
        },
      },
      'component.item@1': {
        schema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
      'component.onboarded@1': {
        schema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    subgraphs: {
      'onboard-component': {
        input: { name: 'component', claim: 'component.item@1' },
        checks: {
          inspect: {
            type: 'noop',
            consumes: [{ claim: 'component.item@1', as: 'component' }],
            emits: [{ claim: 'component.onboarded@1', from: 'output' }],
          },
          summarize: {
            type: 'noop',
            consumes: [{ claim: 'component.onboarded@1', as: 'inspected' }],
          },
        },
      },
    },
    checks: {
      discover: {
        type: 'noop',
        emits: [{ claim: 'component.catalog@1', from: 'output' }],
        expand: {
          claim: 'component.catalog@1',
          template: 'onboard-component',
          items_pointer: '/components',
          key_pointer: '/id',
          item_claim: 'component.item@1',
        },
      },
    },
  };
}

function proofAdmissionConfig(): any {
  const value = config();
  Object.assign(value.claim_types, {
    [PROOF_CANDIDATE_CLAIM]: { schema: { type: 'object' } },
    [PROOF_ADMITTED_RECEIPT_CLAIM]: { schema: { type: 'object' } },
  });
  value.subgraphs['onboard-component'].checks = {
    inspect: {
      type: 'noop',
      consumes: [{ claim: 'component.item@1', as: 'component' }],
      emits: [{ claim: PROOF_CANDIDATE_CLAIM, from: 'output' }],
    },
    proof_admit: {
      type: PROOF_ADMIT_PROVIDER_TYPE,
      consumes: [{ claim: PROOF_CANDIDATE_CLAIM, as: 'candidate' }],
      emits: [{ claim: PROOF_ADMITTED_RECEIPT_CLAIM, from: 'output' }],
    },
    verify: {
      type: 'noop',
      consumes: [
        { claim: PROOF_CANDIDATE_CLAIM, as: 'candidate' },
        { claim: PROOF_ADMITTED_RECEIPT_CLAIM, as: 'receipt' },
      ],
    },
  };
  return value;
}

describe('Graph v2 C2 expansion plan', () => {
  it('compiles the exact reserved inspect -> proof_admit -> verify profile', () => {
    const plan = compileClaimPlan(proofAdmissionConfig()).expansionPlan;
    const template = plan.byOwner.discover.template;
    expect(template.templateNodeKeys).toEqual(['inspect', 'proof_admit', 'verify']);
    expect(template.topology).toEqual(template.templateNodeKeys);
    expect(template.emitterByClaim).toMatchObject({
      [PROOF_CANDIDATE_CLAIM]: 'inspect', [PROOF_ADMITTED_RECEIPT_CLAIM]: 'proof_admit',
    });
  });

  it.each([
    ['type without refs', (value: any) => {
      const checks = value.subgraphs['onboard-component'].checks;
      delete checks.inspect.emits;
      checks.proof_admit.consumes = [{ claim: 'component.item@1', as: 'component' }];
      checks.proof_admit.emits = [{ claim: 'component.onboarded@1', from: 'output' }];
      checks.verify.consumes = [{ claim: 'component.item@1', as: 'component' }];
    }],
    ['wrong key', (value: any) => {
      const checks = value.subgraphs['onboard-component'].checks;
      checks.admit = checks.proof_admit;
      delete checks.proof_admit;
    }],
    ['alternate claims', (value: any) => {
      const checks = value.subgraphs['onboard-component'].checks;
      value.claim_types['fixture.alternate@1'] = { schema: { type: 'object' } };
      checks.inspect.emits.push({ claim: 'fixture.alternate@1', from: 'output' });
      checks.proof_admit.consumes[0].claim = 'fixture.alternate@1';
    }],
    ['extra proof-admit use', (value: any) => {
      value.subgraphs['onboard-component'].checks.extra = { type: PROOF_ADMIT_PROVIDER_TYPE };
    }],
  ])('rejects reserved profile with %s before provider lookup', (_name, mutate) => {
    const value = proofAdmissionConfig();
    mutate(value);
    try {
      compileClaimPlan(value);
      throw new Error('expected reserved-profile rejection');
    } catch (error) {
      expect((error as InstancePlanError).code).toBe('RESERVED_PROOF_ADMISSION_PROFILE');
    }
  });

  it.each(['inspect', 'proof_admit', 'verify'])('rejects check.expand on reserved node %s', nodeKey => {
    const value = proofAdmissionConfig();
    value.subgraphs['onboard-component'].checks[nodeKey].expand = {};
    expect(() => compileClaimPlan(value)).toThrow('cannot use check.expand');
  });

  it('compiles exact immutable bindings, topology, pointers, and semantic digests', () => {
    const authored = config();
    const before = JSON.parse(JSON.stringify(authored));
    const claimPlan = compileClaimPlan(authored);
    const plan = claimPlan.expansionPlan;
    const expansion = plan.byOwner.discover;
    const template = expansion.template;

    expect(plan.active).toBe(true);
    expect(plan.graphSemanticDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(expansion.catalogClaimRef).toBe('component.catalog@1');
    expect(expansion.itemClaimRef).toBe('component.item@1');
    expect(expansion.itemsPointer).toEqual({ source: '/components', tokens: ['components'] });
    expect(expansion.keyPointer).toEqual({ source: '/id', tokens: ['id'] });
    expect(expansion.expansionSpecDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(template.templateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(template.topology).toEqual(['inspect', 'summarize']);
    expect(template.reverseTopology).toEqual(['summarize', 'inspect']);
    expect(template.sourceNodeKeys).toEqual(['inspect']);
    expect(template.nodesByKey.summarize.dependencyNodeKeys).toEqual(['inspect']);
    expect(template.nodesByKey.inspect.consumptions).toEqual([
      { claim: 'component.item@1', cardinality: 'one', as: 'component' },
    ]);
    expect(template.nodesByKey.inspect.executionConfigDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(authored).toEqual(before);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(expansion)).toBe(true);
    expect(Object.isFrozen(template.nodesByKey.inspect.check)).toBe(true);
    expect(Object.isFrozen(expansion.itemsPointer.tokens)).toBe(true);

    authored.subgraphs['onboard-component'].checks.inspect.timeout = 99;
    expect(template.nodesByKey.inspect.check.timeout).toBeUndefined();
  });

  it('keeps digests stable across authored map reordering and changes execution digest on semantics', () => {
    const first = compileClaimPlan(config()).expansionPlan;
    const reordered = config();
    reordered.claim_types = Object.fromEntries(Object.entries(reordered.claim_types).reverse());
    reordered.subgraphs['onboard-component'].checks = {
      summarize: reordered.subgraphs['onboard-component'].checks.summarize,
      inspect: reordered.subgraphs['onboard-component'].checks.inspect,
    };
    const second = compileClaimPlan(reordered).expansionPlan;
    expect(second.graphSemanticDigest).toBe(first.graphSemanticDigest);
    expect(second.byOwner.discover.templateDigest).toBe(first.byOwner.discover.templateDigest);

    const changed = config();
    changed.subgraphs['onboard-component'].checks.inspect.timeout = 1234;
    const third = compileClaimPlan(changed).expansionPlan;
    expect(third.byOwner.discover.template.nodesByKey.inspect.executionConfigDigest).not.toBe(
      first.byOwner.discover.template.nodesByKey.inspect.executionConfigDigest
    );
    expect(third.graphSemanticDigest).not.toBe(first.graphSemanticDigest);
  });

  it('compiles one parent-template-qualified depth-two expansion owner', () => {
    const value = config();
    value.claim_types['spec.catalog@1'] = {
      schema: { type: 'object', required: ['specs'], properties: { specs: { type: 'array' } } },
    };
    value.claim_types['spec.item@1'] = {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    };
    value.subgraphs['review-spec'] = {
      input: { name: 'spec', claim: 'spec.item@1' },
      checks: {
        review: {
          type: 'noop',
          consumes: [{ claim: 'spec.item@1', as: 'spec' }],
        },
      },
    };
    const inspect = value.subgraphs['onboard-component'].checks.inspect;
    inspect.emits.push({ claim: 'spec.catalog@1', from: 'output' });
    inspect.expand = {
      claim: 'spec.catalog@1',
      template: 'review-spec',
      items_pointer: '/specs',
      key_pointer: '/id',
      item_claim: 'spec.item@1',
    };

    const plan = compileClaimPlan(value).expansionPlan;
    const owner = qualifiedNestedExpansionOwner('onboard-component', 'inspect');
    expect(plan.byNestedOwner[owner]).toMatchObject({
      expansionOwnerCheck: owner,
      depth: 2,
      parentTemplateName: 'onboard-component',
      parentTemplateNodeKey: 'inspect',
      catalogClaimRef: 'spec.catalog@1',
      itemClaimRef: 'spec.item@1',
      templateName: 'review-spec',
    });
    expect(plan.byOwner.discover.depth).toBe(1);
    expect(plan.byNestedOwner[owner].expansionSpecDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('strictly compiles and resolves RFC 6901 pointers', () => {
    const pointer = compileJsonPointer('/a~1b/~0key/0', 'fixture');
    expect(pointer.tokens).toEqual(['a/b', '~key', '0']);
    expect(resolveJsonPointer({ 'a/b': { '~key': ['value'] } }, pointer)).toBe('value');
    expect(() => compileJsonPointer('components[0]', 'fixture')).toThrow(InstancePlanError);
    expect(() => compileJsonPointer('/bad~2escape', 'fixture')).toThrow('invalid RFC 6901 escape');
    expect(() => resolveJsonPointer({ list: [] }, compileJsonPointer('/list/00', 'fixture'))).toThrow(
      'does not resolve exactly'
    );
  });

  it.each([
    {
      name: 'missing subgraphs',
      mutate: (value: any) => delete value.subgraphs,
      code: 'INCOMPLETE_EXPANSION_CONFIG',
    },
    {
      name: 'unknown template',
      mutate: (value: any) => (value.checks.discover.expand.template = 'missing'),
      code: 'UNKNOWN_SUBGRAPH_TEMPLATE',
    },
    {
      name: 'item/template claim mismatch',
      mutate: (value: any) =>
        (value.checks.discover.expand.item_claim = 'component.onboarded@1'),
      code: 'ITEM_CLAIM_MISMATCH',
    },
    {
      name: 'recursive depth-three expansion',
      mutate: (value: any) => {
        value.subgraphs['onboard-component'].checks.inspect.emits.push({
          claim: 'component.catalog@1',
          from: 'output',
        });
        value.subgraphs['onboard-component'].checks.inspect.expand = {
          ...value.checks.discover.expand,
          template: 'onboard-component',
        };
      },
      code: 'NESTED_EXPANSION_DEPTH_EXCEEDED',
    },
    {
      name: 'template routing',
      mutate: (value: any) =>
        (value.subgraphs['onboard-component'].checks.inspect.on_success = { run: ['summarize'] }),
      code: 'UNSUPPORTED_TEMPLATE_EXECUTION',
    },
    {
      name: 'unknown static dependency',
      mutate: (value: any) =>
        (value.subgraphs['onboard-component'].checks.inspect.depends_on = 'missing'),
      code: 'UNKNOWN_TEMPLATE_CHECK',
    },
    {
      name: 'template cycle',
      mutate: (value: any) =>
        (value.subgraphs['onboard-component'].checks.inspect.depends_on = 'summarize'),
      code: 'TEMPLATE_CYCLE',
    },
    {
      name: 'controller claim forgery',
      mutate: (value: any) =>
        value.subgraphs['onboard-component'].checks.inspect.emits.push({
          claim: 'component.item@1',
          from: 'output',
        }),
      code: 'FORGED_CONTROLLER_ITEM_CLAIM',
    },
  ])('rejects $name before runtime', ({ mutate, code }) => {
    const value = config();
    mutate(value);
    try {
      compileClaimPlan(value);
      throw new Error('expected expansion plan rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(InstancePlanError);
      expect((error as InstancePlanError).code).toBe(code);
    }
  });

  it('preserves C1 and legacy configurations when expansion syntax is absent', () => {
    const legacy = compileClaimPlan({
      version: '1.0',
      checks: { first: { type: 'noop' }, second: { type: 'noop', depends_on: 'first' } },
    });
    expect(legacy.active).toBe(false);
    expect(legacy.expansionPlan.active).toBe(false);
    expect(legacy.effectiveDependenciesByCheck).toEqual({ first: [], second: ['first'] });

    const c1 = config();
    delete c1.subgraphs;
    delete c1.checks.discover.expand;
    expect(compileClaimPlan(c1).expansionPlan.active).toBe(false);
  });
});
