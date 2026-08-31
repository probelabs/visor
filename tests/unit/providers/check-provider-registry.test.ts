import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import {
  CheckProvider,
  CheckProviderConfig,
} from '../../../src/providers/check-provider.interface';
import { PRInfo } from '../../../src/pr-analyzer';
import { ReviewSummary } from '../../../src/reviewer';
import { createProofAdmitProviderForFocusedTest, ProofAdmitCheckProvider } from '../../../src/providers/proof-admit-check-provider';
import { PROOF_CANDIDATE_CLAIM } from '../../../src/state-machine/graph/instance-plan';
import { immutableCanonicalValue, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';
import { GovernedProofInspectCheckProvider } from '../../../src/providers/governed-proof-inspect-check-provider';

const admissionCandidate = (payload: any = { evidence: 'fixture' }): any => ({
  provenance: 'attempt', claimId: 'candidate-1', claim: PROOF_CANDIDATE_CLAIM, payload,
  payloadFingerprint: sha256Canonical(payload), producerCheckId: 'inspect', attemptId: 'attempt-1', fence: 1,
  scope: [{ key: 'A' }], parentClaimIds: [],
});
const admissionReceipt = (candidate: any): any => ({ version: 1, kind: 'admitted', candidateClaimId: candidate.claimId,
  candidateClaim: PROOF_CANDIDATE_CLAIM, candidateFingerprint: candidate.payloadFingerprint,
  candidateAttemptId: candidate.attemptId, candidateFence: candidate.fence, scope: candidate.scope, parentClaimIds: candidate.parentClaimIds });

// Mock provider for testing
class MockCheckProvider extends CheckProvider {
  constructor(private name: string) {
    super();
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string {
    return `Mock ${this.name} provider`;
  }

  async validateConfig(_config: unknown): Promise<boolean> {
    return true;
  }

  async execute(_prInfo: PRInfo, _config: CheckProviderConfig): Promise<ReviewSummary> {
    return {
      issues: [],
    };
  }

  getSupportedConfigKeys(): string[] {
    return ['type'];
  }

  async isAvailable(): Promise<boolean> {
    return this.name !== 'unavailable';
  }

  getRequirements(): string[] {
    return [`${this.name} requirements`];
  }
}

describe('CheckProviderRegistry', () => {
  let registry: CheckProviderRegistry;

  beforeEach(() => {
    // Clear singleton instance before each test
    CheckProviderRegistry.clearInstance();
    registry = CheckProviderRegistry.getInstance();
  });

  afterEach(() => {
    CheckProviderRegistry.clearInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = CheckProviderRegistry.getInstance();
      const instance2 = CheckProviderRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should register default providers', () => {
      const providers = registry.getAvailableProviders();
      expect(providers).toContain('ai');
      expect(providers).toContain('command');
      expect(providers).toContain('http');
      expect(providers).toContain('http_input');
      expect(providers).toContain('http_client');
      expect(providers).toContain('noop');
      expect(providers).toContain('proof-admit');
      expect(providers).toContain('governed-proof-inspect');
      expect(registry.getProvider('governed-proof-inspect')).toBeInstanceOf(GovernedProofInspectCheckProvider);
    });
  });

  describe('register', () => {
    it('should register a new provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      expect(registry.hasProvider('custom')).toBe(true);
    });

    it('should throw error for duplicate provider', () => {
      const provider1 = new MockCheckProvider('custom');
      const provider2 = new MockCheckProvider('custom');

      registry.register(provider1);
      expect(() => registry.register(provider2)).toThrow("Provider 'custom' is already registered");
    });

    it('seals the reserved proof-admit name from public replacement', () => {
      expect(() => registry.register(new MockCheckProvider('proof-admit'))).toThrow(
        "Provider 'proof-admit' is reserved"
      );
      expect(() => registry.register(new MockCheckProvider('governed-proof-inspect'))).toThrow(
        "Provider 'governed-proof-inspect' is reserved"
      );
      expect(registry.getProvider('proof-admit')).toBeInstanceOf(ProofAdmitCheckProvider);
    });
  });

  describe('unregister', () => {
    it('should unregister a provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      registry.unregister('custom');
      expect(registry.hasProvider('custom')).toBe(false);
    });

    it('should throw error for non-existent provider', () => {
      expect(() => registry.unregister('nonexistent')).toThrow("Provider 'nonexistent' not found");
    });

    it('seals the reserved proof-admit name from removal', () => {
      expect(() => registry.unregister('proof-admit')).toThrow(
        "Provider 'proof-admit' is reserved"
      );
      expect(() => registry.unregister('governed-proof-inspect')).toThrow(
        "Provider 'governed-proof-inspect' is reserved"
      );
      expect(registry.hasProvider('proof-admit')).toBe(true);
    });
  });

  describe('getProvider', () => {
    it('should return registered provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      const retrieved = registry.getProvider('custom');
      expect(retrieved).toBe(provider);
    });

    it('should return undefined for non-existent provider', () => {
      const retrieved = registry.getProvider('nonexistent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getProviderOrThrow', () => {
    it('should return registered provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      const retrieved = registry.getProviderOrThrow('custom');
      expect(retrieved).toBe(provider);
    });

    it('should throw error for non-existent provider', () => {
      expect(() => registry.getProviderOrThrow('nonexistent')).toThrow(
        /Check provider 'nonexistent' not found/
      );
    });
  });

  describe('hasProvider', () => {
    it('should return true for registered provider', () => {
      const provider = new MockCheckProvider('custom');
      registry.register(provider);
      expect(registry.hasProvider('custom')).toBe(true);
    });

    it('should return false for non-existent provider', () => {
      expect(registry.hasProvider('nonexistent')).toBe(false);
    });
  });

  describe('getAvailableProviders', () => {
    it('should return all registered provider names', () => {
      registry.reset(); // Clear default providers

      const provider1 = new MockCheckProvider('provider1');
      const provider2 = new MockCheckProvider('provider2');

      registry.register(provider1);
      registry.register(provider2);

      const providers = registry.getAvailableProviders();
      expect(providers).toContain('provider1');
      expect(providers).toContain('provider2');
    });
  });

  describe('getAllProviders', () => {
    it('should return all provider instances', () => {
      registry.reset();

      const provider1 = new MockCheckProvider('provider1');
      const provider2 = new MockCheckProvider('provider2');

      registry.register(provider1);
      registry.register(provider2);

      const providers = registry.getAllProviders();
      expect(providers).toContain(provider1);
      expect(providers).toContain(provider2);
      // Reset adds 19 default providers, including both sealed proof providers, + 2 custom.
      expect(providers.length).toBe(21);
    });
  });

  describe('getActiveProviders', () => {
    it('should return only available providers', async () => {
      registry.reset();

      const availableProvider = new MockCheckProvider('available');
      const unavailableProvider = new MockCheckProvider('unavailable');

      registry.register(availableProvider);
      registry.register(unavailableProvider);

      const activeProviders = await registry.getActiveProviders();
      expect(activeProviders).toContain(availableProvider);
      expect(activeProviders).not.toContain(unavailableProvider);
    });
  });

  describe('listProviders', () => {
    it('should return provider information', async () => {
      registry.reset();

      const provider = new MockCheckProvider('custom');
      registry.register(provider);

      const info = await registry.listProviders();
      const customInfo = info.find(p => p.name === 'custom');

      expect(customInfo).toBeDefined();
      expect(customInfo?.description).toBe('Mock custom provider');
      expect(customInfo?.available).toBe(true);
      expect(customInfo?.requirements).toEqual(['custom requirements']);
    });
  });

  describe('reset', () => {
    it('should clear all providers and re-register defaults', () => {
      const customProvider = new MockCheckProvider('custom');
      registry.register(customProvider);

      registry.reset();

      expect(registry.hasProvider('custom')).toBe(false);
      expect(registry.hasProvider('ai')).toBe(true);
      expect(registry.hasProvider('command')).toBe(true);
      expect(registry.hasProvider('http')).toBe(true);
      expect(registry.hasProvider('http_input')).toBe(true);
      expect(registry.hasProvider('http_client')).toBe(true);
      expect(registry.hasProvider('noop')).toBe(true);
      expect(registry.getProvider('proof-admit')).toBeInstanceOf(ProofAdmitCheckProvider);
    });
  });

  const executeAdmission = (decision: any, candidate: any) => createProofAdmitProviderForFocusedTest({
    decide: () => decision(candidate),
  }).execute({} as PRInfo, { type: 'proof-admit' } as any, undefined, { claims: { candidate } } as any);

  it.each([
    ['malformed', () => ({ kind: 'accepted', receipt: {} }), 'PROOF_ADMISSION_INVALID_RECEIPT'],
    ['mismatched', (candidate: any) => ({ kind: 'accepted', receipt: immutableCanonicalValue({ ...admissionReceipt(candidate), candidateClaimId: 'forged' }) }), 'PROOF_ADMISSION_INVALID_RECEIPT'],
    ['parent mismatch', (candidate: any) => ({ kind: 'accepted', receipt: immutableCanonicalValue({ ...admissionReceipt(candidate), parentClaimIds: ['forged'] }) }), 'PROOF_ADMISSION_INVALID_RECEIPT'],
    ['mutable', (candidate: any) => ({ kind: 'accepted', receipt: admissionReceipt(candidate) }), 'PROOF_ADMISSION_INVALID_RECEIPT'],
    ['rejected', () => ({ kind: 'rejected', reason: 'fixture' }), 'PROOF_ADMISSION_REJECTED'],
  ])('publishes no authority for %s sink result', async (_name, decision, error) => {
    await expect(executeAdmission(decision, admissionCandidate())).rejects.toThrow(error);
  });

  it('detaches a valid deeply frozen sink receipt', async () => {
    const candidate = admissionCandidate();
    let outerDecision: any;
    const result = await executeAdmission((value: any) => (outerDecision = { kind: 'accepted', receipt: immutableCanonicalValue(admissionReceipt(value)) }), candidate);
    expect(Object.isFrozen(outerDecision)).toBe(false);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen((result.output as any).parentClaimIds)).toBe(true);
    expect((result.output as any).parentClaimIds).toEqual(candidate.parentClaimIds);
  });
});
