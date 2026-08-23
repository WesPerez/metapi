import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureCheckinDatabaseSchema } from '../../src/server/checkinDatabaseBootstrap.js';
import { CHECKIN_RETAINED_TABLES } from '../../src/server/db/checkinSchema.js';

function usage(): never {
  console.log('Usage: tsx scripts/checkin/init-checkin-database.ts --db PATH [--apply]');
  process.exit(2);
}

function parseArgs(argv: string[]): { db: string; apply: boolean } {
  let db = '';
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--db') db = argv[++index] || '';
    else if (arg.startsWith('--db=')) db = arg.slice('--db='.length);
    else if (arg === '--help' || arg === '-h') usage();
    else throw new Error('Unknown argument: ' + arg);
  }
  if (!db || db === ':memory:') usage();
  return { db: resolve(db), apply };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = options.db;
  if (!options.apply && !existsSync(dbPath)) {
    throw new Error('SQLite database file not found: ' + dbPath + '; pass --apply to initialize it');
  }
  if (!options.apply && !existsSync(dirname(dbPath))) {
    throw new Error('Database directory not found: ' + dirname(dbPath));
  }
  if (!options.apply) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      ensureCheckinDatabaseSchema(db, { readonly: true });
      const counts = Object.fromEntries(CHECKIN_RETAINED_TABLES.map((table) => [
        table,
        Number((db.prepare('SELECT count(*) AS count FROM ' + JSON.stringify(table)).get() as { count: number }).count),
      ]));
      console.log(JSON.stringify({ status: 'validated', db: dbPath, tables, counts, integrity: 'ok' }, null, 2));
      return;
    } finally {
      db.close();
    }
  }
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try {
    const result = ensureCheckinDatabaseSchema(db);
    const counts = Object.fromEntries(CHECKIN_RETAINED_TABLES.map((table) => [
      table,
      Number((db.prepare('SELECT count(*) AS count FROM ' + JSON.stringify(table)).get() as { count: number }).count),
    ]));
    console.log(JSON.stringify({
      status: 'initialized',
      db: dbPath,
      createdTables: result.createdTables,
      createdIndexes: result.createdIndexes,
      tables: result.retainedTables,
      extraTables: result.extraTables,
      counts,
      schemaVersion: result.schemaVersion,
      integrity: result.integrity,
    }, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
