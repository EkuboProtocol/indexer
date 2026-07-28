import Bottleneck from "bottleneck";
import postgres, { type Sql } from "postgres";
import { loadConfig } from "../src/config";
import { coingeckoPriceFetcher } from "./fetchers/coingecko";
import { quoterPriceFetcher } from "./fetchers/ekuboQuoter";
// import { oracleV1PriceFetcher } from "./fetchers/oracleV1";
import { sushiswapPriceFetcher } from "./fetchers/sushiswap";
import type { PriceSyncJob } from "./fetchers/types";

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

const DEFAULT_PRICE_FETCH_INTERVAL_MS = readPositiveInterval(
  "TOKEN_PRICE_SYNC_INTERVAL_MS",
  60_000,
);
const COINGECKO_PRICE_FETCH_INTERVAL_MS =
  readOptionalIntervalSeconds("COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS") *
  1_000;

const sql = postgres(process.env.PG_CONNECTION_STRING!, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
  connection: {
    application_name: "sync-token-prices.ts",
  },
});

// Each entry is an independent recurring job. An interval of zero disables it.
const PRICE_SYNC_JOBS: PriceSyncJob[] = [
  // eth mainnet
  sushiswapPriceFetcher({
    chainId: 1n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
  }),
  quoterPriceFetcher({
    chainId: 1n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    quoteAmount: 1000n,
  }),
  /*
  oracleV1PriceFetcher({
    chainId: 1n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    usdProxyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    oracleExtension: "0x51d02A5948496a67827242EaBc5725531342527C",
    oracleToken: "0x0",
    twapDurationSeconds: 60,
  }),
  */
  coingeckoPriceFetcher({
    chainId: 1n,
    intervalMs: COINGECKO_PRICE_FETCH_INTERVAL_MS,
    nativeCoinId: "ethereum",
  }),

  // eth sepolia
  sushiswapPriceFetcher({
    chainId: 11155111n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
  }),

  // base
  quoterPriceFetcher({
    chainId: 8453n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    quoteAmount: 1000n,
  }),
  sushiswapPriceFetcher({
    chainId: 8453n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
  }),
  coingeckoPriceFetcher({
    chainId: 8453n,
    intervalMs: COINGECKO_PRICE_FETCH_INTERVAL_MS,
    platform: "base",
    nativeCoinId: "ethereum",
  }),

  // monad
  quoterPriceFetcher({
    chainId: 143n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    decimals: 6,
    quoteAmount: 1000n,
  }),

  // robinhood
  quoterPriceFetcher({
    chainId: 4663n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 6,
    quoteAmount: 1000n,
  }),
  sushiswapPriceFetcher({
    chainId: 4663n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
  }),
  coingeckoPriceFetcher({
    chainId: 4663n,
    intervalMs: COINGECKO_PRICE_FETCH_INTERVAL_MS,
    platform: "robinhood",
    nativeCoinId: "ethereum",
  }),

  // fake robinhood chain
  quoterPriceFetcher({
    chainId: 46630n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    address: "0xC93C4Ad185CA48d66FEfe80f906a67ef859fc47d",
    decimals: 6,
    quoteAmount: 10n,
  }),

  // arbitrum one
  sushiswapPriceFetcher({
    chainId: 42161n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
  }),
  coingeckoPriceFetcher({
    chainId: 42161n,
    intervalMs: COINGECKO_PRICE_FETCH_INTERVAL_MS,
    platform: "arbitrum-one",
    nativeCoinId: "ethereum",
  }),

  // arbitrum sepolia
  quoterPriceFetcher({
    chainId: 421614n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    address: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    decimals: 6,
    quoteAmount: 1000n,
  }),

  // starknet mainnet
  quoterPriceFetcher({
    chainId: 23448594291968334n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    address:
      "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    decimals: 6,
    quoteAmount: 1000n,
  }),
  /*
  oracleV1PriceFetcher({
    chainId: 23448594291968334n,
    intervalMs: DEFAULT_PRICE_FETCH_INTERVAL_MS,
    usdProxyToken:
      "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
    oracleExtension:
      "0x005e470ff654d834983a46b8f29dfa99963d5044b993cb7b9c92243a69dab38f",
    oracleToken:
      "0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87",
    twapDurationSeconds: 60,
  }),
  */
];

async function syncTokenPrices(
  sql: Sql<{ bigint: bigint }>,
  job: PriceSyncJob,
) {
  const chainId = job.chainId.toString();
  const prices = await job.fetch(sql);
  const priceRows: [
    chain_id: string,
    token_address: `0x${string}`,
    source: string,
    usd_price: number,
  ][] = [];

  for (const [tokenAddress, usdPrice] of Object.entries(prices)) {
    priceRows.push([
      chainId,
      `0x${BigInt(tokenAddress).toString(16)}`,
      job.source,
      usdPrice,
    ]);
  }

  if (priceRows.length === 0) {
    console.log(
      `No ${job.source} token prices to insert for chain ID ${chainId}`,
    );
    return;
  }

  let total = 0;
  await sql.begin(async (sql) => {
    for (let i = 0; i < priceRows.length; i += 1000) {
      const { count } = await sql`
        INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, value)
        SELECT data.chain_id::int8,
               data.token_address::numeric,
               data.source,
               data.usd_price::double precision
        FROM (values ${sql(
          priceRows.slice(i, i + 1000),
        )}) as data (chain_id, token_address, source, usd_price)
        JOIN erc20_tokens AS t
          ON t.chain_id = data.chain_id::int8
         AND t.token_address = data.token_address::numeric;
      `;
      total += count;
    }
  });

  console.log(
    `Inserted ${total} ${job.source} token price rows for chain ID ${chainId}`,
  );
}

async function main() {
  const runSyncJob = async (job: PriceSyncJob) => {
    const startedAt = Date.now();

    try {
      await syncTokenPrices(sql, job);
      console.log(
        `${job.source} token price sync completed for chain ID ${
          job.chainId
        } in ${Math.round(Date.now() - startedAt)} ms`,
      );
    } catch (error) {
      console.error(
        `${job.source} token price sync failed for chain ID ${job.chainId}`,
        error,
      );
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
          `${job.source} token price sync loop failed for chain ID ${job.chainId}`,
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
    if (
      !Number.isFinite(job.intervalMs) ||
      !Number.isInteger(job.intervalMs) ||
      job.intervalMs < 0
    ) {
      throw new Error(
        `${job.source} interval for chain ID ${job.chainId} must be a non-negative integer`,
      );
    }

    if (job.intervalMs === 0) {
      console.log(
        `${job.source} token price syncing is disabled for chain ID ${job.chainId}`,
      );
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
