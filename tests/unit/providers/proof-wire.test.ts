import { describe, expect, it } from '@jest/globals';
import { governedCanonicalJson, governedPayloadFingerprint, immutableGovernedValue, immutableProofCanonicalValue, proofCanonicalJson, proofGovernedResultDigest, proofPayloadFingerprint } from '../../../src/providers/proof-wire';
import { canonicalJson, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';

describe('Proof canonical wire', () => {
  it('uses Go JSON escaping and UTF-8 bytewise key order', () => {
    const value = { text: '<>&\u2028\u2029', '\u{10000}': 'astral', '\uE000': 'private-use' };
    expect(proofCanonicalJson(value)).toBe('{"text":"\\u003c\\u003e\\u0026\\u2028\\u2029","\uE000":"private-use","\u{10000}":"astral"}');
    expect(Object.keys(immutableProofCanonicalValue(value))).toEqual(['text', '\uE000', '\u{10000}']);
  });

  it('rejects non-finite values, sparse arrays, and unpaired UTF-16 surrogates', () => {
    expect(() => proofCanonicalJson(Number.NaN)).toThrow();
    expect(() => proofCanonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => proofCanonicalJson(Object.assign([], { 1: 'hole' }))).toThrow();
    expect(() => proofCanonicalJson('\uD800')).toThrow();
    expect(() => proofCanonicalJson({ '\uDC00': 'bad' })).toThrow();
  });

  it('binds digests to Proof bytes and preserves negative zero', () => {
    expect(proofCanonicalJson(-0)).toBe('-0');
    expect(proofPayloadFingerprint({ '\uE000': 1, '\u{10000}': 2 })).toBe(proofPayloadFingerprint({ '\u{10000}': 2, '\uE000': 1 }));
    expect(proofGovernedResultDigest({ value: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps historical generic candidates on graph JSON semantics', () => {
    const value = { text: '<>&', '\u{10000}': 2, '\uE000': 1, n: -0 };
    expect(governedCanonicalJson(value, 'generic')).toBe(canonicalJson(value));
    expect(governedPayloadFingerprint(value, 'generic')).toBe(sha256Canonical(value));
    expect(Object.is((immutableGovernedValue(value, 'generic') as any).n, 0)).toBe(true);
    expect(governedCanonicalJson(value, 'proof')).toContain('\\u003c');
  });
});
