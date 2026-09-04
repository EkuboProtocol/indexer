import { Effect, Stream } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError, tryPriceSync } from "../errors";
import type { ChainlinkCatalogCache } from "./chainlinkCatalog";
import {
  discoverChainlinkFeeds,
  fetchChainlinkTokenPrices,
  type ChainlinkChainConfig,
  type ChainlinkFeedConfig,
  type ChainlinkToken,
} from "./chainlinkFeeds";
import {
  defaultPriceValidityMs,
  type PriceSyncJob,
  type PriceUpdate,
} from "./types";
import { toHexTokenAddress } from "./utils";

const SOURCE = "cl1";

interface ChainlinkPriceFetcherOptions {
  sql: Sql<{ bigint: bigint }>;
  chainId: bigint;
  intervalMs: number;
  config: ChainlinkChainConfig;
  catalogRefreshIntervalMs: number;
  catalogCache: ChainlinkCatalogCache;
}

type ChainlinkTokenRow = {
  token_address: string;
  token_symbol: string;
};

// An upper bound on how long any single observation may be considered fresh.
const MAX_PRICE_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ChainlinkRoundTracker {
  (chainId: bigint, tokenAddress: string, roundUpdatedAt: Date): boolean;
}

/**
 * Reports a feed's round at most once.
 *
 * A feed keeps returning its last round until it next publishes, so polling
 * faster than the heartbeat re-reads one observation many times over. Emitting
 * those repeats would write a row per poll that says nothing new, so this
 * tracks the round already reported per feed and admits only genuine updates.
 * Held in memory: after a restart the first poll re-reports one round per feed,
 * which the latest-price cache absorbs.
 */
export function makeChainlinkRoundTracker(): ChainlinkRoundTracker {
  const lastReportedRoundAt = new Map<string, number>();

  return (chainId, tokenAddress, roundUpdatedAt) => {
    const key = `${chainId}:${tokenAddress.toLowerCase()}`;
    const updatedAtMs = roundUpdatedAt.getTime();
    if (lastReportedRoundAt.get(key) === updatedAtMs) return false;
    lastReportedRoundAt.set(key, updatedAtMs);
    return true;
  };
}

// Feed discovery and the on-chain reads both need full-width EVM addresses,
// unlike the numeric form the database stores prices under.
function toEvmAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16).padStart(40, "0")}`;
}

function fetchChainlinkTokens(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
): Effect.Effect<ChainlinkToken[], PriceSyncError> {
  return tryPriceSync({
    source: SOURCE,
    operation: `read indexed tokens for chain ${chainId}`,
    try: () => sql<ChainlinkTokenRow[]>`
      SELECT token_address::TEXT, token_symbol
      FROM erc20_tokens
      WHERE chain_id = ${chainId}
        AND visibility_priority >= 0
    `,
  }).pipe(
    Effect.map((tokens) =>
      tokens.map((token) => ({
        address: toEvmAddress(token.token_address),
        symbol: token.token_symbol,
      })),
    ),
  );
}

export function chainlinkPriceFetcher({
  sql,
  chainId,
  intervalMs,
  config,
  catalogRefreshIntervalMs,
  catalogCache,
}: ChainlinkPriceFetcherOptions): PriceSyncJob {
  const shouldReportRound = makeChainlinkRoundTracker();

  // Validity is anchored at the round's own updatedAt and extends through the
  // feed's staleness window -- mirroring the read-side contract -- floored at
  // the job's default so a fast-heartbeat feed cannot expire between syncs.
  const toUpdate = (
    tokenAddress: string,
    usdPrice: number,
    timestamp: Date,
    feed: ChainlinkFeedConfig | undefined,
  ): PriceUpdate => {
    // Clamped because maxAgeSeconds also arrives from operator config, where
    // an implausible value would otherwise overflow the Date range and cost
    // the whole batch instead of this one feed.
    const validityMs = Math.min(
      Math.max(
        (feed?.maxAgeSeconds ?? 0) * 1_000,
        defaultPriceValidityMs(intervalMs),
      ),
      MAX_PRICE_VALIDITY_MS,
    );

    return {
      chainId,
      tokenAddress: toHexTokenAddress(tokenAddress),
      timestamp,
      usdPrice,
      validUntil: new Date(timestamp.getTime() + validityMs),
    };
  };

  const configuredFeeds = () =>
    new Map(config.feeds.map((feed) => [feed.tokenAddress.toLowerCase(), feed]));

  // Discovery is best-effort: explicitly configured feeds must keep reporting
  // through a catalog outage rather than depending on it.
  const discoverFeeds = Effect.fn("chainlink.discoverFeeds")(
    function* () {
      const catalogUrl = config.catalogUrl;
      if (!catalogUrl) return [];

      const tokens = yield* fetchChainlinkTokens(sql, chainId);
      const catalog = yield* catalogCache(catalogUrl, catalogRefreshIntervalMs);
      return discoverChainlinkFeeds(catalog, tokens);
    },
    Effect.catch((error) =>
      Effect.logWarning(
        `Chainlink feed discovery failed for chain ${chainId}; using ${
          configuredFeeds().size
        } configured feeds: ${error.message}`,
      ).pipe(Effect.as([] as ChainlinkFeedConfig[])),
    ),
  );

  const plan = Effect.fn("chainlink.plan")(function* () {
    const feedsByToken = configuredFeeds();

    for (const feed of yield* discoverFeeds()) {
      const key = feed.tokenAddress.toLowerCase();
      if (!feedsByToken.has(key)) feedsByToken.set(key, feed);
    }

    const feeds = [...feedsByToken.values()];
    yield* Effect.logInfo(
      `Fetching ${feeds.length} Chainlink prices for chain ID ${chainId}`,
    );
    if (feeds.length === 0) return [];

    const observations = yield* tryPriceSync({
      source: SOURCE,
      operation: `read feed prices for chain ${chainId}`,
      try: () =>
        fetchChainlinkTokenPrices(chainId.toString(), { ...config, feeds }),
    });

    return Object.entries(observations)
      .filter(([tokenAddress, { timestamp }]) =>
        shouldReportRound(chainId, tokenAddress, timestamp),
      )
      .map(([tokenAddress, { usdPrice, timestamp }]) =>
        toUpdate(
          tokenAddress,
          usdPrice,
          timestamp,
          feedsByToken.get(tokenAddress.toLowerCase()),
        ),
      );
  });

  return {
    chainIds: [chainId],
    source: SOURCE,
    intervalMs,
    fetch: Stream.fromEffect(plan()).pipe(
      Stream.filter((updates) => updates.length > 0),
    ),
  };
}
