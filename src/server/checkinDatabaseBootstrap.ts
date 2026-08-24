/**
 * Safe bootstrap for the standalone check-in SQLite schema.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  CHECKIN_INDEX_DDL,
  CHECKIN_RETIRED_TABLES,
  CHECKIN_RETAINED_TABLES,
  CHECKIN_SCHEMA_VERSION,
  CHECKIN_SETTINGS_KEYS,
  CHECKIN_TABLE_DDL,
} from './db/checkinSchema.js';

export type CheckinBootstrapResult = {
  createdTables: string[];
  createdIndexes: number;
  droppedTables: string[];
  deletedSettingsKeys: string[];
  clearedApiTokens: number;
  retainedTables: string[];
  extraTables: string[];
  schemaVersion: number;
  integrity: 'ok';
};

type TableSnapshot = {
  count: number;
  digest: string;
};

type TableShape = {
  columns: unknown[];
  foreignKeys: unknown[];
  indexes: unknown[];
};

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Unsafe SQLite identifier: ' + identifier);
  }
  return '"' + identifier + '"';
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table));
}

function userTables(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function tableShape(db: Database.Database, table: string): TableShape {
  const columns = db.prepare('PRAGMA table_info(' + quoteIdentifier(table) + ')').all();
  const foreignKeys = (db.prepare('PRAGMA foreign_key_list(' + quoteIdentifier(table) + ')').all() as Array<Record<string, unknown>>)
    .map((row) => ({
      id: row.id,
      seq: row.seq,
      table: row.table,
      from: row.from,
      to: row.to,
      on_update: row.on_update,
      on_delete: row.on_delete,
      match: row.match,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const indexes = (db.prepare('PRAGMA index_list(' + quoteIdentifier(table) + ')').all() as Array<{ name: string; unique: number; origin: string; partial: number }>)
    .filter((row) => !row.name.startsWith('sqlite_autoindex_'))
    .map((row) => ({
      name: row.name,
      unique: row.unique,
      origin: row.origin,
      partial: row.partial,
      columns: (db.prepare('PRAGMA index_info(' + quoteIdentifier(row.name) + ')').all() as Array<{ seqno: number; cid: number; name: string }>)
        .sort((left, right) => left.seqno - right.seqno)
        .map((indexColumn) => indexColumn.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { columns, foreignKeys, indexes };
}

function buildReferenceShape(): Record<string, TableShape> {
  const reference = new Database(':memory:');
  try {
    for (const statement of Object.values(CHECKIN_TABLE_DDL)) reference.exec(statement);
    for (const statement of CHECKIN_INDEX_DDL) reference.exec(statement);
    const shape: Record<string, TableShape> = {};
    for (const table of CHECKIN_RETAINED_TABLES) shape[table] = tableShape(reference, table);
    return shape;
  } finally {
    reference.close();
  }
}

function validateSchemaShape(db: Database.Database, tables: readonly string[]): void {
  const expected = buildReferenceShape();
  for (const table of tables) {
    const actual = JSON.stringify(tableShape(db, table));
    const reference = JSON.stringify(expected[table]);
    if (actual !== reference) {
      throw new Error('Check-in schema drift in table ' + table + ': expected ' + reference + ', got ' + actual);
    }
  }
}

function checkinIndexName(statement: string): string {
  const name = statement.match(/IF NOT EXISTS \"([^\"]+)\"/)?.[1];
  if (!name) throw new Error('Cannot determine check-in index name');
  return name;
}

function tableDigest(db: Database.Database, table: string): string {
  const rows = db.prepare('SELECT * FROM ' + quoteIdentifier(table)).all() as Array<Record<string, unknown>>;
  const serialized = rows
    .map((row) => JSON.stringify(
      table === 'accounts' ? { ...row, api_token: null } : row,
      (_key, value: unknown) => {
        if (Buffer.isBuffer(value)) return { type: 'Buffer', data: value.toString('base64') };
        return value;
      },
    ))
    .sort()
    .join('\n');
  return createHash('sha256').update(serialized).digest('hex');
}

function tableSnapshots(db: Database.Database, tables: readonly string[]): Record<string, TableSnapshot> {
  return Object.fromEntries(tables.map((table) => {
    const count = Number((db.prepare('SELECT count(*) AS count FROM ' + quoteIdentifier(table)).get() as { count: number }).count);
    return [table, { count, digest: tableDigest(db, table) }];
  }));
}

function protectedSettingsSnapshot(db: Database.Database): TableSnapshot {
  const placeholders = CHECKIN_SETTINGS_KEYS.map(() => '?').join(', ');
  const rows = db.prepare(
    'SELECT "key", "value" FROM settings WHERE "key" IN (' + placeholders + ') ORDER BY "key"',
  ).all(...CHECKIN_SETTINGS_KEYS) as Array<Record<string, unknown>>;
  const serialized = rows
    .map((row) => JSON.stringify(row, (_key, value: unknown) => {
      if (Buffer.isBuffer(value)) return { type: 'Buffer', data: value.toString('base64') };
      return value;
    }))
    .join('\n');
  return { count: rows.length, digest: createHash('sha256').update(serialized).digest('hex') };
}

function protectedSnapshots(db: Database.Database, tables: readonly string[]): Record<string, TableSnapshot> {
  const snapshots = tableSnapshots(db, tables.filter((table) => table !== 'settings'));
  if (tables.includes('settings')) snapshots.settings = protectedSettingsSnapshot(db);
  return snapshots;
}

function assertUnchangedSnapshots(
  before: Record<string, TableSnapshot>,
  after: Record<string, TableSnapshot>,
  label: string,
): void {
  for (const table of Object.keys(before)) {
    if (before[table].count !== after[table].count || before[table].digest !== after[table].digest) {
      throw new Error(label + ' changed protected table: ' + table);
    }
  }
}

function integrityCheck(db: Database.Database): void {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error('SQLite integrity_check failed: ' + String(integrity));
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length > 0) throw new Error('SQLite foreign_key_check found ' + foreignKeys.length + ' issue(s)');
}

function readSchemaVersion(db: Database.Database): number {
  return Number(db.pragma('user_version', { simple: true }));
}

function validateSchemaVersion(db: Database.Database, allowLegacyV1 = false): void {
  const version = readSchemaVersion(db);
  // Zero is the SQLite default for a new database and for an older full
  // MetAPI database being adopted by the standalone tools. Any other version
  // requires explicit schema evolution rather than a silent overwrite.
  const allowedVersions = allowLegacyV1
    ? [0, 1, CHECKIN_SCHEMA_VERSION]
    : [0, CHECKIN_SCHEMA_VERSION];
  if (!allowedVersions.includes(version)) {
    throw new Error(
      'Unsupported check-in schema version: expected '
      + allowedVersions.join(', ')
      + ', got '
      + version,
    );
  }
}

function writeSchemaVersion(db: Database.Database, allowLegacyV1 = false): void {
  validateSchemaVersion(db, allowLegacyV1);
  if (readSchemaVersion(db) !== CHECKIN_SCHEMA_VERSION) {
    db.pragma('user_version = ' + CHECKIN_SCHEMA_VERSION);
  }
}

export function ensureCheckinDatabaseSchema(
  db: Database.Database,
  options: { prune?: boolean; readonly?: boolean } = {},
): CheckinBootstrapResult {
  const createdTables: string[] = [];
  let createdIndexes = 0;
  const droppedTables: string[] = [];
  const deletedSettingsKeys: string[] = [];
  let clearedApiTokens = 0;

  db.pragma('foreign_keys = ON');
  integrityCheck(db);

  const missingTables = CHECKIN_RETAINED_TABLES.filter((table) => !tableExists(db, table));
  const presentTables = CHECKIN_RETAINED_TABLES.filter((table) => tableExists(db, table));
  validateSchemaShape(db, presentTables);
  const allowLegacyV1 = options.prune === true || options.readonly === true;
  validateSchemaVersion(db, allowLegacyV1);

  const presentRetainedBefore = CHECKIN_RETAINED_TABLES.filter((table) => tableExists(db, table));
  const beforeSnapshots = protectedSnapshots(db, presentRetainedBefore);

  if (options.prune) {
    const missingRetained = CHECKIN_RETAINED_TABLES.filter((table) => !tableExists(db, table));
    if (missingRetained.length > 0) {
      throw new Error('Cannot prune: required check-in tables are missing: ' + missingRetained.join(', '));
    }

    const tables = new Set(userTables(db));
    const unexpectedTables = [...tables].filter((table) => !CHECKIN_RETAINED_TABLES.includes(table as never) && !CHECKIN_RETIRED_TABLES.includes(table as never));
    if (unexpectedTables.length > 0) {
      throw new Error('Cannot prune: unrecognized tables require manual review: ' + unexpectedTables.join(', '));
    }

    const retainedForeignKeys = CHECKIN_RETAINED_TABLES.flatMap((table) => (
      db.prepare('PRAGMA foreign_key_list(' + quoteIdentifier(table) + ')').all() as Array<{ table: string }>
    ));
    if (retainedForeignKeys.some((foreignKey) => CHECKIN_RETIRED_TABLES.includes(foreignKey.table as never))) {
      throw new Error('Cannot prune: a retained table has a foreign key into a retired table');
    }

    const droppable = CHECKIN_RETIRED_TABLES.filter((table) => tables.has(table));
    const deletedKeyPlaceholders = CHECKIN_SETTINGS_KEYS.map(() => '?').join(', ');
    const removableSettingsKeys = (
      db.prepare('SELECT "key" FROM settings WHERE "key" NOT IN (' + deletedKeyPlaceholders + ') ORDER BY "key"').all(...CHECKIN_SETTINGS_KEYS) as Array<{ key: string }>
    ).map((row) => row.key);
    const transaction = db.transaction(() => {
      for (const table of droppable) {
        db.prepare('DROP TABLE IF EXISTS ' + quoteIdentifier(table)).run();
        droppedTables.push(table);
      }
      for (const key of removableSettingsKeys) {
        db.prepare('DELETE FROM settings WHERE "key" = ?').run(key);
        deletedSettingsKeys.push(key);
      }
      clearedApiTokens = db.prepare(
        'UPDATE accounts SET api_token = NULL WHERE api_token IS NOT NULL',
      ).run().changes;
    });
    transaction();
    integrityCheck(db);
  }

  for (const table of missingTables) {
    db.exec(CHECKIN_TABLE_DDL[table]);
    createdTables.push(table);
  }

  const existingIndexes = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const statement of CHECKIN_INDEX_DDL) {
    const name = checkinIndexName(statement);
    if (!existingIndexes.has(name)) {
      db.exec(statement);
      createdIndexes += 1;
    }
  }

  validateSchemaShape(db, CHECKIN_RETAINED_TABLES);

  if (options.readonly) {
    validateSchemaVersion(db, true);
  } else {
    writeSchemaVersion(db, options.prune === true);
  }

  integrityCheck(db);
  validateSchemaShape(db, CHECKIN_RETAINED_TABLES);
  assertUnchangedSnapshots(
    beforeSnapshots,
    protectedSnapshots(db, CHECKIN_RETAINED_TABLES),
    options.prune ? 'Prune' : 'Bootstrap',
  );
  const tables = userTables(db);
  const retainedSet = new Set<string>(CHECKIN_RETAINED_TABLES);
  const extraTables = tables.filter((table) => !retainedSet.has(table));
  if (options.prune && extraTables.length > 0) {
    throw new Error('Prune left unexpected tables: ' + extraTables.join(', '));
  }

  return {
    createdTables,
    createdIndexes,
    droppedTables,
    deletedSettingsKeys,
    clearedApiTokens,
    retainedTables: CHECKIN_RETAINED_TABLES.filter((table) => tables.includes(table)),
    extraTables,
    schemaVersion: CHECKIN_SCHEMA_VERSION,
    integrity: 'ok',
  };
}
