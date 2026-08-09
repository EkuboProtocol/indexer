import type { Sql } from "postgres";
import {
  discoverChainlinkFeeds,
  fetchChainlinkFeedCatalog,
  fetchChainlinkTokenPrices,
  type ChainlinkChainConfig,
  type ChainlinkToken,
} from "./chainlinkFeeds";
import {
  defaultPriceValidityMs,
  type PriceSyncJob,
  type PriceUpdate,
} from "./types";
import { toHexTokenAddress } from "./utils";

interface ChainlinkPriceFetcherOptions {
  sql: Sql<{ bigint: bigint }>;
  chainId: bigint;
  intervalMs: number;
  config: ChainlinkChainConfig;
  catalogRefreshIntervalMs: number;
}

type ChainlinkTokenRow = {
  token_address: string;
  token_symbol: string;
};

// Feed discovery and the on-chain reads both need full-width EVM addresses,
// unlike the numeric form the database stores prices under.
function toEvmAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16).padStart(40, "0")}`;
}

// Catalogs are shared between chains only by URL, so cache on that. The last
// successful response stays usable during a catalog outage.
const catalogCache = new Map<
  string,
  { catalog: unknown; lastAttemptAt: number }
>();

async function getCatalog(
  catalogUrl: string,
  refreshIntervalMs: number,
): Promise<unknown> {
  const cached = catalogCache.get(catalogUrl);
  if (cached && Date.now() - cached.lastAttemptAt < refreshIntervalMs) {
    return cached.catalog;
  }

  try {
    const catalog = await fetchChainlinkFeedCatalog(catalogUrl);
    catalogCache.set(catalogUrl, { catalog, lastAttemptAt: Date.now() });
    return catalog;
  } catch (error) {
    if (cached) {
      cached.lastAttemptAt = Date.now();
      console.warn(
        `Failed to refresh Chainlink feed catalog ${catalogUrl}; using cached catalog`,
        error,
      );
      return cached.catalog;
    }
    throw error;
  }
}

async function fetchChainlinkTokens(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
): Promise<ChainlinkToken[]> {
  const tokens = await sql<ChainlinkTokenRow[]>`
    SELECT token_address::TEXT, token_symbol
    FROM erc20_tokens
    WHERE chain_id = ${chainId}
      AND visibility_priority >= 0
  `;
  return tokens.map((token) => ({
    address: toEvmAddress(token.token_address),
    symbol: token.token_symbol,
  }));
}

export function chainlinkPriceFetcher({
  sql,
  chainId,
  intervalMs,
  config,
  catalogRefreshIntervalMs,
}: ChainlinkPriceFetcherOptions): PriceSyncJob {
  return {
    chainIds: [chainId],
    source: "cl1",
    intervalMs,
    fetch: async function* () {
      const feedsByToken = new Map(
        config.feeds.map((feed) => [feed.tokenAddress.toLowerCase(), feed]),
      );

      if (config.catalogUrl) {
        const tokens = await fetchChainlinkTokens(sql, chainId);
        const catalog = await getCatalog(
          config.catalogUrl,
          catalogRefreshIntervalMs,
        );
        for (const feed of discoverChainlinkFeeds(catalog, tokens)) {
          const key = feed.tokenAddress.toLowerCase();
          if (!feedsByToken.has(key)) feedsByToken.set(key, feed);
        }
      }

      const feeds = [...feedsByToken.values()];
      console.log(
        `Fetching ${feeds.length} Chainlink prices for chain ID ${chainId}`,
      );
      if (feeds.length === 0) return;

      const observations = await fetchChainlinkTokenPrices(chainId.toString(), {
        ...config,
        feeds,
      });

      // Each observation carries the round's own updatedAt, so an unchanged
      // round produces a row that already exists and is discarded on insert.
      // Validity is anchored at that updatedAt and extends through the feed's
      // staleness window — mirroring the read-side contract — floored at the
      // job's default so a fast-heartbeat feed cannot expire between syncs.
      const updates: PriceUpdate[] = Object.entries(observations).map(
        ([tokenAddress, { usdPrice, timestamp }]) => {
          const feed = feedsByToken.get(tokenAddress.toLowerCase());
          const validityMs = Math.max(
            (feed?.maxAgeSeconds ?? 0) * 1_000,
            defaultPriceValidityMs(intervalMs),
          );
          return {
            chainId,
            tokenAddress: toHexTokenAddress(tokenAddress),
            timestamp,
            usdPrice,
            validUntil: new Date(timestamp.getTime() + validityMs),
          };
        },
      );

      if (updates.length > 0) yield updates;
    },
  };
}
