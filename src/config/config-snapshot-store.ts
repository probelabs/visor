/**
 * SQLite-backed config snapshot store
 *
 * Uses better-sqlite3 loaded via createRequire to avoid ncc bundling the native addon.
 * Schema migration is inline (no external migration files — ncc-safe).
 * WAL mode is enabled for better concurrent read performance.
 * Auto-prunes to keep at most 3 snapshots (configurable).
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../logger';
import type { ConfigSnapshot, ConfigSnapshotSummary } from './types';
import type { VisorConfig } from '../types/config';

// Type declarations for better-sqlite3 (avoid importing the module at compile time)
interface BetterSqliteDatabase {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): BetterSqliteStatement;
  close(): void;
}

interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

const DEFAULT_MAX_SNAPSHOTS = 3;

export class ConfigSnapshotStore {
  private db: BetterSqliteDatabase | null = null;
  private dbPath: string;

  constructor(filename?: string) {
    this.dbPath = filename || '.visor/config.db';
  }

  async initialize(): Promise<void> {
    const resolvedPath = path.resolve(process.cwd(), this.dbPath);
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });

    // Load better-sqlite3 via createRequire (ncc-safe)
    const { createRequire } = require('module') as typeof import('module');
    const runtimeRequire = createRequire(__filename);
    let Database: new (filename: string) => BetterSqliteDatabase;
    try {
      Database = runtimeRequire('better-sqlite3');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          'better-sqlite3 is required for config snapshots. ' +
            'Install it with: npm install better-sqlite3'
        );
      }
      throw err;
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.migrateSchema();
    logger.debug(`[ConfigSnapshotStore] Initialized at ${this.dbPath}`);
  }

  async shutdown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private migrateSchema(): void {
    const db = this.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at   TEXT NOT NULL,
        trigger      TEXT NOT NULL,
        config_hash  TEXT NOT NULL,
        config_yaml  TEXT NOT NULL,
        source_path  TEXT
      );
    `);
  }

  private getDb(): BetterSqliteDatabase {
    if (!this.db) {
      throw new Error('[ConfigSnapshotStore] Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  async save(
    snapshot: Omit<ConfigSnapshot, 'id'>,
    maxCount: number = DEFAULT_MAX_SNAPSHOTS
  ): Promise<ConfigSnapshot> {
    const db = this.getDb();
    const stmt = db.prepare(
      `INSERT INTO config_snapshots (created_at, trigger, config_hash, config_yaml, source_path)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      snapshot.created_at,
      snapshot.trigger,
      snapshot.config_hash,
      snapshot.config_yaml,
      snapshot.source_path
    );

    // Auto-prune old snapshots beyond maxCount
    await this.prune(maxCount);

    const id = (result as any).lastInsertRowid ?? this.getLastInsertId(db);
    return { ...snapshot, id: typeof id === 'bigint' ? Number(id) : (id as number) };
  }

  private getLastInsertId(db: BetterSqliteDatabase): number {
    const row = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
    return row.id;
  }

  async list(): Promise<ConfigSnapshotSummary[]> {
    const db = this.getDb();
    const rows = db
      .prepare(
        'SELECT id, created_at, trigger, config_hash, source_path FROM config_snapshots ORDER BY id DESC'
      )
      .all() as ConfigSnapshotSummary[];
    return rows;
  }

  async get(id: number): Promise<ConfigSnapshot | undefined> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM config_snapshots WHERE id = ?').get(id) as
      | ConfigSnapshot
      | undefined;
    return row;
  }

  async prune(maxCount: number = DEFAULT_MAX_SNAPSHOTS): Promise<number> {
    const db = this.getDb();
    // Delete oldest snapshots beyond the limit
    const result = db
      .prepare(
        `DELETE FROM config_snapshots WHERE id NOT IN (
           SELECT id FROM config_snapshots ORDER BY id DESC LIMIT ?
         )`
      )
      .run(maxCount);
    if (result.changes > 0) {
      logger.debug(`[ConfigSnapshotStore] Pruned ${result.changes} old snapshot(s)`);
    }
    return result.changes;
  }
}

/**
 * Create a snapshot record from a resolved VisorConfig.
 */
export function createSnapshotFromConfig(
  config: VisorConfig,
  trigger: 'startup' | 'reload',
  sourcePath: string | null
): Omit<ConfigSnapshot, 'id'> {
  const yaml = require('js-yaml') as typeof import('js-yaml');
  const configYaml = yaml.dump(config, { sortKeys: true, lineWidth: 120 });
  const hash = crypto.createHash('sha256').update(configYaml).digest('hex').slice(0, 16);

  return {
    created_at: new Date().toISOString(),
    trigger,
    config_hash: hash,
    config_yaml: configYaml,
    source_path: sourcePath,
  };
}
