import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureCheckinDatabaseSchema } from './checkinDatabaseBootstrap.js';
import { CHECKIN_RETAINED_TABLES, CHECKIN_RETIRED_TABLES, CHECKIN_SCHEMA_VERSION, CHECKIN_SETTINGS_KEYS, CHECKIN_TABLE_DDL } from './db/checkinSchema.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'checkin-bootstrap-'));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function protectedSettings(db: Database.Database): Array<{ key: string; value: string }> {
  return db.prepare(
    'SELECT "key", "value" FROM settings WHERE "key" IN (?, ?, ?, ?, ?) ORDER BY "key"',
  ).all(...CHECKIN_SETTINGS_KEYS) as Array<{ key: string; value: string }>;
}

describe('standalone check-in database bootstrap', () => {
  it('creates exactly the retained tables on an empty database and is idempotent', () => {
    const path = join(tempRoot, 'empty.db');
    const db = new Database(path);
    try {
      const first = ensureCheckinDatabaseSchema(db);
      expect(first.createdTables).toEqual([...CHECKIN_RETAINED_TABLES]);
      expect(CHECKIN_RETAINED_TABLES).toHaveLength(9);
      expect(tables(db)).toEqual([...CHECKIN_RETAINED_TABLES].sort());
      expect(first.extraTables).toEqual([]);
      expect(db.pragma('user_version', { simple: true })).toBe(CHECKIN_SCHEMA_VERSION);
      expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual([]);

      const second = ensureCheckinDatabaseSchema(db);
      expect(second.createdTables).toEqual([]);
      expect(second.createdIndexes).toBe(0);
      expect(second.droppedTables).toEqual([]);
      expect(tables(db)).toEqual([...CHECKIN_RETAINED_TABLES].sort());
      expect(db.pragma('user_version', { simple: true })).toBe(CHECKIN_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('prunes only retired tables while preserving retained rows and foreign keys', () => {
    const path = join(tempRoot, 'full.db');
    const db = new Database(path);
    try {
      db.pragma('foreign_keys = ON');
      ensureCheckinDatabaseSchema(db);
      db.exec('CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at integer)');
      db.exec('CREATE TABLE proxy_logs (id integer PRIMARY KEY, payload text)');
      db.exec('CREATE TABLE token_routes (id integer PRIMARY KEY)');
      db.exec('CREATE TABLE route_channels (id integer PRIMARY KEY)');
      db.exec('CREATE TABLE events (id integer PRIMARY KEY)');
      db.exec('INSERT INTO sites (name, url, platform) VALUES (\'New API\', \'https://new.example\', \'new-api\')');
      const siteId = Number((db.prepare('SELECT id FROM sites LIMIT 1').get() as { id: number }).id);
      db.prepare('INSERT INTO accounts (site_id, access_token) VALUES (?, ?)').run(siteId, 'secret');
      const accountId = Number((db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number }).id);
      db.prepare('INSERT INTO checkin_logs (account_id, status, message) VALUES (?, ?, ?)').run(accountId, 'success', 'ok');
      for (const [key, value] of [
        ['auth_token', 'session-secret'],
        ['checkin_cron', '17 8 * * *'],
        ['legacy_proxy', 'remove-me'],
      ] as const) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      const protectedSettingsBefore = JSON.stringify(protectedSettings(db));
      db.prepare('INSERT INTO proxy_logs (payload) VALUES (?)').run('old');
      db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('old', 1);

      const result = ensureCheckinDatabaseSchema(db, { prune: true });
      expect(result.droppedTables).toEqual(['__drizzle_migrations', 'route_channels', 'token_routes', 'proxy_logs', 'events']);
      expect(result.deletedSettingsKeys).toEqual(['legacy_proxy']);
      expect(tables(db)).toEqual([...CHECKIN_RETAINED_TABLES].sort());
      expect(CHECKIN_RETIRED_TABLES.every((table) => !tables(db).includes(table))).toBe(true);
      expect(Number((db.prepare('SELECT count(*) AS count FROM sites').get() as { count: number }).count)).toBe(1);
      expect(Number((db.prepare('SELECT count(*) AS count FROM accounts').get() as { count: number }).count)).toBe(1);
      expect(Number((db.prepare('SELECT count(*) AS count FROM checkin_logs').get() as { count: number }).count)).toBe(1);
      expect(JSON.stringify(protectedSettings(db))).toBe(protectedSettingsBefore);
      expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
        { key: 'auth_token', value: 'session-secret' },
        { key: 'checkin_cron', value: '17 8 * * *' },
      ]);
      expect(db.pragma('user_version', { simple: true })).toBe(CHECKIN_SCHEMA_VERSION);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      const idempotent = ensureCheckinDatabaseSchema(db, { prune: true });
      expect(idempotent.droppedTables).toEqual([]);
      expect(idempotent.deletedSettingsKeys).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rejects pruning when an unknown table is present', () => {
    const db = new Database(':memory:');
    try {
      ensureCheckinDatabaseSchema(db);
      db.exec('CREATE TABLE custom_unknown (id integer PRIMARY KEY)');
      expect(() => ensureCheckinDatabaseSchema(db, { prune: true })).toThrow(/unrecognized tables/u);
      expect(tables(db)).toContain('custom_unknown');
    } finally {
      db.close();
    }
  });

  it('does not write schema metadata in readonly mode', () => {
    const db = new Database(':memory:');
    try {
      ensureCheckinDatabaseSchema(db);
      db.pragma('user_version = 0');
      db.exec('CREATE TABLE proxy_logs (id integer PRIMARY KEY, payload text)');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('legacy_proxy', 'keep-in-readonly');
      const settingsBefore = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
      const databaseVersionBefore = Number(db.pragma('user_version', { simple: true }));
      const result = ensureCheckinDatabaseSchema(db, { readonly: true });
      expect(result.schemaVersion).toBe(CHECKIN_SCHEMA_VERSION);
      expect(db.pragma('user_version', { simple: true })).toBe(0);
      expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(settingsBefore);
      expect(tables(db)).toContain('proxy_logs');
      expect(result.deletedSettingsKeys).toEqual([]);
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(databaseVersionBefore);
    } finally {
      db.close();
    }
  });

  it('rejects an unsupported schema version', () => {
    const db = new Database(':memory:');
    try {
      ensureCheckinDatabaseSchema(db);
      db.pragma('user_version = 99');
      expect(() => ensureCheckinDatabaseSchema(db, { readonly: true })).toThrow(/Unsupported check-in schema version/u);
      expect(db.pragma('user_version', { simple: true })).toBe(99);
    } finally {
      db.close();
    }
  });
});
