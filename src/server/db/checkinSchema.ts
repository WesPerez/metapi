/**
 * Standalone check-in SQLite schema.
 *
 * The check-in deployment only needs a small slice of the full MetAPI schema.
 * These DDL statements are derived from the canonical Drizzle schema
 * (`src/server/db/schema.ts`) and the migration output observed on the
 * deployed SQLite database, preserving the exact columns, indexes and foreign
 * keys that the retained runtime features query:
 *
 * - authentication / password settings
 * - sites and site API endpoints (needed to add a site while creating an account)
 * - accounts, account model availability caches and check-in history
 * - settings for authentication, scheduling and the system proxy
 *
 * Tables that belong to proxy logging, usage aggregation, admin snapshots,
 * OAuth route units, downstream keys, announcements and the Drizzle migration
 * journal are intentionally not part of the standalone schema.
 */

export const CHECKIN_SCHEMA_VERSION = 2;

/**
 * Business settings retained by the standalone app. Everything else belonged
 * to retired proxy/router features and is deleted only by an explicit prune
 * run. Schema metadata lives in PRAGMA user_version instead.
 */
export const CHECKIN_SETTINGS_KEYS = [
  'auth_token',
  'checkin_cron',
  'checkin_schedule_mode',
  'checkin_interval_hours',
  'system_proxy_url',
] as const;

export const CHECKIN_RETAINED_TABLES = [
  'sites',
  'site_api_endpoints',
  'site_disabled_models',
  'accounts',
  'checkin_logs',
  'model_availability',
  'settings',
] as const;

/**
 * Canonical tables that are not needed by the check-in app. A prune run may
 * physically drop exactly these tables (and nothing else) after confirming
 * every retained table exists and the database passes integrity / FK checks.
 */
export const CHECKIN_RETIRED_TABLES = [
  '__drizzle_migrations',
  // Drop the dependent model rows before their account-token parents.
  'token_model_availability',
  'account_tokens',
  'route_group_sources',
  'route_channels',
  'token_routes',
  'oauth_route_unit_members',
  'oauth_route_units',
  'proxy_debug_attempts',
  'proxy_debug_traces',
  'proxy_logs',
  'proxy_files',
  'proxy_video_tasks',
  'admin_snapshots',
  'analytics_projection_checkpoints',
  'site_day_usage',
  'site_hour_usage',
  'model_day_usage',
  'downstream_api_keys',
  'site_announcements',
  'events',
] as const;

export const CHECKIN_TABLE_DDL: Record<string, string> = {
  sites: `CREATE TABLE IF NOT EXISTS "sites" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "platform" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "api_key" text,
  "created_at" text DEFAULT (datetime('now')),
  "updated_at" text DEFAULT (datetime('now')),
  "is_pinned" integer DEFAULT false,
  "sort_order" integer DEFAULT 0,
  "proxy_url" text,
  "use_system_proxy" integer DEFAULT false,
  "custom_headers" text,
  "external_checkin_url" text,
  "global_weight" real DEFAULT 1,
  "post_refresh_probe_enabled" integer DEFAULT false,
  "post_refresh_probe_model" text DEFAULT '',
  "post_refresh_probe_scope" text DEFAULT 'single',
  "post_refresh_probe_latency_threshold_ms" integer DEFAULT 0
)`,
  site_api_endpoints: `CREATE TABLE IF NOT EXISTS "site_api_endpoints" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "url" text NOT NULL,
  "enabled" integer DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "cooldown_until" text,
  "last_selected_at" text,
  "last_failed_at" text,
  "last_failure_reason" text,
  "created_at" text DEFAULT (datetime('now')),
  "updated_at" text DEFAULT (datetime('now'))
)`,
  site_disabled_models: `CREATE TABLE IF NOT EXISTS "site_disabled_models" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "model_name" text NOT NULL,
  "created_at" text DEFAULT (datetime('now'))
)`,
  accounts: `CREATE TABLE IF NOT EXISTS "accounts" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "username" text,
  "access_token" text NOT NULL,
  "api_token" text,
  "balance" real DEFAULT 0,
  "balance_used" real DEFAULT 0,
  "quota" real DEFAULT 0,
  "unit_cost" real,
  "value_score" real DEFAULT 0,
  "status" text DEFAULT 'active',
  "checkin_enabled" integer DEFAULT true,
  "last_checkin_at" text,
  "last_balance_refresh" text,
  "extra_config" text,
  "created_at" text DEFAULT (datetime('now')),
  "updated_at" text DEFAULT (datetime('now')),
  "is_pinned" integer DEFAULT false,
  "sort_order" integer DEFAULT 0,
  "oauth_provider" text,
  "oauth_account_key" text,
  "oauth_project_id" text
)`,
  checkin_logs: `CREATE TABLE IF NOT EXISTS "checkin_logs" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "status" text NOT NULL,
  "message" text,
  "reward" text,
  "created_at" text DEFAULT (datetime('now'))
)`,
  model_availability: `CREATE TABLE IF NOT EXISTS "model_availability" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "model_name" text NOT NULL,
  "available" integer,
  "latency_ms" integer,
  "checked_at" text DEFAULT (datetime('now')),
  "is_manual" integer DEFAULT false
)`,
  settings: `CREATE TABLE IF NOT EXISTS "settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text
)`,
};

export const CHECKIN_INDEX_DDL: readonly string[] = [
  'CREATE UNIQUE INDEX IF NOT EXISTS "sites_platform_url_unique" ON "sites" ("platform","url")',
  'CREATE INDEX IF NOT EXISTS "sites_status_idx" ON "sites" ("status")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "site_api_endpoints_site_url_unique" ON "site_api_endpoints" ("site_id","url")',
  'CREATE INDEX IF NOT EXISTS "site_api_endpoints_site_enabled_sort_idx" ON "site_api_endpoints" ("site_id","enabled","sort_order")',
  'CREATE INDEX IF NOT EXISTS "site_api_endpoints_site_cooldown_idx" ON "site_api_endpoints" ("site_id","cooldown_until")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "site_disabled_models_site_model_unique" ON "site_disabled_models" ("site_id","model_name")',
  'CREATE INDEX IF NOT EXISTS "site_disabled_models_site_id_idx" ON "site_disabled_models" ("site_id")',
  'CREATE INDEX IF NOT EXISTS "accounts_site_id_idx" ON "accounts" ("site_id")',
  'CREATE INDEX IF NOT EXISTS "accounts_status_idx" ON "accounts" ("status")',
  'CREATE INDEX IF NOT EXISTS "accounts_site_status_idx" ON "accounts" ("site_id","status")',
  'CREATE INDEX IF NOT EXISTS "accounts_oauth_provider_idx" ON "accounts" ("oauth_provider")',
  'CREATE INDEX IF NOT EXISTS "accounts_oauth_identity_idx" ON "accounts" ("oauth_provider","oauth_account_key","oauth_project_id")',
  'CREATE INDEX IF NOT EXISTS "checkin_logs_account_created_at_idx" ON "checkin_logs" ("account_id","created_at")',
  'CREATE INDEX IF NOT EXISTS "checkin_logs_created_at_idx" ON "checkin_logs" ("created_at")',
  'CREATE INDEX IF NOT EXISTS "checkin_logs_status_idx" ON "checkin_logs" ("status")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "model_availability_account_model_unique" ON "model_availability" ("account_id","model_name")',
  'CREATE INDEX IF NOT EXISTS "model_availability_account_available_idx" ON "model_availability" ("account_id","available")',
  'CREATE INDEX IF NOT EXISTS "model_availability_model_name_idx" ON "model_availability" ("model_name")',
];
