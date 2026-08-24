import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSqliteMigrations } from './db/migrate.js';
import { CHECKIN_RETAINED_TABLES } from './db/checkinSchema.js';
import {
  __runtimeDatabaseBootstrapTestUtils,
  ensureRuntimeDatabaseReady,
  runSqliteRuntimeMigrations,
} from './runtimeDatabaseBootstrap.js';

vi.mock('./db/migrate.js', () => ({
  runSqliteMigrations: vi.fn(),
}));

const tempRoot = mkdtempSync(join(tmpdir(), 'runtime-checkin-bootstrap-'));

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('runtimeDatabaseBootstrap', () => {
  beforeEach(() => {
    __runtimeDatabaseBootstrapTestUtils.resetSqliteMigrationsBootstrapped();
    vi.clearAllMocks();
  });

  it('runs sqlite migrations on the first runtime bootstrap call', async () => {
    await runSqliteRuntimeMigrations();

    expect(runSqliteMigrations).toHaveBeenCalledTimes(1);
  });

  it('runs sqlite runtime migrations when dialect is sqlite', async () => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});

    await ensureRuntimeDatabaseReady({
      dialect: 'sqlite',
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
    });

    expect(runSqliteRuntimeMigrations).toHaveBeenCalledTimes(1);
    expect(ensureExternalRuntimeSchema).not.toHaveBeenCalled();
  });

  it('bootstraps standalone check-in schema instead of canonical migrations', async () => {
    process.env.CHECKIN_APP_MODE = 'true';
    try {
      const dbPath = join(tempRoot, 'empty', 'hub.db');
      const runSqliteRuntimeMigrations = vi.fn(async () => {});

      await ensureRuntimeDatabaseReady({
        dialect: 'sqlite',
        connectionString: 'sqlite://' + dbPath,
        runSqliteRuntimeMigrations,
      });

      expect(runSqliteRuntimeMigrations).not.toHaveBeenCalled();
      const sqlite = new Database(dbPath, { readonly: true });
      try {
        const tables = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toEqual([...CHECKIN_RETAINED_TABLES].sort());
        expect(sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      } finally {
        sqlite.close();
      }
    } finally {
      delete process.env.CHECKIN_APP_MODE;
    }
  });

  it.each(['postgres', 'mysql'] as const)('bootstraps external schema when dialect is %s', async (dialect) => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});

    await ensureRuntimeDatabaseReady({
      dialect,
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
    });

    expect(ensureExternalRuntimeSchema).toHaveBeenCalledTimes(1);
    expect(runSqliteRuntimeMigrations).not.toHaveBeenCalled();
  });
});
