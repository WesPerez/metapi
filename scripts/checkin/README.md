# Check-in Database Tools

These helpers define the smaller SQLite contract used by the standalone
check-in deployment. They create the exact 7-table schema, validate it against
the embedded DDL, and can prune retired tables from an older full MetAPI
database after making a backup.

## Initialize a new database

From a complete `/root/metapi` checkout:

```bash
npx tsx scripts/checkin/init-checkin-database.ts --db ./data/hub.db --apply
```

`--apply` creates exactly the retained tables and indexes. Without `--apply`, an
existing database is read-only validated against the standalone shape.

## Validate and apply physical cleanup

```bash
npx tsx scripts/checkin/prune-checkin-database.ts --db ./data/hub.db
npx tsx scripts/checkin/prune-checkin-database.ts --db ./data/hub.db --apply --vacuum
```

The first command is a read-only validation and writes nothing. An apply run
creates a SQLite `.backup` snapshot before writing, verifies the exact retained schema,
drops only the listed retired tables, deletes settings keys outside the fixed
allowlist, checks protected table/content digests, and runs `integrity_check`
plus `foreign_key_check`. `--vacuum` is optional and should only be used when
no other process is writing the database.

Retained tables are `sites`, `site_api_endpoints`, `site_disabled_models`,
`accounts`, `checkin_logs`, `model_availability`, and `settings`. The prune operation physically drops
the migration journal, proxy routing/event tables, OAuth route-unit tables,
proxy/debug/file/video tables, usage aggregates, downstream keys, admin
snapshots, announcement caches, account API-key tokens, and token-specific model
availability. Version 2 pruning also clears the retired `accounts.api_token`
values while preserving the account login-session `access_token` values. It
refuses an unknown table or schema drift instead of guessing.

Schema version metadata is stored in SQLite `PRAGMA user_version`, not in the
`settings` business table. Writable initialization and prune runs set it to
the standalone schema version; readonly validation never changes it. A version
1 database must be upgraded with an explicit prune so token data cannot be
discarded silently during application startup.

The only retained settings keys are `auth_token`, `checkin_cron`,
`checkin_schedule_mode`, `checkin_interval_hours`, and
`system_proxy_url`. Initialization never inserts business values; prune apply
reports every non-allowlist key it deletes.
