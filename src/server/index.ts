import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  buildFastifyOptions,
  config,
} from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { sitesRoutes } from './routes/api/sites.js';
import { accountsRoutes } from './routes/api/accounts.js';
import { checkinRoutes } from './routes/api/checkin.js';
import { tokensRoutes } from './routes/api/tokens.js';
import { statsRoutes } from './routes/api/stats.js';
import { authRoutes } from './routes/api/auth.js';
import { settingsRoutes } from './routes/api/settings.js';
import { accountTokensRoutes } from './routes/api/accountTokens.js';
import { startScheduler } from './services/checkinScheduler.js';
import * as routeRefreshWorkflow from './services/routeRefreshWorkflow.js';
import { buildStartupSummaryLines } from './services/startupInfo.js';
import { repairStoredCreatedAtValues } from './services/storedTimestampRepairService.js';
import { migrateSiteApiKeysToAccounts } from './services/siteApiKeyMigrationService.js';
import { ensureDefaultSitesSeeded } from './services/defaultSiteSeedService.js';
import { ensureAccountScopedResinProxyIdentityBackfill } from './services/resinProxyIdentityService.js';
import { ensureRuntimeDatabaseReady } from './runtimeDatabaseBootstrap.js';
import { isPublicApiRoute, registerDesktopRoutes } from './desktop.js';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, normalize, resolve, sep } from 'path';
import {
  applyRuntimeSettings,
  parseSettingFromMap,
} from './runtimeSettingsHydration.js';
import { normalizeLogCleanupRetentionDays } from './shared/logCleanupRetentionDays.js';
import {
  db,
  ensureProxyFileCompatibilityColumns,
  ensureProxyLogClientColumns,
  ensureProxyLogDownstreamApiKeyIdColumn,
  ensureProxyLogBillingDetailsColumn,
  ensureProxyLogStreamTimingColumns,
  ensureRouteGroupingCompatibilityColumns,
  ensureSiteCompatibilityColumns,
  runtimeDbDialect,
  schema,
  switchRuntimeDatabase,
  type RuntimeDbDialect,
} from './db/index.js';

export const CHECKIN_RETAINED_ROUTE_NAMES = [
  'desktop',
  'sites',
  'accounts',
  'checkin',
  'tokens',
  'stats',
  'auth',
  'settings',
  'accountTokens',
] as const;

export const CHECKIN_RETIRED_ROUTE_NAMES = [
  'search',
  'events',
  'siteAnnouncements',
  'updateCenter',
  'tasks',
  'test',
  'monitor',
  'downstreamApiKeys',
  'oauth',
  'proxy',
] as const;

export const CHECKIN_STARTUP_STEPS_ALWAYS = [
  'ensureRuntimeDatabaseReady',
  'loadRuntimeSettings',
  'ensureSiteCompatibilityColumns',
  'ensureRouteGroupingCompatibilityColumns',
  'migrateSiteApiKeysToAccounts',
  'ensureDefaultSitesSeeded',
  'ensureAccountScopedResinProxyIdentityBackfill',
  'rebuildRoutesOnly',
  'startCheckinScheduler',
] as const;

export const CHECKIN_STARTUP_STEPS_NORMAL_ONLY = [
  'ensureProxyFileCompatibilityColumns',
  'ensureProxyLogStreamTimingColumns',
  'ensureProxyLogClientColumns',
  'ensureProxyLogDownstreamApiKeyIdColumn',
  'ensureProxyLogBillingDetailsColumn',
  'repairStoredCreatedAtValues',
  'ensureOauthIdentityBackfill',
  'ensureOauthProviderSitesExist',
  'registerRetiredRoutes',
  'startAuxiliaryBackgroundServices',
] as const;

export type CheckinRoutePlan = {
  checkinAppMode: boolean;
  registeredRoutes: string[];
  skippedRoutes: string[];
};

export function getCheckinRoutePlan(checkinAppMode: boolean): CheckinRoutePlan {
  const retiredRoutes = [...CHECKIN_RETIRED_ROUTE_NAMES];
  return {
    checkinAppMode,
    registeredRoutes: checkinAppMode
      ? [...CHECKIN_RETAINED_ROUTE_NAMES]
      : [...CHECKIN_RETAINED_ROUTE_NAMES, ...retiredRoutes],
    skippedRoutes: checkinAppMode ? retiredRoutes : [],
  };
}

