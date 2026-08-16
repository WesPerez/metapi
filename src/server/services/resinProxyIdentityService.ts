import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import {
  getProxyUrlFromExtraConfig,
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
} from './accountExtraConfig.js';

const RESIN_PROXY_PROTOCOLS = new Set(['socks:', 'socks5:', 'socks5h:']);
const SHARED_METAPI_ACCOUNT_PATTERN = /^metapi-(?:system|site-[0-9]+)$/;
const ACCOUNT_SCOPED_METAPI_PATTERN = /^metapi-account-([0-9]+)(?:-slot-([0-2]))?$/;
const RESIN_RETRY_SLOT_COUNT = 3;

function normalizedEndpoint(url: URL): string {
  const port = url.port || (RESIN_PROXY_PROTOCOLS.has(url.protocol.toLowerCase()) ? '1080' : '80');
  return `${url.hostname.toLowerCase()}:${port}`;
}

function configuredEndpoints(): Set<string> {
  return new Set(
    config.resinStickyProxyEndpoints
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function buildAccountScopedResinProxyUrl(
  proxyUrl: string | null | undefined,
  accountId: number,
  endpoints: ReadonlySet<string> = configuredEndpoints(),
): string | null {
  if (!Number.isInteger(accountId) || accountId < 1 || !proxyUrl || endpoints.size === 0) {
    return null;
  }

  try {
    const parsed = new URL(proxyUrl);
    if (!RESIN_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) return null;
    if (!endpoints.has(normalizedEndpoint(parsed))) return null;

    const username = decodeURIComponent(parsed.username || '');
    const separatorIndex = username.indexOf('.');
    if (separatorIndex < 1) return null;
    const platform = username.slice(0, separatorIndex);
    const account = username.slice(separatorIndex + 1);
    if (!SHARED_METAPI_ACCOUNT_PATTERN.test(account)) return null;

    parsed.username = `${platform}.metapi-account-${accountId}`;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function buildNextAccountScopedResinProxyUrl(
  proxyUrl: string | null | undefined,
  accountId: number,
  endpoints: ReadonlySet<string> = configuredEndpoints(),
): string | null {
  if (!Number.isInteger(accountId) || accountId < 1 || !proxyUrl || endpoints.size === 0) {
    return null;
  }

  try {
    const parsed = new URL(proxyUrl);
    if (!RESIN_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) return null;
    if (!endpoints.has(normalizedEndpoint(parsed))) return null;

    const username = decodeURIComponent(parsed.username || '');
    const separatorIndex = username.indexOf('.');
    if (separatorIndex < 1) return null;
    const platform = username.slice(0, separatorIndex);
    const account = username.slice(separatorIndex + 1);
    const scopedMatch = ACCOUNT_SCOPED_METAPI_PATTERN.exec(account);
    if (scopedMatch && Number.parseInt(scopedMatch[1], 10) !== accountId) return null;
    if (!scopedMatch && !SHARED_METAPI_ACCOUNT_PATTERN.test(account)) return null;

    const currentSlot = scopedMatch?.[2] ? Number.parseInt(scopedMatch[2], 10) : 0;
    const nextSlot = (currentSlot + 1) % RESIN_RETRY_SLOT_COUNT;
    const nextAccount = nextSlot === 0
      ? `metapi-account-${accountId}`
      : `metapi-account-${accountId}-slot-${nextSlot}`;
    parsed.username = `${platform}.${nextAccount}`;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function resolveEffectiveProxyUrl(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): string | null {
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);
  if (accountProxyUrl) return accountProxyUrl;
  if (site.proxyUrl?.trim()) return site.proxyUrl.trim();
  if (site.useSystemProxy) return config.systemProxyUrl.trim() || null;
  return null;
}

export async function ensureAccountScopedResinProxyIdentity(accountId: number): Promise<boolean> {
  if (config.resinStickyProxyEndpoints.length === 0) return false;

  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) return false;
  const site = await db.select().from(schema.sites)
    .where(eq(schema.sites.id, account.siteId))
    .get();
  if (!site) return false;

  const scopedProxyUrl = buildAccountScopedResinProxyUrl(
    resolveEffectiveProxyUrl(account, site),
    account.id,
  );
  if (!scopedProxyUrl || getProxyUrlFromExtraConfig(account.extraConfig) === scopedProxyUrl) {
    return false;
  }

  await db.update(schema.accounts)
    .set({
      extraConfig: mergeAccountExtraConfig(account.extraConfig, { proxyUrl: scopedProxyUrl }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, account.id))
    .run();
  return true;
}

let inFlightBackfill: Promise<number> | null = null;

export async function ensureAccountScopedResinProxyIdentityBackfill(): Promise<number> {
  if (inFlightBackfill) return inFlightBackfill;
  inFlightBackfill = (async () => {
    if (config.resinStickyProxyEndpoints.length === 0) return 0;
    const accounts = await db.select({ id: schema.accounts.id }).from(schema.accounts).all();
    let updated = 0;
    for (const account of accounts) {
      if (await ensureAccountScopedResinProxyIdentity(account.id)) updated += 1;
    }
    return updated;
  })();
  try {
    return await inFlightBackfill;
  } finally {
    inFlightBackfill = null;
  }
}
