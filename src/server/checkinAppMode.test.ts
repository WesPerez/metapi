import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKIN_RETIRED_ROUTE_NAMES,
  CHECKIN_RETAINED_ROUTE_NAMES,
  CHECKIN_STARTUP_STEPS_ALWAYS,
  CHECKIN_STARTUP_STEPS_NORMAL_ONLY,
  getCheckinRoutePlan,
  getCheckinStartupPlan,
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
    expect(plan.registeredRoutes).toEqual([...CHECKIN_RETAINED_ROUTE_NAMES, ...CHECKIN_RETIRED_ROUTE_NAMES]);
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
});

describe('check-in app mode database bootstrap', () => {
  let previousMode: string | undefined;

  beforeEach(() => {
    previousMode = process.env.CHECKIN_APP_MODE;
  });

  afterEach(() => {
    process.env.CHECKIN_APP_MODE = previousMode;
  });

  it('skips canonical SQLite migrations in check-in app mode', async () => {
    process.env.CHECKIN_APP_MODE = 'true';
    await expect(ensureRuntimeDatabaseReady({
      dialect: 'sqlite',
      runSqliteRuntimeMigrations: async () => {
        throw new Error('canonical migrations must not run');
      },
    })).resolves.toBeUndefined();
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
