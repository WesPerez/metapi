import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_TABLES = [
  '__drizzle_migrations',
  'sites',
  'site_api_endpoints',
  'site_disabled_models',
  'accounts',
  'account_tokens',
  'checkin_logs',
  'model_availability',
  'token_model_availability',
  'token_routes',
  'route_group_sources',
  'route_channels',
  'oauth_route_units',
  'oauth_route_unit_members',
  'proxy_logs',
  'proxy_debug_traces',
  'proxy_debug_attempts',
  'proxy_files',
  'proxy_video_tasks',
  'settings',
  'admin_snapshots',
  'analytics_projection_checkpoints',
  'site_day_usage',
  'site_hour_usage',
  'model_day_usage',
  'downstream_api_keys',
  'site_announcements',
  'events',
] as const;

const PURGE_TABLES = [
  'proxy_debug_attempts',
  'proxy_debug_traces',
  'proxy_logs',
  'proxy_files',
  'proxy_video_tasks',
  'site_day_usage',
  'site_hour_usage',
  'model_day_usage',
  'admin_snapshots',
  'site_announcements',
] as const;

const CORE_TABLES = [
  'sites',
  'accounts',
  'settings',
  'checkin_logs',
  'account_tokens',
  'site_api_endpoints',
  'site_disabled_models',
  'model_availability',
  'token_model_availability',
] as const;

type Options = {
  dbPath: string;
  apply: boolean;
  vacuum: boolean;
  eventRetentionDays: number;
  backupDir?: string;
};

function usage(): never {
  console.error(
    'Usage: tsx scripts/checkin/prune-checkin-database.ts --db PATH [--apply] [--vacuum] [--event-retention-days N] [--backup-dir PATH]',
  );
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  let dbPath = '';
  let apply = false;
  let vacuum = false;
  let eventRetentionDays = 30;
  let backupDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--vacuum') {
      vacuum = true;
    } else if (arg === '--db') {
      dbPath = argv[++index] || '';
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else if (arg === '--event-retention-days') {
      eventRetentionDays = Number(argv[++index]);
    } else if (arg.startsWith('--event-retention-days=')) {
      eventRetentionDays = Number(arg.slice('--event-retention-days='.length));
    } else if (arg === '--backup-dir') {
      backupDir = argv[++index] || '';
    } else if (arg.startsWith('--backup-dir=')) {
      backupDir = arg.slice('--backup-dir='.length);
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }

  if (!dbPath || dbPath === ':memory:') usage();
  if (!Number.isInteger(eventRetentionDays) || eventRetentionDays < 0 || eventRetentionDays > 3650) {
    throw new Error('--event-retention-days must be an integer from 0 through 3650');
  }

  const absoluteDbPath = resolve(dbPath);
  if (!existsSync(absoluteDbPath) || !statSync(absoluteDbPath).isFile()) {
    throw new Error(`SQLite database file not found: ${absoluteDbPath}`);
  }
  return {
    dbPath: absoluteDbPath,
    apply,
    vacuum,
    eventRetentionDays,
    backupDir: backupDir ? resolve(backupDir) : undefined,
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}

function rowCount(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number };
  return Number(row.count);
}

function tableDigest(db: Database.Database, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
  const serialized = rows
    .map((row) => JSON.stringify(row, (_key, value: unknown) => {
      if (Buffer.isBuffer(value)) return { type: 'Buffer', data: value.toString('base64') };
      return value;
    }))
    .sort()
    .join('\n');
  return createHash('sha256').update(serialized).digest('hex');
}

function integrityCheck(db: Database.Database): void {
  const result = db.pragma('integrity_check', { simple: true });
  if (result !== 'ok') throw new Error(`SQLite integrity_check failed: ${String(result)}`);
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length > 0) throw new Error(`SQLite foreign_key_check found ${foreignKeys.length} issue(s)`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

async function createBackup(db: Database.Database, options: Options): Promise<string> {
  const directory = options.backupDir || resolve(dirname(options.dbPath), 'backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fileName = `${basename(options.dbPath)}.pre-checkin-prune.${timestamp()}-${process.pid}.bak`;
  const destination = resolve(directory, fileName);
  await db.backup(destination);
  return destination;
}

function printCounts(db: Database.Database, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = rowCount(db, table);
  return counts;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = new Database(options.dbPath, { readonly: !options.apply, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const missing = REQUIRED_TABLES.filter((table) => !tableExists(db, table));
    if (missing.length > 0) throw new Error(`Required check-in tables are missing: ${missing.join(', ')}`);
    integrityCheck(db);

    const beforeCoreCounts = printCounts(db, CORE_TABLES);
    const beforeCoreDigests = Object.fromEntries(CORE_TABLES.map((table) => [table, tableDigest(db, table)]));
    const purgeCounts = printCounts(db, PURGE_TABLES);
    const eventCandidate = Number(
      (db.prepare(
        "SELECT count(*) AS count FROM events WHERE coalesce(read, 0) = 1 AND datetime(created_at) < datetime('now', ?)",
      ).get(`-${options.eventRetentionDays} days`) as { count: number }).count,
    );
    const beforeUnreadEvents = Number(
      (db.prepare('SELECT count(*) AS count FROM events WHERE coalesce(read, 0) = 0').get() as { count: number }).count,
    );

    console.log(JSON.stringify({
      mode: options.apply ? 'apply' : 'dry-run',
      db: realpathSync(options.dbPath),
      requiredTables: REQUIRED_TABLES.length,
      coreCounts: beforeCoreCounts,
      purgeCounts,
      readEventCandidates: eventCandidate,
      unreadEvents: beforeUnreadEvents,
      policy: 'preserve schema, credentials, sites, accounts, settings, check-in history, model caches and routing data; purge proxy/debug/file/video/usage/cache history; retain unread and recent events',
    }, null, 2));

    if (!options.apply) return;

    const backupPath = await createBackup(db, options);
    const transaction = db.transaction(() => {
      for (const table of PURGE_TABLES) db.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
      db.prepare(
        "DELETE FROM events WHERE coalesce(read, 0) = 1 AND datetime(created_at) < datetime('now', ?)",
      ).run(`-${options.eventRetentionDays} days`);
    });
    transaction();

    if (options.vacuum) {
      db.exec('VACUUM');
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
    integrityCheck(db);

    const afterCoreCounts = printCounts(db, CORE_TABLES);
    const afterCoreDigests = Object.fromEntries(CORE_TABLES.map((table) => [table, tableDigest(db, table)]));
    for (const table of CORE_TABLES) {
      if (afterCoreCounts[table] !== beforeCoreCounts[table] || afterCoreDigests[table] !== beforeCoreDigests[table]) {
        throw new Error(`Protected core table changed unexpectedly: ${table}`);
      }
    }
    const afterUnreadEvents = Number(
      (db.prepare('SELECT count(*) AS count FROM events WHERE coalesce(read, 0) = 0').get() as { count: number }).count,
    );
    if (afterUnreadEvents !== beforeUnreadEvents) throw new Error('Unread events changed unexpectedly');

    console.log(JSON.stringify({
      status: 'applied',
      backup: backupPath,
      afterCoreCounts,
      afterPurgeCounts: printCounts(db, PURGE_TABLES),
      unreadEvents: afterUnreadEvents,
      integrity: 'ok',
      vacuum: options.vacuum,
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
