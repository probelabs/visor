export type CountExpectation = {
  exactly?: number;
  at_least?: number;
  at_most?: number;
};

export interface CallsExpectation extends CountExpectation {
  step?: string;
  provider?: 'github' | string;
  op?: string;
  args?: Record<string, unknown>;
}

export interface PromptsExpectation {
  step: string;
  index?: number | 'first' | 'last';
  contains?: string[];
  not_contains?: string[];
  matches?: string; // regex string
  where?: {
    contains?: string[];
    not_contains?: string[];
    matches?: string; // regex
  };
}

export interface OutputsExpectation {
  step: string;
  index?: number | 'first' | 'last';
  path: string;
  equals?: unknown;
  equalsDeep?: unknown;
  matches?: string; // regex
  where?: {
    path: string;
    equals?: unknown;
    matches?: string; // regex
  };
  contains_unordered?: unknown[]; // array membership ignoring order
}

export interface ExpectBlock {
  use?: string[];
  calls?: CallsExpectation[];
  prompts?: PromptsExpectation[];
  outputs?: OutputsExpectation[];
  no_calls?: Array<{ step?: string; provider?: string; op?: string }>;
  fail?: { message_contains?: string };
  strict_violation?: { for_step?: string; message_contains?: string };
}

export function validateCounts(exp: CountExpectation): void {
  const keys = ['exactly', 'at_least', 'at_most'].filter(k => (exp as any)[k] !== undefined);
  if (keys.length > 1) {
    throw new Error(`Count expectation is ambiguous: ${keys.join(', ')}`);
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    const ak = Object.keys(a as any).sort();
    const bk = Object.keys(b as any).sort();
    if (!deepEqual(ak, bk)) return false;
    for (const k of ak) if (!deepEqual((a as any)[k], (b as any)[k])) return false;
    return true;
  }
  return false;
}

export function containsUnordered(haystack: unknown[], needles: unknown[]): boolean {
  if (!Array.isArray(haystack) || !Array.isArray(needles)) return false;
  const used = new Array(haystack.length).fill(false);
  outer: for (const n of needles) {
    for (let i = 0; i < haystack.length; i++) {
      if (used[i]) continue;
      if (deepEqual(haystack[i], n) || haystack[i] === n) {
        used[i] = true;
        continue outer;
      }
    }
    return false;
  }
  return true;
}
