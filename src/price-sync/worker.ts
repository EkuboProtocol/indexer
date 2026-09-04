import { Clock, Duration, Effect, Schedule } from "effect";
import postgres, { type Sql } from "postgres";
import { loadPriceSyncConfig } from "./config";
import { PriceSyncError, tryPriceSync } from "./errors";
import { makeChainlinkCatalogCache } from "./fetchers/chainlinkCatalog";
import { defaultPriceValidityMs, type PriceSyncJob } from "./fetchers/types";
import { createPriceSyncJobs } from "./jobs";
import { makeLaunchSpacer } from "./launchSpacer";
import { persistPriceUpdates } from "./persistPriceUpdates";
import { runPriceSyncJob } from "./runPriceSyncJob";
import { priceSyncJobId, validatePriceSyncJobs } from "./validatePriceSyncJobs";

// How often the latest-price cache is reconciled against source expirations.
const PRICE_EXPIRATION_POLL_INTERVAL_MS = 1_000;

export type PriceSyncSql = Sql<{ bigint: bigint }>;

/**
 * The connection pool, tied to the program's scope.
 *
 * Every exit path -- a clean "nothing enabled" return, a startup failure, a
 * SIGTERM in the middle of a cycle -- runs this release step, so the pool is
 * closed in one place instead of at each of the three former exits.
 */
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

// `Schedule.fixed` spaces launches, not the gaps between them, which is the
// contract the Bottleneck `minTime` scheduler provided: a cycle that overruns
// its interval starts the next one immediately instead of adding to the delay.
export function jobLoop(sql: PriceSyncSql, job: PriceSyncJob) {
  return runCycle(sql, job).pipe(
    Effect.repeat(Schedule.fixed(Duration.millis(job.intervalMs))),
  );
}

// Expiry is time-driven, not write-driven: when the highest-confidence source
// for a token goes stale, a lower-confidence one has to be promoted even
// though nothing new arrived.
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

export const partitionEnabled = Effect.fn("partitionEnabled")(function* (
  jobs: readonly PriceSyncJob[],
) {
  const enabled: PriceSyncJob[] = [];

  for (const job of jobs) {
    // An interval of zero disables the job.
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

  const jobs = createPriceSyncJobs({
    sql,
    defaultIntervalMs: config.defaultIntervalMs,
    coingeckoIntervalMs: config.coingeckoIntervalMs,
    chainlinkIntervalMs: config.chainlinkIntervalMs,
    chainlinkConfig: config.chainlinkConfig,
    chainlinkCatalogRefreshIntervalMs: config.chainlinkCatalogRefreshIntervalMs,
    coingeckoApiKey: config.coingeckoApiKey,
    quoterBaseUrl: config.quoterBaseUrl,
    quoterSpacer,
    chainlinkCatalogCache: makeChainlinkCatalogCache(),
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

  // Each loop is its own fiber; none of them ever completes on its own. On
  // SIGINT/SIGTERM `runMain` interrupts this effect, which interrupts every
  // loop and then closes the scope -- so the shutdown flag, the signal
  // handlers and the "stop the schedulers" pass all go away.
  yield* Effect.forEach(
    [...enabled.map((job) => jobLoop(sql, job)), expirationLoop(sql)],
    (loop) => loop,
    { concurrency: "unbounded", discard: true },
  );
});
