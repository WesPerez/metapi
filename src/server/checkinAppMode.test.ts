import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKIN_RETAINED_TABLES } from './db/checkinSchema.js';
import {
  CHECKIN_RETIRED_ROUTE_NAMES,
  CHECKIN_RETAINED_ROUTE_NAMES,
  CHECKIN_NORMAL_ONLY_ROUTE_NAMES,
  CHECKIN_STARTUP_STEPS_ALWAYS,
  CHECKIN_STARTUP_STEPS_NORMAL_ONLY,
  getCheckinRoutePlan,
  getCheckinStartupPlan,
  isCheckinApiRequestAllowed,
} from './index.js';
import { ensureRuntimeDatabaseReady } from './runtimeDatabaseBootstrap.js';

describe('check-in app mode startup plan', () => {
  it('registers only the standalone check-in surfaces', () => {
    expect(getCheckinRoutePlan(true)).toEqual({
      checkinAppMode: true,
      registeredRoutes: [...CHECKIN_RETAINED_ROUTE_NAMES],
      skippedRoutes: [...CHECKIN_RETIRED_ROUTE_NAMES],
    });
  });

  it('keeps normal mode routes and auxiliary startup intact', () => {
    const plan = getCheckinRoutePlan(false);
    expect(plan.registeredRoutes).toEqual([
      ...CHECKIN_RETAINED_ROUTE_NAMES,
      ...CHECKIN_NORMAL_ONLY_ROUTE_NAMES,
      ...CHECKIN_RETIRED_ROUTE_NAMES,
    ]);
    expect(plan.skippedRoutes).toEqual([]);
  });

  it('skips startup maintenance that requires retired database surfaces', () => {
    expect(getCheckinStartupPlan(true)).toEqual({
      checkinAppMode: true,
      enabledSteps: [...CHECKIN_STARTUP_STEPS_ALWAYS],
      skippedSteps: [...CHECKIN_STARTUP_STEPS_NORMAL_ONLY],
    });
  });

  it('keeps all startup maintenance in normal mode', () => {
    const plan = getCheckinStartupPlan(false);
    expect(plan.enabledSteps).toEqual([...CHECKIN_STARTUP_STEPS_ALWAYS, ...CHECKIN_STARTUP_STEPS_NORMAL_ONLY]);
    expect(plan.skippedSteps).toEqual([]);
  });

  it('allows only the account, check-in, model and retained settings API surface', () => {
    expect(isCheckinApiRequestAllowed('GET', '/api/desktop/health')).toBe(true);
    expect(isCheckinApiRequestAllowed('GET', '/api/accounts?refresh=1')).toBe(true);
    expect(isCheckinApiRequestAllowed('POST', '/api/accounts/12/models/manual')).toBe(true);
    expect(isCheckinApiRequestAllowed('POST', '/api/models/check/12')).toBe(true);
    expect(isCheckinApiRequestAllowed('PUT', '/api/sites/4/disabled-models')).toBe(true);
    expect(isCheckinApiRequestAllowed('POST', '/api/checkin/trigger/12')).toBe(true);
    expect(isCheckinApiRequestAllowed('PUT', '/api/settings/runtime')).toBe(true);
    expect(isCheckinApiRequestAllowed('OPTIONS', '/api/accounts')).toBe(true);
  });

  it('rejects retired API surfaces and method mismatches', () => {
    expect(isCheckinApiRequestAllowed('GET', '/api/events')).toBe(false);
    expect(isCheckinApiRequestAllowed('GET', '/api/account-tokens')).toBe(false);
    expect(isCheckinApiRequestAllowed('POST', '/api/routes/rebuild')).toBe(false);
    expect(isCheckinApiRequestAllowed('GET', '/api/stats/site-trend')).toBe(false);
    expect(isCheckinApiRequestAllowed('POST', '/api/settings/runtime')).toBe(false);
    expect(isCheckinApiRequestAllowed('POST', '/api/accounts')).toBe(false);
    expect(isCheckinApiRequestAllowed('POST', '/api/accounts/verify-token')).toBe(false);
    expect(isCheckinApiRequestAllowed('POST', '/api/accounts/12/rebind-session')).toBe(false);
  });
});

describe('check-in app mode database bootstrap', () => {
  let previousMode: string | undefined;

  beforeEach(() => {
    previousMode = process.env.CHECKIN_APP_MODE;
  });

  afterEach(() => {
    process.env.CHECKIN_APP_MODE = previousMode;
  });

  it('bootstraps standalone schema and skips canonical SQLite migrations in check-in app mode', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'checkin-app-mode-bootstrap-'));
    process.env.CHECKIN_APP_MODE = 'true';
    try {
      await expect(ensureRuntimeDatabaseReady({
        dialect: 'sqlite',
        dataDir: tempDir,
        runSqliteRuntimeMigrations: async () => {
          throw new Error('canonical migrations must not run');
        },
      })).resolves.toBeUndefined();

      const sqlite = new Database(join(tempDir, 'hub.db'), { readonly: true });
      try {
        const tables = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toEqual([...CHECKIN_RETAINED_TABLES].sort());
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      process.env.CHECKIN_APP_MODE = previousMode;
    }
  });

  it('does not rebuild OAuth-dependent routes in check-in app mode', async () => {
    process.env.CHECKIN_APP_MODE = 'true';
    try {
      await expect(import('./services/modelService.js').then((module) => module.rebuildTokenRoutesFromAvailability()))
        .resolves.toEqual({ models: 0, createdRoutes: 0, createdChannels: 0, removedChannels: 0, removedRoutes: 0 });
    } finally {
      process.env.CHECKIN_APP_MODE = previousMode;
    }
  });
});
