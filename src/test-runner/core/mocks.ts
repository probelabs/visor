export class MockManager {
  private mocks: Record<string, unknown> = {};
  private cursors: Record<string, number> = {};
  private consumed: Set<string> = new Set();

  constructor(mocks?: Record<string, unknown>) {
    if (mocks && typeof mocks === 'object') this.mocks = { ...mocks };
  }

  reset(overrides?: Record<string, unknown>): void {
    this.cursors = {};
    this.consumed = new Set();
    this.mocks = { ...this.mocks, ...(overrides || {}) };
  }

  get(step: string): unknown {
    const listKey = `${step}[]`;
    const list = (this.mocks as any)[listKey];
    if (Array.isArray(list)) {
      const i = this.cursors[listKey] || 0;
      const idx = i < list.length ? i : list.length - 1;
      this.cursors[listKey] = i + 1;
      return list[idx];
    }
    const val = (this.mocks as any)[step];
    if (val !== undefined) this.consumed.add(step);
    return val;
  }

  /** Returns true if the mock for this step was already consumed (scalar) or has no more items (array). */
  isExhausted(step: string): boolean {
    const listKey = `${step}[]`;
    const list = (this.mocks as any)[listKey];
    if (Array.isArray(list)) {
      const i = this.cursors[listKey] || 0;
      return i >= list.length;
    }
    return this.consumed.has(step);
  }

  /** Returns true if a mock exists for this step (scalar or array). */
  has(step: string): boolean {
    return (
      (this.mocks as any)[step] !== undefined || Array.isArray((this.mocks as any)[`${step}[]`])
    );
  }
}
