import { Effect, Stream } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError, tryPriceSync } from "../errors";
import type { ChainlinkCatalogCache } from "./chainlinkCatalog";
import {
  discoverChainlinkFeedsDetailed,
  fetchChainlinkTokenPrices,
  type ChainlinkChainConfig,
  type ChainlinkFeedConfig,
  type ChainlinkPriceObservation,
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

// How far a discovered feed may sit from every other current price for its
// token before it is taken to be pricing a different asset. Catalog discovery
// matches on symbol alone, and cl1 outranks every source but the quoter, so a
// collision does not merely add a wrong row: it replaces the right price. The
// collisions seen in production are off by 3x to thousands of times (Base's
// OP is One Path, Base's TRUMP is MAGA), while a real feed sits within a few
// percent of the market, or ten to twenty for a bridged or thinly traded
// variant. A withheld feed costs nothing but the Chainlink upgrade: the token
// keeps the price it would have had without Chainlink.
const MAX_REFERENCE_RATIO = 1.25;

/**
 * Whether a Chainlink answer is plausibly the same asset as the token's other
 * current prices. One agreeing source is enough, since a single bad source
 * (a quoter routed through a thin pool, say) must not veto a good feed. A
 * token with no other current price has nothing to disagree with.
 */
export function agreesWithReferencePrices(
  usdPrice: number,
  referencePrices: readonly number[],
): boolean {
  const usable = referencePrices.filter((p) => Number.isFinite(p) && p > 0);
  if (usable.length === 0) return true;
  return usable.some(
    (p) => Math.max(usdPrice / p, p / usdPrice) <= MAX_REFERENCE_RATIO,
  );
}

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

// Most-rejected rule first. The tail is the long list of Chainlink products
// this indexer was never going to price, so the head is the interesting part:
// it is where a feed that should have appeared went.
function formatSkippedFeeds(skipped: ReadonlyMap<string, number>): string {
  return [...skipped]
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => `${count}x ${reason}`)
    .join("; ");
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

type ReferencePriceRow = {
  token_address: string;
  value: number;
};

// Every other source's current price for the given tokens. Expired rows are
// left out: a price that no longer serves is no evidence either way.
function fetchReferencePrices(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
  tokenAddresses: readonly string[],
): Effect.Effect<Map<string, number[]>, PriceSyncError> {
  if (tokenAddresses.length === 0) return Effect.succeed(new Map());
  return tryPriceSync({
    source: SOURCE,
    operation: `read reference prices for chain ${chainId}`,
    try: () => sql<ReferencePriceRow[]>`
      SELECT token_address::TEXT, value
      FROM erc20_tokens_latest_price_by_source
      WHERE chain_id = ${chainId}
        AND token_address IN ${sql(tokenAddresses.map((a) => BigInt(a).toString()))}
        AND source <> ${SOURCE}
        AND valid_until > NOW()
    `,
  }).pipe(
    Effect.map((rows) => {
      const byToken = new Map<string, number[]>();
      for (const row of rows) {
        const key = toEvmAddress(row.token_address);
        byToken.set(key, [...(byToken.get(key) ?? []), row.value]);
      }
      return byToken;
    }),
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
  let lastFeedSummary: string | undefined;
  let lastWithheldSummary = "";

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

      const excluded = new Set(
        (config.excludeTokens ?? []).map((address) => address.toLowerCase()),
      );
      const tokens = (yield* fetchChainlinkTokens(sql, chainId)).filter(
        (token) => !excluded.has(token.address.toLowerCase()),
      );
      const catalog = yield* catalogCache(catalogUrl, catalogRefreshIntervalMs);
      const { feeds, skipped } = discoverChainlinkFeedsDetailed(
        catalog,
        tokens,
      );

      // Reported at info, because a debug line would not be emitted: this
      // worker installs no Logger and never lowers the minimum level, so
      // `logDebug` is dropped and LOG_LEVEL only reaches the Winston logger
      // that the Effect code does not use. Info is therefore the only level
      // that makes this reachable -- and it only stays quiet because a
      // summary is logged when it changes rather than on every plan, which
      // runs once a job interval against a catalog cached for an hour.
      const summary = `${feeds.length} feeds; skipped ${formatSkippedFeeds(skipped)}`;
      if (summary !== lastFeedSummary) {
        lastFeedSummary = summary;
        yield* Effect.logInfo(
          `Chainlink catalog for chain ${chainId} yielded ${summary}`,
        );
      }
      return feeds;
    },
    Effect.catch((error) =>
      Effect.logWarning(
        `Chainlink feed discovery failed for chain ${chainId}; using ${
          configuredFeeds().size
        } configured feeds: ${error.message}`,
      ).pipe(Effect.as([] as ChainlinkFeedConfig[])),
    ),
  );

  // Drops discovered feeds whose answer disagrees with every other current
  // price for their token. Configured feeds are an operator's explicit choice
  // and are kept as they are.
  const withholdCollisions = Effect.fn("chainlink.withholdCollisions")(
    function* (
      observations: Record<string, ChainlinkPriceObservation>,
      discovered: ReadonlySet<string>,
    ) {
      const checked = Object.keys(observations).filter((address) =>
        discovered.has(address.toLowerCase()),
      );
      const references = yield* fetchReferencePrices(sql, chainId, checked);

      const withheld = checked.filter(
        (address) =>
          !agreesWithReferencePrices(
            observations[address].usdPrice,
            references.get(address.toLowerCase()) ?? [],
          ),
      );

      // Logged when the set changes, like the discovery summary: a collision
      // persists from one poll to the next, and saying so every minute would
      // bury the line that matters.
      const summary = withheld
        .map((address) => address.toLowerCase())
        .sort()
        .join(", ");
      if (summary !== lastWithheldSummary) {
        lastWithheldSummary = summary;
        yield* Effect.logInfo(
          `Chainlink on chain ${chainId} withholds ${withheld.length} discovered feeds that disagree with every other price for their token${
            summary ? `: ${summary}` : ""
          }`,
        );
      }

      const kept = { ...observations };
      for (const address of withheld) delete kept[address];
      return kept;
    },
  );

  const plan = Effect.fn("chainlink.plan")(function* () {
    const feedsByToken = configuredFeeds();
    const discovered = new Set<string>();

    for (const feed of yield* discoverFeeds()) {
      const key = feed.tokenAddress.toLowerCase();
      if (!feedsByToken.has(key)) {
        feedsByToken.set(key, feed);
        discovered.add(key);
      }
    }

    const feeds = [...feedsByToken.values()];
    yield* Effect.logInfo(
      `Fetching ${feeds.length} Chainlink prices for chain ID ${chainId}`,
    );
    if (feeds.length === 0) return [];

    const observations = yield* withholdCollisions(
      yield* tryPriceSync({
        source: SOURCE,
        operation: `read feed prices for chain ${chainId}`,
        try: () =>
          fetchChainlinkTokenPrices(chainId.toString(), { ...config, feeds }),
      }),
      discovered,
    );

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
