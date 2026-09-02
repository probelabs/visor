import { describe, expect, it } from '@jest/globals';
import { validateGovernedGraphTerminalReceipt } from '../../src/governed-graph-terminal-receipt';

const idA = 'a'.repeat(64); const idB = 'b'.repeat(64); const idC = 'c'.repeat(64); const idD = 'd'.repeat(64); const idE = 'e'.repeat(64); const idF = 'f'.repeat(64); const idG = '1'.repeat(64); const idH = '2'.repeat(64); const idI = '3'.repeat(64); const idJ = '4'.repeat(64); const idK = '5'.repeat(64); const idL = '6'.repeat(64);
const attestation = { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', dispatch: { source: 'probe-host-tools-call', tool: 'codex' }, eventCount: 1, usage: { status: 'unavailable' } };

function component(key: string, scopeId: string, offset: string): any {
  const candidate = offset.repeat(64); const admitted = (offset === 'a' ? 'b' : offset === 'c' ? 'd' : 'f').repeat(64);
  return {
    componentKey: key,
    scope: [{ kind: 'keyed', expansionOwnerCheck: 'discover', key, subgraphInstanceId: scopeId }],
    workItemClaimId: ('1' + offset).repeat(32), candidateClaimId: candidate, admittedReceiptClaimId: admitted,
    generation: { inspect: { generationId: ('2' + offset).repeat(32), status: 'completed' }, proof_admit: { generationId: ('3' + offset).repeat(32), status: 'completed' }, verify: { generationId: ('4' + offset).repeat(32), status: 'completed' } },
    verifyInputClaimIds: [candidate, admitted], attestation, status: 'passed', cleanupStatus: 'clean',
  };
}

function receipt(): any {
  return {
    version: 'visor.governed-graph-terminal-receipt/v2', status: 'passed', sourceConfigSha256: idA, sessionId: 'session', graphSemanticDigest: idB, componentCount: 3,
    nodes: { inspect: { terminalCount: 3, status: 'completed' }, proof_admit: { terminalCount: 3, status: 'completed' }, verify: { terminalCount: 3, status: 'completed' } },
    discovery: { candidateClaimId: idC, admittedReceiptClaimId: idD, verifyInputClaimIds: [idC], structuralInventoryClaimId: idH, catalogRevalidationClaimId: idI, projectReconciliationClaimId: idJ, projectReconciliationInputClaimIds: [idI, idB, idD, idF].sort(), attestation: null, status: 'completed' },
    components: [component('http-adapter', idE, 'a'), component('service-policy', idF, 'c'), component('storage-domain', idG, 'e')],
    providerCleanupStatus: 'clean', managedUncleanTerminalCount: 0, activeChildren: 0, activeResources: 0, memoryStatus: 'clean', projectionReplayEqual: true, failureCode: null, exitStatus: 0,
  };
}

describe('EXP-0209 multi-component governed terminal receipt', () => {
  it('accepts a canonical complete discovery plus sorted component projection', () => {
    expect(() => validateGovernedGraphTerminalReceipt(receipt())).not.toThrow();
  });

  it('rejects duplicate or unsorted component entries and incomplete verify inputs', () => {
    const duplicate = receipt(); duplicate.components[1] = { ...duplicate.components[0] }; expect(() => validateGovernedGraphTerminalReceipt(duplicate)).toThrow(/sorted|duplicate/);
    const incomplete = receipt(); incomplete.components[0] = { ...incomplete.components[0], verifyInputClaimIds: [incomplete.components[0].candidateClaimId] }; expect(() => validateGovernedGraphTerminalReceipt(incomplete)).toThrow();
    const missing = receipt(); missing.components = missing.components.slice(0, 2); expect(() => validateGovernedGraphTerminalReceipt(missing)).toThrow();
  });

  it('rejects absent and nonterminal component generations even for a failed receipt', () => {
    for (const status of ['absent', 'nonterminal']) {
      const value = receipt(); value.status = 'failed'; value.exitStatus = 1;
      value.components[0] = { ...value.components[0], status: 'failed', generation: { ...value.components[0].generation, verify: { generationId: status === 'absent' ? null : idL, status } } };
      expect(() => validateGovernedGraphTerminalReceipt(value)).toThrow(/incomplete/);
    }
  });

  it('rejects a component entry whose key is foreign to its keyed scope', () => {
    const value = receipt(); value.components[0] = { ...value.components[0], componentKey: 'foreign-component' };
    expect(() => validateGovernedGraphTerminalReceipt(value)).toThrow(/component receipt/);
  });

  it('rejects nonterminal aggregate state and foreign reconciliation parents for failed receipts', () => {
    const nonterminal = receipt(); nonterminal.status = 'failed'; nonterminal.exitStatus = 1; nonterminal.nodes.verify = { terminalCount: 2, status: 'nonterminal' };
    expect(() => validateGovernedGraphTerminalReceipt(nonterminal)).toThrow(/nonterminal aggregate/);
    const absent = receipt(); absent.status = 'failed'; absent.exitStatus = 1; absent.nodes.verify = { terminalCount: 0, status: 'absent' };
    expect(() => validateGovernedGraphTerminalReceipt(absent)).toThrow(/nonterminal aggregate/);
    const foreign = receipt(); foreign.discovery = { ...foreign.discovery, projectReconciliationInputClaimIds: [...foreign.discovery.projectReconciliationInputClaimIds, idA].sort() };
    expect(() => validateGovernedGraphTerminalReceipt(foreign)).toThrow(/reconciliation inputs/);
  });
});
