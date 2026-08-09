import type { Sql } from "postgres";
import {
  coingeckoNativePriceFetcher,
  coingeckoPriceFetcher,
} from "./fetchers/coingecko";
import { quoterPriceFetcher } from "./fetchers/ekuboQuoter";
// import { oracleV1PriceFetcher } from "./fetchers/oracleV1";
import { sushiswapPriceFetcher } from "./fetchers/sushiswap";
import type { PriceSyncJob } from "./fetchers/types";

interface CreatePriceSyncJobsOptions {
  sql: Sql<{ bigint: bigint }>;
  defaultIntervalMs: number;
  coingeckoIntervalMs: number;
}

export function createPriceSyncJobs({
  sql,
  defaultIntervalMs,
  coingeckoIntervalMs,
}: CreatePriceSyncJobsOptions): PriceSyncJob[] {
  return [
    // Every chain whose native currency CoinGecko prices, in one request. Chains
    // sharing a coin ID cost nothing extra, so add them here rather than giving
    // each chain its own CoinGecko job.
    coingeckoNativePriceFetcher({
      intervalMs: coingeckoIntervalMs,
      chainIdsByCoinId: {
        ethereum: [
          1n, // eth mainnet
          8453n, // base
          4663n, // robinhood
          42161n, // arbitrum one
        ],
      },
    }),

    // eth mainnet
    sushiswapPriceFetcher({
      chainId: 1n,
      intervalMs: defaultIntervalMs,
    }),
    quoterPriceFetcher({
      sql,
      chainId: 1n,
      intervalMs: defaultIntervalMs,
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    /*
    oracleV1PriceFetcher({
      sql,
      chainId: 1n,
      intervalMs: defaultIntervalMs,
      usdProxyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      oracleExtension: "0x51d02A5948496a67827242EaBc5725531342527C",
      oracleToken: "0x0",
      twapDurationSeconds: 60,
    }),
    */
    // eth sepolia
    sushiswapPriceFetcher({
      chainId: 11155111n,
      intervalMs: defaultIntervalMs,
    }),

    // base
    quoterPriceFetcher({
      sql,
      chainId: 8453n,
      intervalMs: defaultIntervalMs,
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    sushiswapPriceFetcher({
      chainId: 8453n,
      intervalMs: defaultIntervalMs,
    }),
    coingeckoPriceFetcher({
      sql,
      chainId: 8453n,
      intervalMs: coingeckoIntervalMs,
      platform: "base",
    }),

    // monad
    quoterPriceFetcher({
      sql,
      chainId: 143n,
      intervalMs: defaultIntervalMs,
      address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
      decimals: 6,
      quoteAmount: 1000n,
    }),

    // robinhood
    quoterPriceFetcher({
      sql,
      chainId: 4663n,
      intervalMs: defaultIntervalMs,
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    sushiswapPriceFetcher({
      chainId: 4663n,
      intervalMs: defaultIntervalMs,
    }),
    coingeckoPriceFetcher({
      sql,
      chainId: 4663n,
      intervalMs: coingeckoIntervalMs,
      platform: "robinhood",
    }),

    // fake robinhood chain
    quoterPriceFetcher({
      sql,
      chainId: 46630n,
      intervalMs: defaultIntervalMs,
      address: "0x9367e29667db75Cb91788330a8509b3B4ac66c8f",
      decimals: 6,
      quoteAmount: 10n,
    }),

    // arbitrum one
    sushiswapPriceFetcher({
      chainId: 42161n,
      intervalMs: defaultIntervalMs,
    }),
    coingeckoPriceFetcher({
      sql,
      chainId: 42161n,
      intervalMs: coingeckoIntervalMs,
      platform: "arbitrum-one",
    }),

    // arbitrum sepolia
    quoterPriceFetcher({
      sql,
      chainId: 421614n,
      intervalMs: defaultIntervalMs,
      address: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
      decimals: 6,
      quoteAmount: 1000n,
    }),

    // starknet mainnet
    quoterPriceFetcher({
      sql,
      chainId: 23448594291968334n,
      intervalMs: defaultIntervalMs,
      address:
        "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    /*
    oracleV1PriceFetcher({
      sql,
      chainId: 23448594291968334n,
      intervalMs: defaultIntervalMs,
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
}
