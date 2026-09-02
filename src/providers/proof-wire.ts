import { createHash } from 'crypto';

function proofJSON(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number is not JSON');
    // Go's encoding/json preserves the sign of a decoded negative zero.
    if (Object.is(value, -0)) return '-0';
  }
  if (typeof value === 'string' && !validUnicode(value)) throw new Error('unpaired UTF-16 surrogate is not JSON');
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('value is not JSON');
  // encoding/json escapes these characters by default.
  return encoded.replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Proof CanonicalJSON for values at a governed Proof boundary. */
export function proofCanonicalJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (current: unknown): string => {
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') return proofJSON(current);
    if (Array.isArray(current)) {
      if (active.has(current)) throw new Error('value is cyclic');
      if (Reflect.ownKeys(current).some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) || Array.from({ length: current.length }, (_, index) => index).some(index => !Object.prototype.hasOwnProperty.call(current, String(index)))) throw new Error('array is not a dense JSON array');
      active.add(current);
      try { return `[${current.map(item => encode(item)).join(',')}]`; }
      finally { active.delete(current); }
    }
    if (!current || typeof current !== 'object' || (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) || Reflect.ownKeys(current).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(current, key))) throw new Error('value is not a JSON object');
    if (active.has(current)) throw new Error('value is cyclic');
    active.add(current);
    try {
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
      return `{${keys.map(key => `${proofJSON(key)}:${encode(record[key])}`).join(',')}}`;
    } finally { active.delete(current); }
  };
  return encode(value);
}

/** Sort only a Proof receipt's outer map; nested struct values are pre-encoded. */
export function proofTopLevelJson(fields: Readonly<Record<string, string>>): string {
  return `{${Object.keys(fields).sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))).map(key => `${proofJSON(key)}:${fields[key]}`).join(',')}}`;
}

/** Rebuild a JSON value in Proof's canonical key order and freeze it. */
export function immutableProofCanonicalValue<T>(value: T): T {
  const parsed = JSON.parse(proofCanonicalJson(value)) as unknown;
  const freeze = (current: unknown): unknown => {
    if (current && typeof current === 'object') {
      for (const child of Object.values(current as Record<string, unknown>)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(parsed) as T;
}

/** Proof's governed result identity digest over canonical UTF-8 bytes. */
export function proofGovernedResultDigest(value: unknown): string {
  const bytes = Buffer.from(proofCanonicalJson(value), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update('probe.governed-result-identity/data/v1').update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}

/** Plain SHA-256 over Proof's canonical JSON bytes (claim payload fingerprint). */
export function proofPayloadFingerprint(value: unknown): string {
  return createHash('sha256').update(proofCanonicalJson(value), 'utf8').digest('hex');
}
