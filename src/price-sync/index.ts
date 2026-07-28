import Bottleneck from "bottleneck";
import postgres from "postgres";
import { loadConfig } from "../config";
import type { PriceSyncJob } from "./fetchers/types";
import { createPriceSyncJobs } from "./jobs";
import { persistPriceUpdates } from "./persistPriceUpdates";
import { runPriceSyncJob } from "./runPriceSyncJob";
import { priceSyncJobId, validatePriceSyncJobs } from "./validatePriceSyncJobs";

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
});
validatePriceSyncJobs(PRICE_SYNC_JOBS);

async function main() {
  const runSyncJob = async (job: PriceSyncJob) => {
    const startedAt = Date.now();
    const jobId = priceSyncJobId(job);

    try {
      const result = await runPriceSyncJob(job, (source, updates) =>
        persistPriceUpdates(sql, source, updates),
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

  await Promise.all(
    activeJobs.map((job) => {
      const scheduler = new Bottleneck({
        maxConcurrent: 1,
        minTime: job.intervalMs,
      });
      jobSchedulers.push(scheduler);
      return runSyncLoop(scheduler, job);
    }),
  );
}

main().catch(async (error) => {
  console.error("Token price sync worker failed to start", error);
  try {
    await sql.end({ timeout: 0 });
  } finally {
    process.exit(1);
  }
});
