import { createSyncMemoryOps } from '../../../src/utils/script-memory-ops';
import { MemoryStore } from '../../../src/memory-store';

describe('createSyncMemoryOps', () => {
  beforeEach(() => MemoryStore.resetInstance());

  it('set/get/increment/append/delete/clear work as expected', async () => {
    const store = MemoryStore.getInstance({ storage: 'memory' });
    await store.initialize();
    const { ops, needsSave } = createSyncMemoryOps(store);

    expect(ops.get('k')).toBeUndefined();
    ops.set('k', 1);
    expect(ops.get('k')).toBe(1);
    expect(needsSave()).toBe(true);

    const v = ops.increment('k', 2);
    expect(v).toBe(3);
    expect(ops.get('k')).toBe(3);

    const arr = ops.append('list', 'a');
    expect(Array.isArray(arr)).toBe(true);
    const arr2 = ops.append('list', 'b');
    expect(arr2).toEqual(['a', 'b']);

    expect(ops.has('list')).toBe(true);
    expect(ops.list().length).toBeGreaterThan(0);

    const del = ops.delete('k');
    expect(del).toBe(true);
    expect(ops.get('k')).toBeUndefined();

    ops.clear();
    expect(ops.list().length).toBe(0);
  });
});
