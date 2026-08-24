import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKIN_RETAINED_TABLES } from "../db/checkinSchema.js";

type AccountsOverviewModule = typeof import("./accountsOverviewService.js");
type DbModule = typeof import("../db/index.js");

describe("accounts overview in check-in app mode", () => {
  let dataDir = "";
  let previousCheckinAppMode: string | undefined;
  let previousDataDir: string | undefined;
  let previousDbUrl: string | undefined;
  let previousDbType: string | undefined;
  let dbModule: DbModule | undefined;

  beforeAll(async () => {
    previousCheckinAppMode = process.env.CHECKIN_APP_MODE;
    previousDataDir = process.env.DATA_DIR;
    previousDbUrl = process.env.DB_URL;
    previousDbType = process.env.DB_TYPE;
    dataDir = mkdtempSync(join(tmpdir(), "metapi-accounts-checkin-"));
    process.env.CHECKIN_APP_MODE = "true";
    process.env.DATA_DIR = dataDir;
    process.env.DB_TYPE = "sqlite";
    process.env.DB_URL = "sqlite://" + resolve(dataDir, "hub.db");

    dbModule = await import("../db/index.js");
    await dbModule.switchRuntimeDatabase("sqlite", process.env.DB_URL);

    const sqlite = new Database(join(dataDir, "hub.db"), { readonly: true });
    try {
      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name).sort()).toEqual(
        [...CHECKIN_RETAINED_TABLES].sort(),
      );
    } finally {
      sqlite.close();
    }
  });

  afterAll(() => {
    if (previousCheckinAppMode === undefined) {
      delete process.env.CHECKIN_APP_MODE;
    } else {
      process.env.CHECKIN_APP_MODE = previousCheckinAppMode;
    }
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    if (previousDbUrl === undefined) {
      delete process.env.DB_URL;
    } else {
      process.env.DB_URL = previousDbUrl;
    }
    if (previousDbType === undefined) {
      delete process.env.DB_TYPE;
    } else {
      process.env.DB_TYPE = previousDbType;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("loads a snapshot without querying retired proxy or admin snapshot tables", async () => {
    const dbModule = await import("../db/index.js");
    const { schema } = dbModule;
    const [site] = await dbModule.db
      .insert(schema.sites)
      .values({
        name: "checkin-site",
        url: "https://checkin.example.com",
        platform: "new-api",
      })
      .returning();
    await dbModule.db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "checkin-user",
        accessToken: "session-token",
      })
      .run();

    const overviewModule: AccountsOverviewModule = await import(
      "./accountsOverviewService.js"
    );
    const snapshot = await overviewModule.getAccountsSnapshot();

    expect(snapshot.payload.accounts).toHaveLength(1);
    expect(snapshot.payload.accounts[0]).toMatchObject({
      username: "checkin-user",
      todaySpend: 0,
    });
    const sqlite = new Database(join(dataDir, "hub.db"), { readonly: true });
    try {
      const retiredTables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('proxy_logs', 'admin_snapshots')",
        )
        .all();
      expect(retiredTables).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
