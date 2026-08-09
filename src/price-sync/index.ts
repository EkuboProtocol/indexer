import Bottleneck from "bottleneck";
import postgres from "postgres";
import { loadConfig } from "../config";
import { parseChainlinkPriceConfig } from "./fetchers/chainlinkFeeds";
import { defaultPriceValidityMs, type PriceSyncJob } from "./fetchers/types";
import { createPriceSyncJobs } from "./jobs";
import { persistPriceUpdates } from "./persistPriceUpdates";
import { runPriceSyncJob } from "./runPriceSyncJob";
import { priceSyncJobId, validatePriceSyncJobs } from "./validatePriceSyncJobs";

// How often the latest-price cache is reconciled against source expirations.
const PRICE_EXPIRATION_POLL_INTERVAL_MS = 1_000;

loadConfig();

function readPositiveInterval(name: string, defaultValue: number): number {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readOptionalIntervalSeconds(name: string): number {
  const value = Number(process.env[name] ?? 0);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

const sql = postgres(process.env.PG_CONNECTION_STRING!, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
  connection: {
    application_name: "price-sync",
  },
});

const chainlinkCatalogRefreshSeconds = Number(
  process.env.CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS ?? 3600,
);
if (
  !Number.isFinite(chainlinkCatalogRefreshSeconds) ||
  !Number.isInteger(chainlinkCatalogRefreshSeconds) ||
  chainlinkCatalogRefreshSeconds < 0
) {
  throw new Error(
    "CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS must be a non-negative integer",
  );
}

// Each entry is an independent recurring job. An interval of zero disables it.
const PRICE_SYNC_JOBS = createPriceSyncJobs({
  sql,
  defaultIntervalMs: readPositiveInterval(
    "TOKEN_PRICE_SYNC_INTERVAL_MS",
    60_000,
  ),
  coingeckoIntervalMs:
    readOptionalIntervalSeconds("COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS") *
    1_000,
  chainlinkIntervalMs:
    readOptionalIntervalSeconds("CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS") *
    1_000,
  chainlinkConfig: parseChainlinkPriceConfig(
    process.env.CHAINLINK_TOKEN_PRICE_CONFIG,
  ),
  // Follows the sibling *_SECONDS convention where zero disables: here that
  // means never re-fetch a catalog after the first success. Parsing this as a
  // strictly positive value would turn an operator's disable into a crash loop
  // that takes down every price source, not just Chainlink.
  chainlinkCatalogRefreshIntervalMs: chainlinkCatalogRefreshSeconds
    ? chainlinkCatalogRefreshSeconds * 1_000
    : Number.POSITIVE_INFINITY,
});
validatePriceSyncJobs(PRICE_SYNC_JOBS);

async function main() {
  const runSyncJob = async (job: PriceSyncJob) => {
    const startedAt = Date.now();
    const jobId = priceSyncJobId(job);

    try {
      const result = await runPriceSyncJob(job, (source, updates) =>
        persistPriceUpdates(
          sql,
          source,
          updates,
          defaultPriceValidityMs(job.intervalMs),
        ),
      );
      console.log(
        `Price sync job ${jobId} completed in ${Math.round(
          Date.now() - startedAt,
        )} ms: ${
          result.insertedCount
        }/${result.updateCount} updates inserted from ${
          result.batchCount
        } batches`,
      );
    } catch (error) {
      console.error(`Price sync job ${jobId} failed`, error);
    }
  };

  let isShuttingDown = false;

  const runSyncLoop = async (scheduler: Bottleneck, job: PriceSyncJob) => {
    while (!isShuttingDown) {
      try {
        await scheduler.schedule(() => runSyncJob(job));
      } catch (error) {
        if (error instanceof Bottleneck.BottleneckError) {
          break;
        }
        console.error(
          `Price sync job ${priceSyncJobId(job)} loop failed`,
          error,
        );
      }
    }
  };

  const jobSchedulers: Bottleneck[] = [];

  // Expiry is time-driven, not write-driven: when the highest-confidence source
  // for a token goes stale, a lower-confidence one has to be promoted even
  // though nothing new arrived.
  const runPriceExpirationLoop = async () => {
    while (!isShuttingDown) {
      try {
        await sql`SELECT refresh_expired_erc20_token_latest_prices()`;
      } catch (error) {
        if (!isShuttingDown) {
          console.error("Failed to expire stale token prices", error);
        }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, PRICE_EXPIRATION_POLL_INTERVAL_MS),
      );
    }
  };

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    try {
      await Promise.all(
        jobSchedulers.map((scheduler) =>
          scheduler.stop({ dropWaitingJobs: true }),
        ),
      );
      await sql.end({ timeout: 0 });
    } catch (error) {
      console.warn("Failed to shut down cleanly", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const activeJobs = PRICE_SYNC_JOBS.filter((job) => {
    if (job.intervalMs === 0) {
      console.log(`Price sync job ${priceSyncJobId(job)} is disabled`);
      return false;
    }

    return true;
  });

  if (activeJobs.length === 0) {
    console.log("No token price sync jobs are enabled");
    await sql.end({ timeout: 0 });
    return;
  }

  await Promise.all([
    ...activeJobs.map((job) => {
      const scheduler = new Bottleneck({
        maxConcurrent: 1,
        minTime: job.intervalMs,
      });
      jobSchedulers.push(scheduler);
      return runSyncLoop(scheduler, job);
    }),
    runPriceExpirationLoop(),
  ]);
}

main().catch(async (error) => {
  console.error("Token price sync worker failed to start", error);
  try {
    await sql.end({ timeout: 0 });
  } finally {
    process.exit(1);
  }
});
