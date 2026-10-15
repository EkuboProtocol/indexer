import { Clock, Duration, Effect, Schedule } from "effect";
import postgres, { type Sql } from "postgres";
import { loadPriceSyncConfig } from "./config";
import { PriceSyncError, tryPriceSync } from "./errors";
import { makeChainlinkCatalogCache } from "./fetchers/chainlinkCatalog";
import {
  checkCoinGeckoCredits,
  COINGECKO_CREDITS_CHECK_INTERVAL_MS,
  CREDITS_MARKER,
} from "./fetchers/coingecko";
import {
  makeCoinGeckoQuotaGate,
  type CoinGeckoQuotaGate,
} from "./fetchers/coingeckoQuota";
import { defaultPriceValidityMs, type PriceSyncJob } from "./fetchers/types";
import { createPriceSyncJobs } from "./jobs";
import { makeLaunchSpacer } from "./launchSpacer";
import { persistPriceUpdates } from "./persistPriceUpdates";
import { runPriceSyncJob } from "./runPriceSyncJob";
import { priceSyncJobId, validatePriceSyncJobs } from "./validatePriceSyncJobs";

const PRICE_EXPIRATION_POLL_INTERVAL_MS = 1_000;

export type PriceSyncSql = Sql<{ bigint: bigint }>;

export function acquireSql(connectionString: string) {
  return Effect.acquireRelease(
    Effect.sync(
      () =>
        postgres(connectionString, {
          connect_timeout: 5,
          types: { bigint: postgres.BigInt },
          connection: {
            application_name: "price-sync",
          },
        }) as PriceSyncSql,
    ),
    (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => sql.end({ timeout: 0 }));
        yield* Effect.logInfo("Closed the price-sync connection pool");
      }),
  );
}

/**
 * One cycle of one job.
 *
 * Failures and defects are logged and absorbed here rather than at the loop,
 * because `Effect.repeat` stops on the first failure: an uncaught error would
 * silently retire that source for the life of the process. Interruption is
 * deliberately not caught, so shutdown still stops the loop.
 */
export function runCycle(sql: PriceSyncSql, job: PriceSyncJob) {
  const jobId = priceSyncJobId(job);

  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;

    const result = yield* runPriceSyncJob(job, (source, updates) =>
      persistPriceUpdates(
        sql,
        source,
        updates,
        defaultPriceValidityMs(job.intervalMs),
      ),
    );

    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
    yield* Effect.logInfo(
      `Price sync job ${jobId} completed in ${Math.round(elapsedMs)} ms: ${
        result.insertedCount
      }/${result.updateCount} updates inserted from ${
        result.batchCount
      } batches`,
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(`Price sync job ${jobId} failed: ${error.message}`),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError(`Price sync job ${jobId} crashed: ${String(defect)}`),
    ),
  );
}

export function lastStoredPriceAt(
  sql: PriceSyncSql,
  job: PriceSyncJob,
): Effect.Effect<Date | undefined, PriceSyncError> {
  return tryPriceSync({
    source: job.source,
    operation: `read the newest ${job.source} price`,
    try: () => sql<{ last: Date | null }[]>`
      SELECT max("timestamp") AS last
      FROM erc20_tokens_latest_price_by_source
      WHERE source = ${job.source}
        AND chain_id = ANY(${job.chainIds.map(String)}::int8[])
    `,
  }).pipe(Effect.map((rows) => rows[0]?.last ?? undefined));
}

export function firstLaunchDelayMs(
  lastRunAtMs: number | undefined,
  nowMs: number,
  intervalMs: number,
): number {
  if (lastRunAtMs === undefined || !Number.isFinite(lastRunAtMs)) return 0;
  return Math.min(intervalMs, Math.max(0, lastRunAtMs + intervalMs - nowMs));
}

export function initialDelayMs(sql: PriceSyncSql, job: PriceSyncJob) {
  const jobId = priceSyncJobId(job);

  return Effect.gen(function* () {
    if (!job.resumeFromLastRun) return 0;

    const last = yield* lastStoredPriceAt(sql, job).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `Price sync job ${jobId}: could not read its last run, launching now: ${error.message}`,
          ),
          null,
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.as(
          Effect.logWarning(
            `Price sync job ${jobId}: could not read its last run, launching now: ${String(defect)}`,
          ),
          null,
        ),
      ),
    );
    if (last === null) return 0;

    const now = yield* Clock.currentTimeMillis;
    const delayMs = firstLaunchDelayMs(last?.getTime(), now, job.intervalMs);

    yield* Effect.logInfo(
      last === undefined
        ? `Price sync job ${jobId}: no stored price, launching now`
        : `Price sync job ${jobId}: last stored price at ${last.toISOString()}, first launch in ${Math.round(delayMs / 1_000)} s`,
    );
    return delayMs;
  });
}

