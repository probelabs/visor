export class MockManager {
  private mocks: Record<string, unknown> = {};
  private cursors: Record<string, number> = {};

  constructor(mocks?: Record<string, unknown>) {
    if (mocks && typeof mocks === 'object') this.mocks = { ...mocks };
  }

  reset(overrides?: Record<string, unknown>): void {
    this.cursors = {};
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
    return (this.mocks as any)[step];
  }
}
