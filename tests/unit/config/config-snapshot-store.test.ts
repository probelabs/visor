import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  ConfigSnapshotStore,
  createSnapshotFromConfig,
} from '../../../src/config/config-snapshot-store';
import type { VisorConfig } from '../../../src/types/config';

describe('ConfigSnapshotStore', () => {
  let store: ConfigSnapshotStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-config-test-'));
    dbPath = path.join(tmpDir, 'config.db');
    store = new ConfigSnapshotStore(dbPath);
    await store.initialize();
  });

  afterEach(async () => {
    await store.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSnapshot(trigger: 'startup' | 'reload' = 'startup', hash?: string) {
    return {
      created_at: new Date().toISOString(),
      trigger,
      config_hash: hash || 'abcdef0123456789',
      config_yaml: 'version: "1.0"\nchecks: {}\n',
      source_path: '/tmp/test.visor.yaml',
    };
  }

  test('save and get a snapshot', async () => {
    const input = makeSnapshot();
    const saved = await store.save(input);

    expect(saved.id).toBeGreaterThan(0);
    expect(saved.trigger).toBe('startup');
    expect(saved.config_hash).toBe(input.config_hash);

    const fetched = await store.get(saved.id);
    expect(fetched).toBeDefined();
    expect(fetched!.config_yaml).toBe(input.config_yaml);
    expect(fetched!.source_path).toBe(input.source_path);
  });

  test('list returns snapshots in descending order', async () => {
    await store.save(makeSnapshot('startup', 'hash1111'));
    await store.save(makeSnapshot('reload', 'hash2222'));
    await store.save(makeSnapshot('reload', 'hash3333'));

    const list = await store.list();
    expect(list).toHaveLength(3);
    expect(list[0].config_hash).toBe('hash3333');
    expect(list[1].config_hash).toBe('hash2222');
    expect(list[2].config_hash).toBe('hash1111');
  });

  test('get returns undefined for non-existent id', async () => {
    const result = await store.get(999);
    expect(result).toBeUndefined();
  });

  test('auto-prunes to maxCount on save', async () => {
    await store.save(makeSnapshot('startup', 'hash1111'));
    await store.save(makeSnapshot('reload', 'hash2222'));
    await store.save(makeSnapshot('reload', 'hash3333'));
    // 4th save should prune the oldest
    await store.save(makeSnapshot('reload', 'hash4444'));

    const list = await store.list();
    expect(list).toHaveLength(3);
    // Oldest (hash1111) should be gone
    expect(list.find(s => s.config_hash === 'hash1111')).toBeUndefined();
    expect(list[0].config_hash).toBe('hash4444');
  });

  test('prune with custom maxCount', async () => {
    await store.save(makeSnapshot('startup', 'hash1111'), 10); // high limit initially
    await store.save(makeSnapshot('reload', 'hash2222'), 10);
    await store.save(makeSnapshot('reload', 'hash3333'), 10);

    const pruned = await store.prune(1);
    expect(pruned).toBe(2);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].config_hash).toBe('hash3333');
  });

  test('save with null source_path', async () => {
    const input = {
      ...makeSnapshot(),
      source_path: null,
    };
    const saved = await store.save(input);
    const fetched = await store.get(saved.id);
    expect(fetched!.source_path).toBeNull();
  });
});

describe('createSnapshotFromConfig', () => {
  test('creates snapshot with YAML and hash', () => {
    const config = {
      version: '1.0',
      checks: {},
      steps: {},
    } as VisorConfig;

    const snapshot = createSnapshotFromConfig(config, 'startup', '/test/config.yaml');

    expect(snapshot.trigger).toBe('startup');
    expect(snapshot.source_path).toBe('/test/config.yaml');
    expect(snapshot.config_hash).toHaveLength(16);
    expect(snapshot.config_yaml).toContain('version');
    expect(snapshot.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('produces consistent hash for same config', () => {
    const config = { version: '1.0', checks: {}, steps: {} } as VisorConfig;
    const a = createSnapshotFromConfig(config, 'startup', null);
    const b = createSnapshotFromConfig(config, 'reload', null);
    expect(a.config_hash).toBe(b.config_hash);
  });

  test('produces different hash for different configs', () => {
    const configA = { version: '1.0', checks: {}, steps: {} } as VisorConfig;
    const configB = { version: '2.0', checks: {}, steps: {} } as VisorConfig;
    const a = createSnapshotFromConfig(configA, 'startup', null);
    const b = createSnapshotFromConfig(configB, 'startup', null);
    expect(a.config_hash).not.toBe(b.config_hash);
  });
});