export function jobLoop(sql: PriceSyncSql, job: PriceSyncJob) {
  return Effect.gen(function* () {
    const delayMs = yield* initialDelayMs(sql, job);
    if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs));

    return yield* runCycle(sql, job).pipe(
      Effect.repeat(Schedule.fixed(Duration.millis(job.intervalMs))),
    );
  });
}

export function expirationLoop(sql: PriceSyncSql) {
  return tryPriceSync({
    source: "expiry",
    operation: "refresh expired token prices",
    try: () => sql`SELECT refresh_expired_erc20_token_latest_prices()`,
  }).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logError(`Failed to expire stale token prices: ${error.message}`),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError(`Failed to expire stale token prices: ${String(defect)}`),
    ),
    Effect.repeat(
      Schedule.spaced(Duration.millis(PRICE_EXPIRATION_POLL_INTERVAL_MS)),
    ),
  );
}

export function coingeckoCreditsLoop(
  apiKey: string,
  quotaGate: CoinGeckoQuotaGate,
) {
  return checkCoinGeckoCredits({ apiKey, quotaGate }).pipe(
    Effect.catch((error) =>
      Effect.logError(`${CREDITS_MARKER}_CHECK_FAILED ${error.message}`),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError(`${CREDITS_MARKER}_CHECK_FAILED ${String(defect)}`),
    ),
    Effect.repeat(
      Schedule.spaced(Duration.millis(COINGECKO_CREDITS_CHECK_INTERVAL_MS)),
    ),
  );
}

export const partitionEnabled = Effect.fn("partitionEnabled")(function* (
  jobs: readonly PriceSyncJob[],
) {
  const enabled: PriceSyncJob[] = [];

  for (const job of jobs) {
    if (job.intervalMs === 0) {
      yield* Effect.logInfo(
        `Price sync job ${priceSyncJobId(job)} is disabled`,
      );
    } else {
      enabled.push(job);
    }
  }

  return enabled;
});

export const main = Effect.gen(function* () {
  const config = yield* loadPriceSyncConfig();
  const sql = yield* acquireSql(config.pgConnectionString);
  const quoterSpacer = yield* makeLaunchSpacer(config.quoterMinTimeMs);
  const coingeckoQuotaGate = makeCoinGeckoQuotaGate();

  const jobs = createPriceSyncJobs({
    sql,
    defaultIntervalMs: config.defaultIntervalMs,
    coingeckoIntervalMs: config.coingeckoIntervalMs,
    coingeckoNativeIntervalMs: config.coingeckoNativeIntervalMs,
    chainlinkIntervalMs: config.chainlinkIntervalMs,
    chainlinkConfig: config.chainlinkConfig,
    chainlinkCatalogRefreshIntervalMs: config.chainlinkCatalogRefreshIntervalMs,
    coingeckoApiKey: config.coingeckoApiKey,
    quoterBaseUrl: config.quoterBaseUrl,
    quoterSpacer,
    chainlinkCatalogCache: makeChainlinkCatalogCache(),
    coingeckoQuotaGate,
  });

  yield* Effect.try({
    try: () => validatePriceSyncJobs(jobs),
    catch: (cause) =>
      new PriceSyncError({
        source: "config",
        operation: "validate price sync jobs",
        cause,
      }),
  });

  const enabled = yield* partitionEnabled(jobs);

  if (enabled.length === 0) {
    yield* Effect.logInfo("No token price sync jobs are enabled");
    return;
  }

  const creditsLoop =
    config.coingeckoApiKey !== undefined &&
    (config.coingeckoIntervalMs > 0 || config.coingeckoNativeIntervalMs > 0)
      ? [coingeckoCreditsLoop(config.coingeckoApiKey, coingeckoQuotaGate)]
      : [];

  yield* Effect.forEach(
    [
      ...enabled.map((job) => jobLoop(sql, job)),
      expirationLoop(sql),
      ...creditsLoop,
    ],
    (loop) => loop,
    { concurrency: "unbounded", discard: true },
  );
});
