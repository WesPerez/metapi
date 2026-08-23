import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { ensureCheckinDatabaseSchema } from '../../src/server/checkinDatabaseBootstrap.js';
import { CHECKIN_RETAINED_TABLES, CHECKIN_RETIRED_TABLES } from '../../src/server/db/checkinSchema.js';

type Options = {
  dbPath: string;
  apply: boolean;
  vacuum: boolean;
  backupDir?: string;
};

function usage(): never {
  console.error('Usage: tsx scripts/checkin/prune-checkin-database.ts --db PATH [--apply] [--vacuum] [--backup-dir PATH]');
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  let dbPath = '';
  let apply = false;
  let vacuum = false;
  let backupDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--vacuum') vacuum = true;
    else if (arg === '--db') dbPath = argv[++index] || '';
    else if (arg.startsWith('--db=')) dbPath = arg.slice('--db='.length);
    else if (arg === '--backup-dir') backupDir = argv[++index] || '';
    else if (arg.startsWith('--backup-dir=')) backupDir = arg.slice('--backup-dir='.length);
    else if (arg === '--help' || arg === '-h') usage();
    else throw new Error('Unknown argument: ' + arg);
  }
  if (!dbPath || dbPath === ':memory:') usage();
  const absoluteDbPath = resolve(dbPath);
  if (!existsSync(absoluteDbPath) || !statSync(absoluteDbPath).isFile()) {
    throw new Error('SQLite database file not found: ' + absoluteDbPath);
  }
  return {
    dbPath: absoluteDbPath,
    apply,
    vacuum,
    backupDir: backupDir ? resolve(backupDir) : undefined,
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

async function createBackup(db: Database.Database, options: Options): Promise<string> {
  const directory = options.backupDir || resolve(dirname(options.dbPath), 'backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = resolve(directory, basename(options.dbPath) + '.pre-checkin-prune.' + timestamp() + '-' + process.pid + '.bak');
  await db.backup(destination);
  chmodSync(destination, 0o600);
  return destination;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = new Database(options.dbPath, { fileMustExist: true });
  let backupPath: string | undefined;
  try {
    // Validate the complete database before any write. The prune path rejects unknown tables and schema drift.
    ensureCheckinDatabaseSchema(db, { readonly: true });
    if (options.apply) backupPath = await createBackup(db, options);

    const result = options.apply
      ? ensureCheckinDatabaseSchema(db, { prune: true })
      : { droppedTables: [] as string[] };
    if (options.apply && options.vacuum) {
      db.exec('VACUUM');
      db.pragma('wal_checkpoint(TRUNCATE)');
    }

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    const counts = Object.fromEntries(CHECKIN_RETAINED_TABLES.map((table) => [
      table,
      Number((db.prepare('SELECT count(*) AS count FROM ' + JSON.stringify(table)).get() as { count: number }).count),
    ]));
    console.log(JSON.stringify({
      status: options.apply ? 'pruned' : 'validated',
      db: realpathSync(options.dbPath),
      droppedTables: result.droppedTables,
      retiredTablesRemaining: CHECKIN_RETIRED_TABLES.filter((table) => tables.includes(table)),
      tables,
      counts,
      backup: backupPath,
      vacuum: options.apply && options.vacuum,
      integrity: 'ok',
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
