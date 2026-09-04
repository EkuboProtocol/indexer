import type { Sql } from "postgres";
import { chainlinkPriceFetcher } from "./fetchers/chainlink";
import {
  makeChainlinkCatalogCache,
  type ChainlinkCatalogCache,
} from "./fetchers/chainlinkCatalog";
import type { ChainlinkPriceConfig } from "./fetchers/chainlinkFeeds";
import {
  coingeckoNativePriceFetcher,
  coingeckoPriceFetcher,
} from "./fetchers/coingecko";
import { quoterPriceFetcher } from "./fetchers/ekuboQuoter";
// import { oracleV1PriceFetcher } from "./fetchers/oracleV1";
import { sushiswapPriceFetcher } from "./fetchers/sushiswap";
import type { PriceSyncJob } from "./fetchers/types";
import type { LaunchSpacer } from "./launchSpacer";

interface CreatePriceSyncJobsOptions {
  sql: Sql<{ bigint: bigint }>;
  defaultIntervalMs: number;
  coingeckoIntervalMs: number;
  chainlinkIntervalMs?: number;
  chainlinkConfig?: ChainlinkPriceConfig;
  chainlinkCatalogRefreshIntervalMs?: number;
  coingeckoApiKey?: string | undefined;
  quoterBaseUrl?: string;
  // Shared across every quoter job so the request budget is the worker's.
  quoterSpacer?: LaunchSpacer;
  // Shared across every Chainlink job so one catalog URL is fetched once.
  chainlinkCatalogCache?: ChainlinkCatalogCache;
}

const passThrough: LaunchSpacer = (effect) => effect;

