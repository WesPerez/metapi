import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const REQUIRED_TABLES = [
  '__drizzle_migrations', 'sites', 'site_api_endpoints', 'site_disabled_models', 'accounts',
  'account_tokens', 'checkin_logs', 'model_availability', 'token_model_availability',
  'token_routes', 'route_group_sources', 'route_channels', 'oauth_route_units',
  'oauth_route_unit_members', 'proxy_logs', 'proxy_debug_traces', 'proxy_debug_attempts',
  'proxy_files', 'proxy_video_tasks', 'settings', 'admin_snapshots',
  'analytics_projection_checkpoints', 'site_day_usage', 'site_hour_usage', 'model_day_usage',
  'downstream_api_keys', 'site_announcements', 'events',
] as const;

function parseArgs(argv: string[]): { db: string; apply: boolean } {
  let db = '';
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--db') db = argv[++i] || '';
    else if (arg.startsWith('--db=')) db = arg.slice(6);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx scripts/checkin/init-checkin-database.ts --db PATH [--apply]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!db || db === ':memory:') throw new Error('--db PATH is required');
  return { db: resolve(db), apply };
}

function validate(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`Missing canonical compatibility tables: ${missing.join(', ')}`);
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${String(integrity)}`);
    const counts = {
      sites: (db.prepare('SELECT count(*) AS count FROM sites').get() as { count: number }).count,
      accounts: (db.prepare('SELECT count(*) AS count FROM accounts').get() as { count: number }).count,
      checkinLogs: (db.prepare('SELECT count(*) AS count FROM checkin_logs').get() as { count: number }).count,
      settings: (db.prepare('SELECT count(*) AS count FROM settings').get() as { count: number }).count,
    };
    console.log(JSON.stringify({ status: 'valid', db: dbPath, tables: tables.size, requiredTables: REQUIRED_TABLES.length, counts, integrity: 'ok' }, null, 2));
  } finally {
    db.close();
  }
}

function runCanonicalMigrations(dbPath: string): void {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(scriptPath), '../..');
  const tsxEntry = join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const migrationEntry = join(repoRoot, 'src/server/db/migrate.ts');
  if (!existsSync(tsxEntry) || !existsSync(migrationEntry)) {
    throw new Error('Canonical migration sources are unavailable; run this helper from a complete metapi checkout');
  }
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const result = spawnSync(process.execPath, [tsxEntry, migrationEntry], {
    cwd: repoRoot,
    env: { ...process.env, DB_TYPE: 'sqlite', DB_URL: `sqlite://${dbPath}`, DATA_DIR: dirname(dbPath) },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`Canonical migration exited with status ${String(result.status)}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.db) && !options.apply) {
    throw new Error(`SQLite database file not found: ${options.db}; pass --apply to initialize it`);
  }
  if (options.apply) runCanonicalMigrations(options.db);
  validate(options.db);
  if (!options.apply) {
    console.log('Dry-run only: pass --apply to run the repository canonical Drizzle migrations.');
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
