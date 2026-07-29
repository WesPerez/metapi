import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";

type SiteModelRow = {
  siteId: number;
  modelName: string;
};

type AccountSiteRow = {
  id: number;
  siteId: number;
};

type AccountModelRow = {
  accountId: number;
  modelName: string;
};

function normalizeModelName(value: unknown): string {
  return String(value || "").trim();
}

function sortModels(models: string[]): string[] {
  return models.sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

function addModel(
  target: Map<number, Set<string>>,
  siteId: number,
  modelName: string,
  disabledBySite: Map<number, Set<string>>,
) {
  const normalizedModel = normalizeModelName(modelName);
  if (!normalizedModel) return;
  if (disabledBySite.get(siteId)?.has(normalizedModel.toLowerCase())) return;
  const models = target.get(siteId) || new Set<string>();
  models.add(normalizedModel);
  target.set(siteId, models);
}

function addAccountModel(
  target: Map<number, Set<string>>,
  accountId: number,
  modelName: string,
  siteIdByAccount: Map<number, number>,
  disabledBySite: Map<number, Set<string>>,
) {
  const siteId = siteIdByAccount.get(accountId);
  if (!siteId) return;
  const normalizedModel = normalizeModelName(modelName);
  if (!normalizedModel) return;
  if (disabledBySite.get(siteId)?.has(normalizedModel.toLowerCase())) return;
  const models = target.get(accountId) || new Set<string>();
  models.add(normalizedModel);
  target.set(accountId, models);
}

async function loadDisabledModelsBySite(siteIds?: number[]) {
  const rows =
    siteIds && siteIds.length > 0
      ? await db
          .select({
            siteId: schema.siteDisabledModels.siteId,
            modelName: schema.siteDisabledModels.modelName,
          })
          .from(schema.siteDisabledModels)
          .where(inArray(schema.siteDisabledModels.siteId, siteIds))
          .all()
      : await db
          .select({
            siteId: schema.siteDisabledModels.siteId,
            modelName: schema.siteDisabledModels.modelName,
          })
          .from(schema.siteDisabledModels)
          .all();

  const disabledBySite = new Map<number, Set<string>>();
  for (const row of rows) {
    const modelName = normalizeModelName(row.modelName).toLowerCase();
    if (!modelName) continue;
    const set = disabledBySite.get(row.siteId) || new Set<string>();
    set.add(modelName);
    disabledBySite.set(row.siteId, set);
  }
  return disabledBySite;
}

export async function getEnabledModelsBySite(siteIds?: number[]) {
  const normalizedSiteIds = Array.isArray(siteIds)
    ? Array.from(
        new Set(
          siteIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .map((id) => Math.trunc(id)),
        ),
      )
    : undefined;
  if (normalizedSiteIds && normalizedSiteIds.length === 0) {
    return new Map<number, string[]>();
  }

  const disabledBySite = await loadDisabledModelsBySite(normalizedSiteIds);
  const siteModelMap = new Map<number, Set<string>>();
  const accountModelWhere =
    normalizedSiteIds && normalizedSiteIds.length > 0
      ? and(
          inArray(schema.accounts.siteId, normalizedSiteIds),
          eq(schema.modelAvailability.available, true),
        )
      : eq(schema.modelAvailability.available, true);
  const tokenModelWhere =
    normalizedSiteIds && normalizedSiteIds.length > 0
      ? and(
          inArray(schema.accounts.siteId, normalizedSiteIds),
          eq(schema.tokenModelAvailability.available, true),
        )
      : eq(schema.tokenModelAvailability.available, true);

  const accountModelsQuery = db
    .select({
      siteId: schema.accounts.siteId,
      modelName: schema.modelAvailability.modelName,
    })
    .from(schema.modelAvailability)
    .innerJoin(
      schema.accounts,
      eq(schema.modelAvailability.accountId, schema.accounts.id),
    )
    .where(accountModelWhere);
  const tokenModelsQuery = db
    .select({
      siteId: schema.accounts.siteId,
      modelName: schema.tokenModelAvailability.modelName,
    })
    .from(schema.tokenModelAvailability)
    .innerJoin(
      schema.accountTokens,
      eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
    )
    .innerJoin(
      schema.accounts,
      eq(schema.accountTokens.accountId, schema.accounts.id),
    )
    .where(tokenModelWhere);

  const [accountModels, tokenModels] = await Promise.all([
    accountModelsQuery.all() as Promise<SiteModelRow[]>,
    tokenModelsQuery.all() as Promise<SiteModelRow[]>,
  ]);

  for (const row of [...accountModels, ...tokenModels]) {
    addModel(siteModelMap, row.siteId, row.modelName, disabledBySite);
  }

  return new Map(
    Array.from(siteModelMap.entries()).map(([siteId, models]) => [
      siteId,
      sortModels(Array.from(models)),
    ]),
  );
}

export async function getEnabledModelsByAccount(accountIds?: number[]) {
  const normalizedAccountIds = Array.isArray(accountIds)
    ? Array.from(
        new Set(
          accountIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .map((id) => Math.trunc(id)),
        ),
      )
    : undefined;
  if (normalizedAccountIds && normalizedAccountIds.length === 0) {
    return new Map<number, string[]>();
  }

  const accountRows: AccountSiteRow[] =
    normalizedAccountIds && normalizedAccountIds.length > 0
      ? await db
          .select({
            id: schema.accounts.id,
            siteId: schema.accounts.siteId,
          })
          .from(schema.accounts)
          .where(inArray(schema.accounts.id, normalizedAccountIds))
          .all()
      : await db
          .select({
            id: schema.accounts.id,
            siteId: schema.accounts.siteId,
          })
          .from(schema.accounts)
          .all();
  if (accountRows.length === 0) {
    return new Map<number, string[]>();
  }
  const siteIdByAccount = new Map<number, number>(
    accountRows.map((row) => [row.id, row.siteId] as const),
  );
  const disabledBySite = await loadDisabledModelsBySite(
    Array.from(new Set(accountRows.map((row) => row.siteId))),
  );
  const accountModelMap = new Map<number, Set<string>>();

  const accountModelWhere =
    normalizedAccountIds && normalizedAccountIds.length > 0
      ? and(
          inArray(schema.modelAvailability.accountId, normalizedAccountIds),
          eq(schema.modelAvailability.available, true),
        )
      : eq(schema.modelAvailability.available, true);
  const tokenModelWhere =
    normalizedAccountIds && normalizedAccountIds.length > 0
      ? and(
          inArray(schema.accountTokens.accountId, normalizedAccountIds),
          eq(schema.tokenModelAvailability.available, true),
        )
      : eq(schema.tokenModelAvailability.available, true);

  const [accountModels, tokenModels]: [AccountModelRow[], AccountModelRow[]] =
    await Promise.all([
      db
        .select({
          accountId: schema.modelAvailability.accountId,
          modelName: schema.modelAvailability.modelName,
        })
        .from(schema.modelAvailability)
        .where(accountModelWhere)
        .all(),
      db
        .select({
          accountId: schema.accountTokens.accountId,
          modelName: schema.tokenModelAvailability.modelName,
        })
        .from(schema.tokenModelAvailability)
        .innerJoin(
          schema.accountTokens,
          eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
        )
        .where(tokenModelWhere)
        .all(),
    ]);

  for (const row of accountModels) {
    addAccountModel(
      accountModelMap,
      row.accountId,
      row.modelName,
      siteIdByAccount,
      disabledBySite,
    );
  }
  for (const row of tokenModels) {
    addAccountModel(
      accountModelMap,
      row.accountId,
      row.modelName,
      siteIdByAccount,
      disabledBySite,
    );
  }

  return new Map(
    Array.from(accountModelMap.entries()).map(([accountId, models]) => [
      accountId,
      sortModels(Array.from(models)),
    ]),
  );
}
