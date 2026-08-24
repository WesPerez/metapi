import {
  bootstrapRuntimeDatabaseSchema,
  type RuntimeSchemaDialect,
} from './db/runtimeSchemaBootstrap.js';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureCheckinDatabaseSchema } from './checkinDatabaseBootstrap.js';
import { config } from './config.js';

let sqliteMigrationsBootstrapped = false;

export async function runSqliteRuntimeMigrations(): Promise<void> {
  const migrateModule = await import('./db/migrate.js');
  if (!sqliteMigrationsBootstrapped) {
    sqliteMigrationsBootstrapped = true;
  }
  migrateModule.runSqliteMigrations();
}

type EnsureRuntimeDatabaseReadyInput = {
  dialect: RuntimeSchemaDialect;
  connectionString?: string;
  ssl?: boolean;
  dataDir?: string;
  runSqliteRuntimeMigrations?: () => Promise<void>;
  ensureExternalRuntimeSchema?: () => Promise<void>;
  ensureCheckinRuntimeSchema?: (db: Database.Database) => void;
};

function isCheckinAppMode(): boolean {
  return process.env.CHECKIN_APP_MODE === 'true';
}

function resolveSqlitePath(input: { connectionString?: string; dataDir?: string }): string {
  const raw = (input.connectionString ?? '').trim();
  if (!raw) {
    return resolve(input.dataDir || config.dataDir, 'hub.db');
  }
  if (raw === ':memory:') return raw;
  if (raw.startsWith('file://')) {
    return decodeURIComponent(new URL(raw).pathname);
  }
  if (raw.startsWith('sqlite://')) {
    return resolve(raw.slice('sqlite://'.length).trim());
  }
  return resolve(raw);
}

function ensureCheckinRuntimeDatabase(input: EnsureRuntimeDatabaseReadyInput): void {
  const dbPath = resolveSqlitePath(input);
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  try {
    const ensure = input.ensureCheckinRuntimeSchema || ensureCheckinDatabaseSchema;
    ensure(sqlite);
  } finally {
    sqlite.close();
  }
}

export async function ensureRuntimeDatabaseReady(input: EnsureRuntimeDatabaseReadyInput): Promise<void> {
  if (input.dialect === 'sqlite') {
    if (isCheckinAppMode()) {
      ensureCheckinRuntimeDatabase(input);
      return;
    }
    const runSqlite = input.runSqliteRuntimeMigrations || runSqliteRuntimeMigrations;
    await runSqlite();
    return;
  }

  const ensureExternal = input.ensureExternalRuntimeSchema || (async () => {
    const connectionString = (input.connectionString || '').trim();
    if (!connectionString) {
      throw new Error(`DB_URL is required when DB_TYPE=${input.dialect}`);
    }
    await bootstrapRuntimeDatabaseSchema({
      dialect: input.dialect,
      connectionString,
      ssl: !!input.ssl,
    });
  });

  await ensureExternal();
}

export const __runtimeDatabaseBootstrapTestUtils = {
  resetSqliteMigrationsBootstrapped() {
    sqliteMigrationsBootstrapped = false;
  },
};
