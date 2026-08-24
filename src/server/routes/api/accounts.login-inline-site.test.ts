import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const convergeAccountMutationMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts login inline site creation/reuse', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-login-inline-site-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    loginMock.mockReset();
    getApiTokenMock.mockReset();
    getApiTokensMock.mockReset();
    convergeAccountMutationMock.mockReset();

    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'session-token',
    });
    getApiTokenMock.mockResolvedValue(null);
    getApiTokensMock.mockResolvedValue([]);
    convergeAccountMutationMock.mockResolvedValue(undefined);

    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    delete process.env.DATA_DIR;
  });

  it('normalizes an inline site URL when siteId is omitted', async () => {
    getApiTokensMock.mockResolvedValueOnce([
      { name: 'disabled', key: 'sk-disabled', enabled: false },
      { name: 'active', key: 'sk-active', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteUrl: 'https://api.openai.com/v1/messages?trace=1#frag',
        username: 'demo-user',
        password: 'demo-password',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });

    const sites = await db.select().from(schema.sites).all();
    expect(sites).toHaveLength(1);
    expect(sites[0].url).toBe('https://api.openai.com');
    expect(sites[0].platform).toBe('new-api');
    expect(sites[0].name).toBe('api.openai.com');

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].siteId).toBe(sites[0].id);
    expect(accounts[0].apiToken).toBe('sk-active');

    // The adapter receives the normalized URL, not the raw inline input.
    expect(loginMock).toHaveBeenCalledWith(
      'https://api.openai.com',
      'demo-user',
      'demo-password',
    );
    expect(getApiTokensMock).toHaveBeenCalledTimes(1);
    expect(getApiTokenMock).not.toHaveBeenCalled();
  });

  it('reuses an existing hidden site when platform and normalized URL match', async () => {
    const existing = await db.insert(schema.sites).values({
      name: 'Existing OpenAI Site',
      url: 'https://api.openai.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteUrl: 'https://api.openai.com/v1',
        sitePlatform: 'new-api',
        username: 'demo-user',
        password: 'demo-password',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });

    // No duplicate site row is created; the hidden check-in site is reused.
    const sites = await db.select().from(schema.sites).all();
    expect(sites).toHaveLength(1);
    expect(sites[0].id).toBe(existing.id);
    expect(sites[0].url).toBe('https://api.openai.com');

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].siteId).toBe(existing.id);
  });

  it('rejects an invalid inline site URL without writing any site or account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteUrl: 'not a valid url///',
        username: 'demo-user',
        password: 'demo-password',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'site not found or invalid site URL',
    });
    expect(await db.select().from(schema.sites).all()).toHaveLength(0);
    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
    expect(loginMock).not.toHaveBeenCalled();
  });
});
