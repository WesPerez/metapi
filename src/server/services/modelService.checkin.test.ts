import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

let dataDir = '';
let dbModule: DbModule;
let modelService: ModelServiceModule;
let previousMode: string | undefined;
let previousDataDir: string | undefined;
let previousDbType: string | undefined;
let previousDbUrl: string | undefined;

beforeAll(async () => {
  previousMode = process.env.CHECKIN_APP_MODE;
  previousDataDir = process.env.DATA_DIR;
  previousDbType = process.env.DB_TYPE;
  previousDbUrl = process.env.DB_URL;
  dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-checkin-'));
  process.env.CHECKIN_APP_MODE = 'true';
  process.env.DATA_DIR = dataDir;
  process.env.DB_TYPE = 'sqlite';
  process.env.DB_URL = 'sqlite://' + resolve(dataDir, 'hub.db');

  dbModule = await import('../db/index.js');
  await dbModule.switchRuntimeDatabase('sqlite', process.env.DB_URL);
  modelService = await import('./modelService.js');
});

afterAll(() => {
  for (const [key, value] of [
    ['CHECKIN_APP_MODE', previousMode],
    ['DATA_DIR', previousDataDir],
    ['DB_TYPE', previousDbType],
    ['DB_URL', previousDbUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

it('refreshes models with the login session on the seven-table schema', async () => {
  getApiTokenMock.mockReset();
  getModelsMock.mockReset();
  getModelsMock.mockResolvedValue(['gpt-checkin']);

  const site = await dbModule.db.insert(dbModule.schema.sites).values({
    name: 'check-in site',
    url: 'https://checkin.example.com',
    platform: 'new-api',
    status: 'active',
  }).returning().get();
  const account = await dbModule.db.insert(dbModule.schema.accounts).values({
    siteId: site.id,
    username: 'checkin-user',
    accessToken: 'session-token',
    apiToken: null,
    status: 'active',
    extraConfig: JSON.stringify({ credentialMode: 'session' }),
  }).returning().get();

  const result = await modelService.refreshModelsForAccount(account.id);
  expect(result).toMatchObject({
    status: 'success',
    modelCount: 1,
    modelsPreview: ['gpt-checkin'],
    tokenScanned: 0,
    discoveredApiToken: false,
  });
  expect(getApiTokenMock).not.toHaveBeenCalled();
  expect(getModelsMock).toHaveBeenCalledTimes(1);
  expect(getModelsMock).toHaveBeenCalledWith(
    'https://checkin.example.com',
    'session-token',
    undefined,
  );

  const sqlite = new Database(join(dataDir, 'hub.db'), { readonly: true });
  try {
    const retiredTables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account_tokens', 'token_model_availability')",
    ).all();
    expect(retiredTables).toEqual([]);
  } finally {
    sqlite.close();
  }
});