export type CheckinStartupPlan = {
  checkinAppMode: boolean;
  enabledSteps: string[];
  skippedSteps: string[];
};

export function getCheckinStartupPlan(checkinAppMode: boolean): CheckinStartupPlan {
  const alwaysSteps = [...CHECKIN_STARTUP_STEPS_ALWAYS];
  const normalOnlySteps = [...CHECKIN_STARTUP_STEPS_NORMAL_ONLY];
  return {
    checkinAppMode,
    enabledSteps: checkinAppMode ? alwaysSteps : [...alwaysSteps, ...normalOnlySteps],
    skippedSteps: checkinAppMode ? normalOnlySteps : [],
  };
}

function toSettingsMap(rows: Array<{ key: string; value: string }>) {
  return new Map(rows.map((row) => [row.key, row.value]));
}

function normalizeSavedDbType(value: unknown): RuntimeDbDialect | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sqlite') return 'sqlite';
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  return null;
}

function validateSavedDbUrl(dialect: RuntimeDbDialect, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (dialect === 'sqlite') return normalized;
  if (dialect === 'mysql' && normalized.startsWith('mysql://')) return normalized;
  if (dialect === 'postgres' && (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://'))) return normalized;
  return null;
}

function extractSavedRuntimeDatabaseConfig(settingsMap: Map<string, string>): { dialect: RuntimeDbDialect; dbUrl: string; ssl: boolean } | null {
  const rawType = parseSettingFromMap<unknown>(settingsMap, 'db_type');
  const rawUrl = parseSettingFromMap<unknown>(settingsMap, 'db_url');
  const rawSsl = parseSettingFromMap<boolean>(settingsMap, 'db_ssl');
  const dialect = normalizeSavedDbType(rawType);
  if (!dialect) return null;
  const dbUrl = validateSavedDbUrl(dialect, rawUrl);
  if (!dbUrl) return null;
  return {
    dialect,
    dbUrl,
    ssl: typeof rawSsl === 'boolean' ? rawSsl : false,
  };
}

const LOG_CLEANUP_SETTING_KEYS = [
  'log_cleanup_cron',
  'log_cleanup_usage_logs_enabled',
  'log_cleanup_program_logs_enabled',
  'log_cleanup_retention_days',
] as const;

function hasExplicitLogCleanupSettings(settingsMap: Map<string, string>): boolean {
  return LOG_CLEANUP_SETTING_KEYS.some((key) => settingsMap.has(key));
}

async function registerRetiredRoutes(app: FastifyInstance): Promise<void> {
  const [
    { searchRoutes },
    { eventsRoutes },
    { taskRoutes },
    { testRoutes },
    { monitorRoutes },
    { downstreamApiKeysRoutes },
    { oauthRoutes },
    { siteAnnouncementsRoutes },
    { updateCenterRoutes },
    { proxyRoutes },
  ] = await Promise.all([
    import('./routes/api/search.js'),
    import('./routes/api/events.js'),
    import('./routes/api/tasks.js'),
    import('./routes/api/test.js'),
    import('./routes/api/monitor.js'),
    import('./routes/api/downstreamApiKeys.js'),
    import('./routes/api/oauth.js'),
    import('./routes/api/siteAnnouncements.js'),
    import('./routes/api/updateCenter.js'),
    import('./routes/proxy/router.js'),
  ]);
  await app.register(searchRoutes);
  await app.register(eventsRoutes);
  await app.register(siteAnnouncementsRoutes);
  await app.register(updateCenterRoutes);
  await app.register(taskRoutes);
  await app.register(testRoutes);
  await app.register(monitorRoutes);
  await app.register(downstreamApiKeysRoutes);
  await app.register(oauthRoutes);
  await app.register(proxyRoutes);
}

async function startAuxiliaryBackgroundServices(): Promise<() => Promise<void>> {
  const [
    { reloadBackupWebdavScheduler },
    { startSiteAnnouncementPolling, stopSiteAnnouncementPolling },
    { startModelAvailabilityProbeScheduler, stopModelAvailabilityProbeScheduler },
    { startChannelRecoveryProbeScheduler, stopChannelRecoveryProbeScheduler },
    { startSub2ApiManagedRefreshScheduler, stopSub2ApiManagedRefreshScheduler },
    { startUpdateCenterPolling, stopUpdateCenterPolling },
    { startUsageAggregationProjectorScheduler, stopUsageAggregationProjectorScheduler },
    { startAdminSnapshotWarmScheduler, stopAdminSnapshotWarmScheduler },
    { startOAuthLoopbackCallbackServers, stopOAuthLoopbackCallbackServers },
    { setLegacyProxyLogRetentionFallbackEnabled, stopProxyLogRetentionService },
    { startProxyFileRetentionService, stopProxyFileRetentionService },
  ] = await Promise.all([
    import('./services/backupService.js'),
    import('./services/siteAnnouncementPollingService.js'),
    import('./services/modelAvailabilityProbeService.js'),
    import('./services/channelRecoveryProbeService.js'),
    import('./services/sub2apiRefreshScheduler.js'),
    import('./services/updateCenterPollingService.js'),
    import('./services/usageAggregationService.js'),
    import('./services/adminSnapshotWarmService.js'),
    import('./services/oauth/localCallbackServer.js'),
    import('./services/proxyLogRetentionService.js'),
    import('./services/proxyFileRetentionService.js'),
  ]);

  await reloadBackupWebdavScheduler();
  startSiteAnnouncementPolling();
  startModelAvailabilityProbeScheduler();
  startChannelRecoveryProbeScheduler();
  startSub2ApiManagedRefreshScheduler();
  startUpdateCenterPolling();
  startUsageAggregationProjectorScheduler();
  startAdminSnapshotWarmScheduler();
  try {
    await startOAuthLoopbackCallbackServers();
  } catch (error) {
    console.warn('Failed to start OAuth callback listeners: ' + ((error as Error)?.message || 'unknown error'));
  }
  setLegacyProxyLogRetentionFallbackEnabled(!config.logCleanupConfigured);
  startProxyFileRetentionService();

  return async () => {
    stopSiteAnnouncementPolling();
    stopUpdateCenterPolling();
    stopProxyFileRetentionService();
    stopProxyLogRetentionService();
    stopModelAvailabilityProbeScheduler();
    stopChannelRecoveryProbeScheduler();
    await stopUsageAggregationProjectorScheduler();
    await stopAdminSnapshotWarmScheduler();
    await stopSub2ApiManagedRefreshScheduler();
    await stopOAuthLoopbackCallbackServers();
  };
}

export async function main(): Promise<void> {
  // Ensure the current runtime database is bootstrapped before reading settings.
  await ensureRuntimeDatabaseReady({
    dialect: runtimeDbDialect,
    connectionString: config.dbUrl,
    ssl: config.dbSsl,
  });

  // Load runtime config overrides from settings
  try {
    const initialRows = await db.select().from(schema.settings).all();
    const initialMap = toSettingsMap(initialRows);
    const savedDbConfig = extractSavedRuntimeDatabaseConfig(initialMap);
    const activeDbUrl = (config.dbUrl || '').trim();
    const originalRuntimeConfig = {
      dialect: runtimeDbDialect,
      dbUrl: activeDbUrl,
      ssl: config.dbSsl,
    };
    if (savedDbConfig && (savedDbConfig.dialect !== runtimeDbDialect || savedDbConfig.dbUrl !== activeDbUrl || savedDbConfig.ssl !== config.dbSsl)) {
      try {
        await switchRuntimeDatabase(savedDbConfig.dialect, savedDbConfig.dbUrl, savedDbConfig.ssl);
        console.log(`Loaded runtime DB config from settings: ${savedDbConfig.dialect}`);
      } catch (error) {
        const currentDbUrl = (config.dbUrl || '').trim();
        const switchedAway = runtimeDbDialect !== originalRuntimeConfig.dialect
          || currentDbUrl !== originalRuntimeConfig.dbUrl
          || config.dbSsl !== originalRuntimeConfig.ssl;
        if (switchedAway) {
          await switchRuntimeDatabase(
            originalRuntimeConfig.dialect,
            originalRuntimeConfig.dbUrl,
            originalRuntimeConfig.ssl,
          );
        }
        console.warn(`Failed to switch runtime DB from settings: ${(error as Error)?.message || 'unknown error'}`);
      }
    }

    await ensureSiteCompatibilityColumns();
    if (!config.checkinAppMode) {
      await ensureRouteGroupingCompatibilityColumns();
    }
    if (!config.checkinAppMode) {
      await ensureProxyFileCompatibilityColumns();
      await ensureProxyLogStreamTimingColumns();
      await ensureProxyLogClientColumns();
      await ensureProxyLogDownstreamApiKeyIdColumn();
    }
    const finalRows = await db.select().from(schema.settings).all();
    const finalMap = toSettingsMap(finalRows);
    applyRuntimeSettings(finalMap);
    config.logCleanupConfigured = hasExplicitLogCleanupSettings(finalMap);
    if (!config.logCleanupConfigured && config.proxyLogRetentionDays > 0) {
      config.logCleanupUsageLogsEnabled = true;
      config.logCleanupProgramLogsEnabled = false;
      config.logCleanupRetentionDays = normalizeLogCleanupRetentionDays(config.proxyLogRetentionDays);
    }
    if (!config.checkinAppMode) {
      await ensureProxyLogBillingDetailsColumn();
      await repairStoredCreatedAtValues();
    }
    await migrateSiteApiKeysToAccounts();
    await ensureDefaultSitesSeeded();
    if (!config.checkinAppMode) {
      const { ensureOauthIdentityBackfill } = await import('./services/oauth/oauthIdentityBackfill.js');
      await ensureOauthIdentityBackfill();
    }
    const resinProxyIdentityBackfillCount = await ensureAccountScopedResinProxyIdentityBackfill();
    if (resinProxyIdentityBackfillCount > 0) {
      console.log(`Backfilled ${resinProxyIdentityBackfillCount} account-scoped Resin proxy identities`);
    }
    await routeRefreshWorkflow.rebuildRoutesOnly();

    console.log('Loaded runtime settings overrides');
  } catch (error) {
    console.warn(`Failed to load runtime settings overrides: ${(error as Error)?.message || 'unknown error'}`);
  }

  if (!config.checkinAppMode) {
    const { ensureOauthProviderSitesExist } = await import('./services/oauth/oauthSiteRegistry.js');
    await ensureOauthProviderSitesExist();
  }

  const app = Fastify(buildFastifyOptions(config));

  await app.register(cors);

  // Auth middleware for /api routes
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') && !isPublicApiRoute(request.url)) {
      await authMiddleware(request, reply);
    }
  });

  // Register API routes
  await app.register(registerDesktopRoutes);
  await app.register(sitesRoutes);
  await app.register(accountsRoutes);
  await app.register(checkinRoutes);
  await app.register(tokensRoutes);
  await app.register(statsRoutes);
  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(accountTokensRoutes);
  if (!config.checkinAppMode) {
    await registerRetiredRoutes(app);
  }

  // Serve static web frontend in production
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
      setHeaders: (res, filePath) => {
        const normalizedPath = normalize(filePath);
        if (normalizedPath.includes(sep + 'assets' + sep)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return;
        }
        if (normalizedPath.endsWith(sep + 'index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
    // SPA fallback
    app.setNotFoundHandler(async (request, reply) => {
      if (!request.url.startsWith('/api/') && !request.url.startsWith('/v1/')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not found' });
    });
  }

  // Start scheduler
  await startScheduler({ checkinOnly: config.checkinAppMode });
  let stopAuxiliaryServices: (() => Promise<void>) | null = null;
  if (config.checkinAppMode) {
    console.log('[Startup] Check-in app mode: auxiliary background services disabled');
  } else {
    stopAuxiliaryServices = await startAuxiliaryBackgroundServices();
  }
  app.addHook('onClose', async () => {
    if (stopAuxiliaryServices) {
      await stopAuxiliaryServices();
    }
  });

  // Start server
  try {
    await app.listen({ port: config.port, host: config.listenHost });
    const summaryLines = buildStartupSummaryLines({
      port: config.port,
      host: config.listenHost,
      authToken: config.authToken,
      proxyToken: config.proxyToken,
    });
    for (const line of summaryLines) {
      console.log(line);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
