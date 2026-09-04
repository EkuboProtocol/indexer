import { Config, Effect } from "effect";
import { PriceSyncError } from "./errors";
import {
  parseChainlinkPriceConfig,
  type ChainlinkPriceConfig,
} from "./fetchers/chainlinkFeeds";

export interface PriceSyncConfig {
  readonly pgConnectionString: string;
  readonly defaultIntervalMs: number;
  readonly coingeckoIntervalMs: number;
  readonly chainlinkIntervalMs: number;
  readonly chainlinkConfig: ChainlinkPriceConfig;
  readonly chainlinkCatalogRefreshIntervalMs: number;
  readonly coingeckoApiKey: string | undefined;
  readonly quoterBaseUrl: string;
  // Minimum spacing between quoter request launches.
  readonly quoterMinTimeMs: number;
}

function invalid(name: string, requirement: string) {
  return new PriceSyncError({
    source: "config",
    operation: `read ${name}`,
    cause: new Error(`${name} must be a ${requirement}`),
  });
}

// `Config.int` already rejects anything non-integer, so these only add the
// range each setting needs -- and keep the message an operator would have seen
// from the hand-rolled readers.
function requirePositive(name: string, value: number) {
  return value > 0
    ? Effect.succeed(value)
    : Effect.fail(invalid(name, "positive integer"));
}

function requireNonNegative(name: string, value: number) {
  return value >= 0
    ? Effect.succeed(value)
    : Effect.fail(invalid(name, "non-negative integer"));
}

const raw = Config.all({
  pgConnectionString: Config.string("PG_CONNECTION_STRING"),
  defaultIntervalMs: Config.int("TOKEN_PRICE_SYNC_INTERVAL_MS").pipe(
    Config.withDefault(60_000),
  ),
  coingeckoIntervalSeconds: Config.int(
    "COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS",
  ).pipe(Config.withDefault(0)),
  chainlinkIntervalSeconds: Config.int(
    "CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS",
  ).pipe(Config.withDefault(0)),
  chainlinkCatalogRefreshSeconds: Config.int(
    "CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS",
  ).pipe(Config.withDefault(3_600)),
  chainlinkConfig: Config.string("CHAINLINK_TOKEN_PRICE_CONFIG").pipe(
    Config.withDefault(""),
  ),
  coingeckoApiKey: Config.string("COINGECKO_API_KEY").pipe(
    Config.withDefault(""),
  ),
  quoterUrl: Config.string("EKUBO_QUOTER_URL").pipe(
    Config.withDefault("https://prod-api-quoter.ekubo.org"),
  ),
  maxQuoterRequestsPerMinute: Config.int(
    "MAX_QUOTER_REQUESTS_PER_MINUTE",
  ).pipe(Config.withDefault(60)),
});

/**
 * Every setting the worker reads, in one place.
 *
 * Previously these were parsed at module scope, which meant an invalid value
 * threw during import -- before any logger existed, and from whichever module
 * happened to be loaded first. Reading them here makes a bad setting an
 * ordinary typed failure of the startup effect.
 */
export const loadPriceSyncConfig = Effect.fn("loadPriceSyncConfig")(
  function* () {
    const values = yield* raw;

    const defaultIntervalMs = yield* requirePositive(
      "TOKEN_PRICE_SYNC_INTERVAL_MS",
      values.defaultIntervalMs,
    );
    const coingeckoSeconds = yield* requireNonNegative(
      "COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS",
      values.coingeckoIntervalSeconds,
    );
    const chainlinkSeconds = yield* requireNonNegative(
      "CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS",
      values.chainlinkIntervalSeconds,
    );
    const catalogSeconds = yield* requireNonNegative(
      "CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS",
      values.chainlinkCatalogRefreshSeconds,
    );
    const requestsPerMinute = yield* requirePositive(
      "MAX_QUOTER_REQUESTS_PER_MINUTE",
      values.maxQuoterRequestsPerMinute,
    );

    const chainlinkConfig = yield* Effect.try({
      try: () => parseChainlinkPriceConfig(values.chainlinkConfig),
      catch: (cause) =>
        new PriceSyncError({
          source: "config",
          operation: "read CHAINLINK_TOKEN_PRICE_CONFIG",
          cause,
        }),
    });

    const config: PriceSyncConfig = {
      pgConnectionString: values.pgConnectionString,
      defaultIntervalMs,
      coingeckoIntervalMs: coingeckoSeconds * 1_000,
      chainlinkIntervalMs: chainlinkSeconds * 1_000,
      chainlinkConfig,
      // Follows the sibling *_SECONDS convention where zero disables: here that
      // means never re-fetch a catalog after the first success. Parsing this as
      // a strictly positive value would turn an operator's disable into a crash
      // loop that takes down every price source, not just Chainlink.
      chainlinkCatalogRefreshIntervalMs: catalogSeconds
        ? catalogSeconds * 1_000
        : Number.POSITIVE_INFINITY,
      coingeckoApiKey: values.coingeckoApiKey || undefined,
      quoterBaseUrl: values.quoterUrl.replace(/\/+$/, ""),
      quoterMinTimeMs: Math.ceil(60_000 / requestsPerMinute),
    };

    return config;
  },
);
