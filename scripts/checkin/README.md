# Check-in Database Tools

These helpers keep the existing SQLite schema contract intact while making a
standalone check-in deployment easier to reproduce.

The current server still imports the full Drizzle schema and runs all canonical
migrations at startup. Do not `DROP TABLE` from a production database: missing
compatibility tables can be recreated by startup code, and account/model pages
still reference some of them. The supported cleanup is data retention, not
physical schema surgery.

## Initialize a new database

From a complete `/root/metapi` checkout:

```bash
npx tsx scripts/checkin/init-checkin-database.ts --db ./data/hub.db --apply
```

`--apply` invokes the repository's canonical `src/server/db/migrate.ts`, then
checks the full compatibility table set and `PRAGMA integrity_check`. Without
`--apply`, an existing database is read-only validated.

## Preview and apply retention cleanup

```bash
npx tsx scripts/checkin/prune-checkin-database.ts --db ./data/hub.db
npx tsx scripts/checkin/prune-checkin-database.ts --db ./data/hub.db --apply --vacuum
```

The first command is a dry-run. An apply run creates a timestamped SQLite
`.backup` snapshot before writing, runs one transaction, checks protected core
table row/content digests, preserves unread events, and runs integrity checks.
`--vacuum` is optional and should only be used when no other process is writing
the database.

Retained data includes sites, accounts and credentials, global settings (the
admin password and system proxy), check-in history, account tokens, site
endpoints/disabled-model rules, model availability caches, routing data, the
migration journal, and unread/recent events. The cleanup removes proxy request
logs, debug traces/attempts, temporary proxy files/video tasks, usage aggregates,
admin snapshots, and site announcement cache. Tables remain present as empty
compatibility shells where appropriate.