export function createPriceSyncJobs({
  sql,
  defaultIntervalMs,
  coingeckoIntervalMs,
  chainlinkIntervalMs = 0,
  chainlinkConfig = {},
  chainlinkCatalogRefreshIntervalMs = 3_600_000,
  coingeckoApiKey,
  quoterBaseUrl = "https://prod-api-quoter.ekubo.org",
  quoterSpacer = passThrough,
  chainlinkCatalogCache = makeChainlinkCatalogCache(),
}: CreatePriceSyncJobsOptions): PriceSyncJob[] {
  // The dependencies every job of a kind shares, bound once so the list below
  // stays a table of what is priced where rather than of how it is wired.
  const quoter = (
    options: Omit<
      Parameters<typeof quoterPriceFetcher>[0],
      "sql" | "spacer" | "baseUrl"
    >,
  ) =>
    quoterPriceFetcher({
      ...options,
      sql,
      spacer: quoterSpacer,
      baseUrl: quoterBaseUrl,
    });

  const coingecko = (
    options: Omit<Parameters<typeof coingeckoPriceFetcher>[0], "sql" | "apiKey">,
  ) => coingeckoPriceFetcher({ ...options, sql, apiKey: coingeckoApiKey });

  return [
    // One job per chain configured with Chainlink feeds. Absent configuration
    // yields no jobs at all, so Chainlink stays inert until it is set up.
    ...Object.entries(chainlinkConfig).map(([chainId, config]) =>
      chainlinkPriceFetcher({
        sql,
        chainId: BigInt(chainId),
        intervalMs: chainlinkIntervalMs,
        config,
        catalogRefreshIntervalMs: chainlinkCatalogRefreshIntervalMs,
        catalogCache: chainlinkCatalogCache,
      }),
    ),

    // Every chain whose native currency CoinGecko prices, in one request. Chains
    // sharing a coin ID cost nothing extra, so add them here rather than giving
    // each chain its own CoinGecko job.
    coingeckoNativePriceFetcher({
      intervalMs: coingeckoIntervalMs,
      apiKey: coingeckoApiKey,
      chainIdsByCoinId: {
        ethereum: [
          1n, // eth mainnet
          10n, // optimism
          130n, // unichain
          480n, // world chain
          4326n, // megaeth
          4663n, // robinhood
          8453n, // base
          42161n, // arbitrum one
          57073n, // ink
        ],
        binancecoin: [56n], // bsc
        xdai: [100n], // gnosis
        "polygon-ecosystem-token": [137n], // polygon
        monad: [143n], // monad
      },
    }),

    // eth mainnet
    sushiswapPriceFetcher({
      chainId: 1n,
      intervalMs: defaultIntervalMs,
    }),
    quoter({
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
    // base
    quoter({
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
    coingecko({
      chainId: 8453n,
      intervalMs: coingeckoIntervalMs,
      platform: "base",
    }),

    // monad
    quoter({
      chainId: 143n,
      intervalMs: defaultIntervalMs,
      address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    sushiswapPriceFetcher({
      chainId: 143n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 143n,
      intervalMs: coingeckoIntervalMs,
      platform: "monad",
    }),

    // robinhood
    quoter({
      chainId: 4663n,
      intervalMs: defaultIntervalMs,
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      decimals: 6,
      quoteAmount: 1000n,
      // Pools here carry fees as high as 22%, and the quoter counts the fee
      // toward price_impact, so the default 0.2 cap rejects otherwise good
      // quotes -- STONX among them.
      maxImpact: 0.5,
    }),
    sushiswapPriceFetcher({
      chainId: 4663n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 4663n,
      intervalMs: coingeckoIntervalMs,
      platform: "robinhood",
    }),

    // arbitrum one
    sushiswapPriceFetcher({
      chainId: 42161n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 42161n,
      intervalMs: coingeckoIntervalMs,
      platform: "arbitrum-one",
    }),

    // optimism
    quoter({
      chainId: 10n,
      intervalMs: defaultIntervalMs,
      address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    sushiswapPriceFetcher({
      chainId: 10n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 10n,
      intervalMs: coingeckoIntervalMs,
      platform: "optimistic-ethereum",
    }),

    // bsc
    quoter({
      chainId: 56n,
      intervalMs: defaultIntervalMs,
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      decimals: 18,
      quoteAmount: 1000n,
    }),
    sushiswapPriceFetcher({
      chainId: 56n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 56n,
      intervalMs: coingeckoIntervalMs,
      platform: "binance-smart-chain",
    }),

    // gnosis
    quoter({
      chainId: 100n,
      intervalMs: defaultIntervalMs,
      address: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    sushiswapPriceFetcher({
      chainId: 100n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 100n,
      intervalMs: coingeckoIntervalMs,
      platform: "xdai",
    }),

    // unichain
    quoter({
      chainId: 130n,
      intervalMs: defaultIntervalMs,
      address: "0x078d782b760474a361dda0af3839290b0ef57ad6",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    coingecko({
      chainId: 130n,
      intervalMs: coingeckoIntervalMs,
      platform: "unichain",
    }),

    // polygon
    quoter({
      chainId: 137n,
      intervalMs: defaultIntervalMs,
      address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    sushiswapPriceFetcher({
      chainId: 137n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 137n,
      intervalMs: coingeckoIntervalMs,
      platform: "polygon-pos",
    }),

    // world chain
    quoter({
      chainId: 480n,
      intervalMs: defaultIntervalMs,
      address: "0x79a02482a880bce3f13e09da970dc34db4cd24d1",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    coingecko({
      chainId: 480n,
      intervalMs: coingeckoIntervalMs,
      platform: "world-chain",
    }),

    // megaeth -- no USD stablecoin is listed on this chain yet, so there is
    // no proxy token to quote against; CoinGecko and Sushi cover it instead.
    sushiswapPriceFetcher({
      chainId: 4326n,
      intervalMs: defaultIntervalMs,
    }),
    coingecko({
      chainId: 4326n,
      intervalMs: coingeckoIntervalMs,
      platform: "megaeth",
    }),

    // ink
    quoter({
      chainId: 57073n,
      intervalMs: defaultIntervalMs,
      address: "0x2d270e6886d130d724215a266106e6832161eaed",
      decimals: 6,
      quoteAmount: 1000n,
    }),
    coingecko({
      chainId: 57073n,
      intervalMs: coingeckoIntervalMs,
      platform: "ink",
    }),

    // starknet mainnet
    quoter({
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
